// POST /api/generate-exam
// Body: { profileId, subjectLabel, topics: string[], difficulty, count, gradeLabel }
// Returns: { examSessionId, questions: [{ id, text, type, options?, topic }] }
// NO correct_index / correct_answer is ever sent to the browser.

const { callGemini } = require('../gemini');
const { callAndValidate } = require('../validateAI');
const { admin } = require('../supabaseAdmin');
const { checkRateLimit } = require('../rateLimit');
const { requireUser } = require('../verifyAuth');
const { MAX_TOPIC_LEN, MAX_TOPICS_COUNT, MAX_GRADE_LABEL_LEN, MAX_SUBJECT_LABEL_LEN, MAX_DIFFICULTY_LEN } = require('../limits');
const { withMetrics } = require('../withMetrics');
const { SMART_MODEL } = require('../models');
const logger = require('../logger');
const { sanitizeForAI, safeAIMessage } = require('../guardrails');
const { retrieveCurriculumContext, formatRAGContext } = require('../rag');
const { normalizeTopic } = require('../util');
const { getRateLimitKey } = require('../rateIdentity');

const SYSTEM_PROMPT = `أنت مولّد أسئلة اختبار لمنصة فكّكها AI.
اعمل مجموعة أسئلة على المواضيع المطلوبة، بنوعين مختلطين:
- "mcq": اختيار من متعدد، 4 اختيارات، إجابة صحيحة واحدة، والاختيارات التلاتة التانية معقولة مش سخيفة.
- "short_answer": سؤال إجابته القصيرة نص أو رقم (مش اختيار من متعدد)، وحط الإجابة النموذجية الصحيحة.

خلي حوالي تلت الأسئلة من نوع short_answer والباقي mcq، إلا لو عدد الأسئلة قليل جدًا فخليهم كلهم mcq.
نوّع صعوبة الأسئلة حوالي المستوى المطلوب.

أرجع JSON فقط بالشكل ده بالظبط:
{
  "questions": [
    { "type": "mcq", "text": "نص السؤال", "options": ["أ","ب","ج","د"], "correctIndex": 0, "topic": "اسم الموضوع" },
    { "type": "short_answer", "text": "نص السؤال", "correctAnswer": "الإجابة النموذجية", "topic": "اسم الموضوع" }
  ]
}
لازم عدد الأسئلة يساوي بالظبط العدد المطلوب. أسئلة mcq لازم options فيها 4 عناصر بالظبط وcorrectIndex من 0 لـ 3. أسئلة short_answer لازم correctAnswer نص مش فاضي، ومن غير options أو correctIndex خالص.`;

function isValidShape(obj, expectedCount) {
  if (!obj || !Array.isArray(obj.questions)) return false;
  if (obj.questions.length !== expectedCount) return false;
  return obj.questions.every(q => {
    if (typeof q.text !== 'string' || q.text.trim().length < 3 || q.text.length > 1000) return false;
    if (typeof q.topic !== 'string' || q.topic.trim().length < 1 || q.topic.length > 200) return false;
    if (q.type === 'mcq') {
      return Array.isArray(q.options) && q.options.length === 4 &&
        q.options.every(option => typeof option === 'string' && option.trim().length > 0 && option.length <= 500) &&
        Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3;
    }
    if (q.type === 'short_answer') {
      return typeof q.correctAnswer === 'string' && q.correctAnswer.trim().length > 0 && q.correctAnswer.length <= 500;
    }
    return false;
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { profileId, subjectLabel, topics, unit, difficulty, count, gradeLabel, strictUnit = true } = req.body || {};
  const requestedTopics = Array.isArray(topics) && topics.length ? topics : (typeof unit === 'string' && unit.trim() ? [unit.trim()] : []);
  const n = Math.min(Math.max(parseInt(count) || 5, 3), 15); // clamp 3..15
  if (!profileId || typeof subjectLabel !== 'string' || !subjectLabel.trim() || !requestedTopics.length) {
    return res.status(400).json({ error: 'missing_fields', message: 'profileId, subjectLabel, unit/topics مطلوبين' });
  }
  if (subjectLabel.length > MAX_SUBJECT_LABEL_LEN || requestedTopics.length > MAX_TOPICS_COUNT || requestedTopics.some(t => typeof t !== 'string' || t.length > MAX_TOPIC_LEN)) {
    return res.status(400).json({ error: 'topics_invalid', message: `أقصى حد ${MAX_TOPICS_COUNT} مواضيع، كل واحد أقل من ${MAX_TOPIC_LEN} حرف.` });
  }
  const safeGradeLabel = typeof gradeLabel === 'string' ? gradeLabel.slice(0, MAX_GRADE_LABEL_LEN) : '';
  const safeDifficulty = typeof difficulty === 'string' && difficulty.length <= MAX_DIFFICULTY_LEN ? difficulty : 'medium';
  const safeSubject = sanitizeForAI(subjectLabel);
  const safeTopics = requestedTopics.map(t => sanitizeForAI(t));
  if (safeSubject.injectionDetected || safeTopics.some(x => x.injectionDetected)) return res.status(400).json({ error: 'unsafe_prompt', message: 'بيانات الاختبار فيها تعليمات غير آمنة.' });

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated', message: 'محتاج تسجّل دخول (حتى لو مجهول) الأول.' }); }

  const db = admin();

  // Ownership check — the service-role client bypasses RLS, so we must
  // verify by hand that this profile actually belongs to the caller before
  // spending Gemini calls and writing exam data against it.
  const { data: profile } = await db.from('profiles').select('id, user_id').eq('id', profileId).maybeSingle();
  if (!profile || profile.user_id !== userId) {
    return res.status(403).json({ error: 'forbidden', message: 'البروفايل ده مش بتاعك.' });
  }

  const limitKey = getRateLimitKey(req, 'generate-exam', userId);
  const limit = await checkRateLimit(limitKey, 8, 3600); // 8 exams / hour — each one is several questions
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: `اخترت اختبارات كتير أوي دلوقتي. استنى شوية وحاول تاني.` });
  }

  const ragRows = (await Promise.all(requestedTopics.slice(0, MAX_TOPICS_COUNT).map(topic => retrieveCurriculumContext({ question: topic, subjectLabel: safeSubject.text, topic, gradeLabel: safeGradeLabel, limit: 2 })))).flat().slice(0, 8);
  const ragContext = formatRAGContext(ragRows);

  const userPrompt = `المادة: ${safeSubject.text}
الموضوعات: ${safeTopics.map(x => x.text).join('، ')}
مستوى الطالب: ${safeGradeLabel || 'غير محدد'}
الصعوبة المطلوبة: ${safeDifficulty}
عدد الأسئلة المطلوب بالظبط: ${n}

محتوى المنهج المسترجع (RAG):
${ragContext}
استخدم هذا المحتوى لتثبيت المصطلحات والمفاهيم، ولا تدّعي مطابقة منهج كامل إذا لم يوجد مصدر مسترجع.`;

  const result = await callAndValidate(
    () => callGemini(SYSTEM_PROMPT, [{ text: userPrompt }], { model: SMART_MODEL }),
    (obj) => isValidShape(obj, n),
    1
  );

  if (!result.ok) {
    return res.status(503).json({ error: 'ai_unavailable', message: 'مقدرناش نجهز الاختبار دلوقتي، جرب تاني بعد شوية.' });
  }

  if (strictUnit !== false) {
    const allowedTopics = new Set(safeTopics.map(x => normalizeTopic(x.text)));
    const outsideUnit = result.data.questions.some(q => !allowedTopics.has(normalizeTopic(q.topic)));
    if (outsideUnit) {
      return res.status(409).json({
        error: 'unit_boundary_violation',
        message: 'الاختبار المقترح يحتوي على سؤال من موضوع خارج الوحدة المطلوبة. لم يتم الانتقال لوحدة أخرى؛ يلزم موافقة الطالب للانتقال.'
      });
    }
  }

  const { data: examSession, error: sessErr } = await db.from('exam_sessions').insert({
    profile_id: profileId, user_id: userId, subject_label: safeSubject.text, topics: safeTopics.map(x => x.text), difficulty: safeDifficulty, question_count: n
  }).select().single();
  if (sessErr) {
    logger.error('generate-exam', 'failed to create exam_session', { error: sessErr.message, userId });
    return res.status(500).json({ error: 'db_error', message: 'مقدرناش نبدأ الاختبار دلوقتي.' });
  }

  const rows = result.data.questions.map((q, i) => ({
    exam_session_id: examSession.id,
    text: q.text,
    type: q.type,
    options: q.type === 'mcq' ? q.options : null,
    correct_index: q.type === 'mcq' ? q.correctIndex : null,
    correct_answer: q.type === 'short_answer' ? q.correctAnswer : null,
    topic: q.topic,
    ord: i
  }));
  const { data: inserted, error: qErr } = await db.from('exam_questions').insert(rows).select();
  if (qErr) {
    logger.error('generate-exam', 'failed to insert exam_questions', { error: qErr.message, userId });
    return res.status(500).json({ error: 'db_error', message: 'مقدرناش نحفظ أسئلة الاختبار.' });
  }

  // Keep a reviewable authoring trail. These are drafts only: no generated
  // question becomes approved content until a reviewer changes workflow_status.
  const draftRows = result.data.questions.map(q => ({
    subject_label: safeSubject.text,
    grade_label: safeGradeLabel || null,
    topic: q.topic,
    prompt: q.text,
    type: q.type,
    options: q.type === 'mcq' ? q.options : null,
    correct_answer: q.type === 'mcq' ? { index: q.correctIndex } : { text: q.correctAnswer },
    workflow_status: 'draft',
    created_by_user_id: userId
  }));
  const { error: draftErr } = await db.from('question_bank').insert(draftRows);
  if (draftErr) {
    logger.error('generate-exam', 'failed to save question drafts', { error: draftErr.message, userId });
    return res.status(500).json({ error: 'db_error', message: 'تم إنشاء الاختبار لكن تعذر حفظ مسودات المراجعة.' });
  }

  const safeQuestions = inserted
    .sort((a, b) => a.ord - b.ord)
    .map(q => ({ id: q.id, text: q.text, type: q.type, options: q.options || undefined, topic: q.topic }));

  return res.status(200).json({ examSessionId: examSession.id, questions: safeQuestions, ragUsed: ragRows.length > 0 });
}

module.exports = withMetrics('generate-exam', handler);
