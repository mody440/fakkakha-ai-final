// POST /api/score-exam
// Body: { examSessionId, answers: [{ questionId, selectedIndex? , textAnswer? }] }
// Returns: { score, total, breakdown: [{topic, correct, total}], mistakes: [{question, yourAnswer, correctAnswer, topic}] }

const { admin } = require('../lib/supabaseAdmin');
const { requireUser } = require('../lib/verifyAuth');
const { computeExamResult } = require('../lib/examScoring');
const { withMetrics } = require('../lib/withMetrics');
const { callGemini } = require('../lib/gemini');
const { callAndValidate } = require('../lib/validateAI');
const { FAST_MODEL } = require('../lib/models');
const { checkRateLimit } = require('../lib/rateLimit');
const { MAX_EXAM_ANSWERS, MAX_EXAM_TEXT_ANSWER_LEN } = require('../lib/limits');
const logger = require('../lib/logger');

const JUDGE_SYSTEM_PROMPT = `أنت مصحّح إجابات قصيرة. هتاخد سؤال، الإجابة النموذجية، وإجابة الطالب.
حدد لو إجابة الطالب صح بمعنى مقبول، حتى لو مش نفس الصياغة بالظبط — يعني لو نفس المعنى العلمي صح، اعتبرها صح.
أرجع JSON فقط: { "correct": true أو false }`;

async function judgeShortAnswer(questionText, correctAnswer, studentAnswer) {
  const userPrompt = `السؤال: ${questionText}\nالإجابة النموذجية: ${correctAnswer}\nإجابة الطالب: ${studentAnswer}`;
  const result = await callAndValidate(
    () => callGemini(JUDGE_SYSTEM_PROMPT, [{ text: userPrompt }], { model: FAST_MODEL }),
    (obj) => obj && typeof obj.correct === 'boolean',
    1
  );
  // Safe default on failure: never silently mark a real attempt wrong due
  // to an infra hiccup — but also never silently mark it right. Falling
  // back to false is the more honest choice; the student can see the
  // model answer either way and re-attempt if they disagree.
  return result.ok ? result.data.correct : false;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { examSessionId, answers } = req.body || {};
  if (!examSessionId || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'missing_fields', message: 'examSessionId و answers مطلوبين' });
  }

  if (answers.length > MAX_EXAM_ANSWERS || answers.some(a => !a || typeof a.questionId !== 'string')) {
    return res.status(400).json({ error: 'answers_invalid', message: 'إجابات الاختبار غير صالحة.' });
  }
  const answerIds = answers.map(a => a.questionId);
  if (new Set(answerIds).size !== answerIds.length) {
    return res.status(400).json({ error: 'duplicate_answers', message: 'لا يمكن إرسال إجابتين للسؤال نفسه.' });
  }
  if (answers.some(a => a.textAnswer !== undefined && (typeof a.textAnswer !== 'string' || a.textAnswer.length > MAX_EXAM_TEXT_ANSWER_LEN))) {
    return res.status(400).json({ error: 'answer_too_long', message: 'إجابة قصيرة طويلة أوي.' });
  }
  if (answers.some(a => a.selectedIndex !== undefined && (!Number.isInteger(a.selectedIndex) || a.selectedIndex < 0 || a.selectedIndex > 3))) {
    return res.status(400).json({ error: 'answer_invalid', message: 'اختيار غير صالح.' });
  }

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated', message: 'محتاج تسجّل دخول (حتى لو مجهول) الأول.' }); }

  const limit = await checkRateLimit('score-exam:' + userId, 12, 3600);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: `محاولات تصحيح كتير أوي. استنى ${limit.retryAfterSeconds} ثانية.` });
  }

  const db = admin();

  const { data: examSessionRow } = await db.from('exam_sessions').select('id, user_id, finished_at, score, total').eq('id', examSessionId).maybeSingle();
  if (!examSessionRow || examSessionRow.user_id !== userId) {
    return res.status(403).json({ error: 'forbidden', message: 'الاختبار ده مش بتاعك.' });
  }
  if (examSessionRow.finished_at) {
    return res.status(409).json({ error: 'exam_already_scored', message: 'الاختبار ده اتصحح قبل كده.' });
  }

  const { data: questions, error: qErr } = await db.from('exam_questions')
    .select('*').eq('exam_session_id', examSessionId);
  if (qErr || !questions || !questions.length) {
    return res.status(404).json({ error: 'exam_not_found', message: 'الاختبار ده مش موجود.' });
  }
  const questionsById = Object.fromEntries(questions.map(q => [q.id, q]));
  if (answers.some(a => !questionsById[a.questionId])) {
    return res.status(400).json({ error: 'question_not_in_exam', message: 'يوجد سؤال لا ينتمي لهذا الاختبار.' });
  }
  if (answers.some(a => {
    const q = questionsById[a.questionId];
    if (q.type === 'short_answer') return a.selectedIndex !== undefined;
    return a.textAnswer !== undefined || !Number.isInteger(a.selectedIndex) || a.selectedIndex < 0 || a.selectedIndex >= (q.options || []).length;
  })) {
    return res.status(400).json({ error: 'answer_type_mismatch', message: 'نوع إحدى الإجابات لا يطابق السؤال.' });
  }

  // Atomically claim the right to score this session BEFORE running any
  // Gemini calls or writing any rows. A plain "read finished_at, then write
  // later" has a race: two concurrent submits (double-click, retry, or two
  // tabs) can both read finished_at as null and both proceed to score and
  // insert. This single conditional UPDATE is the fix — only the request
  // that flips finished_at from null to non-null wins; every other request,
  // concurrent or not, is rejected below with exam_already_scored instead of
  // silently re-scoring or duplicating exam_answers.
  const { data: claimedRows, error: claimError } = await db.from('exam_sessions')
    .update({ finished_at: new Date().toISOString() })
    .eq('id', examSessionId)
    .is('finished_at', null)
    .select('id');
  if (claimError) {
    logger.error('score-exam', 'failed to claim exam session for scoring', { error: claimError.message, userId, examSessionId });
    return res.status(500).json({ error: 'db_error', message: 'مقدرناش نبدأ التصحيح دلوقتي.' });
  }
  if (!claimedRows || claimedRows.length === 0) {
    return res.status(409).json({ error: 'exam_already_scored', message: 'الاختبار ده اتصحح قبل كده.' });
  }

  // short_answer questions can't be scored by comparing an index — judge
  // each submitted one with a cheap model call BEFORE handing everything
  // to the pure scoring function. mcq answers need no judging at all.
  await Promise.all(answers.map(async (a) => {
    const q = questionsById[a.questionId];
    if (q && q.type === 'short_answer' && a.textAnswer) {
      try {
        a.judgedCorrect = await judgeShortAnswer(q.text, q.correct_answer, a.textAnswer);
      } catch (err) {
        logger.error('score-exam', 'short-answer judging failed', { error: err.message, userId });
        a.judgedCorrect = false;
      }
    }
  }));

  // Pure scoring logic lives in lib/examScoring.js and is unit tested there —
  // this endpoint only does I/O (read questions, judge free-text answers, write results).
  const { score, total, breakdown, mistakes, answerRows } = computeExamResult(questions, answers);

  const fullAnswerRows = answerRows.map(r => ({ ...r, exam_session_id: examSessionId, user_id: userId }));
  const { error: insertError } = await db.from('exam_answers').insert(fullAnswerRows);
  if (insertError) {
    // The session is already claimed (finished_at set) at this point, so we
    // can't just re-try later automatically — but we must NOT return 200 as
    // if scoring succeeded when the answer rows never made it to storage.
    logger.error('score-exam', 'failed to insert exam_answers after claiming session', { error: insertError.message, userId, examSessionId });
    return res.status(500).json({ error: 'db_error', message: 'حصل خطأ أثناء حفظ نتيجة الاختبار. لو الاختبار فضل معلّق، تواصل مع الدعم.' });
  }
  const { error: resultUpdateError } = await db.from('exam_sessions').update({ score, total }).eq('id', examSessionId);
  if (resultUpdateError) {
    logger.error('score-exam', 'failed to finalize score fields', { error: resultUpdateError.message, userId, examSessionId });
    return res.status(500).json({ error: 'db_error', message: 'تم حفظ الإجابات لكن تعذر تثبيت النتيجة. حاول تحديث الصفحة.' });
  }

  return res.status(200).json({ score, total, breakdown, mistakes });
}

module.exports = withMetrics('score-exam', handler);
