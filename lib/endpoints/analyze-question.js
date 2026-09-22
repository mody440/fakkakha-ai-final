// POST /api/analyze-question
// Body: { question: string, gradeLabel?: string }
// Returns: { subject, subjectLabel, topic, intent, difficulty }

const { callGemini } = require('../gemini');
const { callAndValidate } = require('../validateAI');
const { checkRateLimit } = require('../rateLimit');
const { requireUser } = require('../verifyAuth');
const { withMetrics } = require('../withMetrics');
const { getCached, setCached, makeCacheKey } = require('../cache');
const { FAST_MODEL } = require('../models');
const logger = require('../logger');
const { sanitizeForAI, safeAIMessage, domainSafetyNotice } = require('../guardrails');
const { MAX_QUESTION_LEN, MAX_GRADE_LABEL_LEN, MAX_TOPIC_LEN, MAX_SUBJECT_LABEL_LEN } = require('../limits');
const { getLearnerRubric } = require('../learnerRubric');
const { getRateLimitKey } = require('../rateIdentity');

const ALLOWED_SUBJECTS = ['math','physics','chemistry','biology','arabic_lang','english_lang','history','geography','computer_science','engineering','medicine_general','law_general','languages','social_studies','general'];
const ALLOWED_INTENTS = ['explain', 'solve', 'understand'];
const ALLOWED_DIFFICULTIES = ['easy', 'medium', 'hard'];

const SYSTEM_PROMPT = `أنت محرك تحليل أسئلة تعليمية اسمه Fakkakha AI.
مهمتك الوحيدة: تحليل سؤال الطالب وإرجاع تصنيف له.
لا تشرح، لا تحل، لا تضف أي نص خارج الـ JSON.

أرجع كائن JSON بالشكل ده بالظبط:
{
  "subject": "math | physics | chemistry | biology | arabic_lang | english_lang | history | geography | computer_science | engineering | medicine_general | law_general | languages | social_studies | general",
  "subjectLabel": "اسم المادة بالعربي، مثلاً: رياضيات",
  "topic": "اسم الموضوع المحدد، مثلاً: معادلات من الدرجة الأولى",
  "intent": "explain | solve | understand",
  "difficulty": "easy | medium | hard"
}

خد بالك: الطالب ممكن يكتب بالعربي أو الإنجليزي أو مخلوط، وممكن يكتب بالعامية المصرية. افهم القصد مش بس الكلمات.`;

function isValidShape(obj) {
  return obj &&
    typeof obj.subject === 'string' && ALLOWED_SUBJECTS.includes(obj.subject) &&
    typeof obj.subjectLabel === 'string' && obj.subjectLabel.trim().length > 0 && obj.subjectLabel.length <= MAX_SUBJECT_LABEL_LEN &&
    typeof obj.topic === 'string' && obj.topic.trim().length > 0 && obj.topic.length <= MAX_TOPIC_LEN &&
    typeof obj.intent === 'string' && ALLOWED_INTENTS.includes(obj.intent) &&
    (obj.difficulty === undefined || ALLOWED_DIFFICULTIES.includes(obj.difficulty));
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { question, gradeLabel, age, profileSubject, language } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'empty_question', message: 'السؤال فاضي' });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: 'question_too_long', message: `السؤال طويل أوي (أقصى حد ${MAX_QUESTION_LEN} حرف).` });
  }
  const safeGradeLabel = typeof gradeLabel === 'string' ? gradeLabel.slice(0, MAX_GRADE_LABEL_LEN) : '';
  const safeQuestion = sanitizeForAI(question);
  if (safeQuestion.injectionDetected) return res.status(400).json({ error: 'unsafe_prompt', message: 'الطلب فيه تعليمات غير آمنة للنظام.' });

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated', message: 'محتاج تسجّل دخول (حتى لو مجهول) الأول.' }); }

  const limitKey = getRateLimitKey(req, 'analyze-question', userId);
  const limit = await checkRateLimit(limitKey, 40, 600); // 40 calls / 10 min
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: `استنى ${limit.retryAfterSeconds} ثانية وجرب تاني.` });
  }

  // Thousands of students ask overlapping questions — reuse the answer
  // instead of paying Gemini again for the same classification.
  const cacheKey = makeCacheKey('analyze-question', { q: safeQuestion.text.trim().toLowerCase(), g: safeGradeLabel });
  const cached = await getCached(cacheKey);
  if (cached) {
    res._cached = true;
    return res.status(200).json({ ...cached, cached: true });
  }

  const safeAge = Number.isFinite(Number(age)) ? Math.max(5, Math.min(100, Number(age))) : null;
  const safeProfileSubject = typeof profileSubject === 'string' ? profileSubject.slice(0, MAX_SUBJECT_LABEL_LEN) : '';
  const safeLanguage = language === 'en' ? 'en' : 'ar';
  const userPrompt = `السؤال: ${safeQuestion.text}
مرحلة الطالب: ${safeGradeLabel || 'غير محددة'}
العمر: ${safeAge ?? 'غير محدد'}
المادة الأساسية في الملف: ${safeProfileSubject || 'غير محددة'}
لغة الواجهة المفضلة: ${safeLanguage}
تعليمات أمان المجال: ${domainSafetyNotice(safeProfileSubject || safeQuestion.text)}
${getLearnerRubric(safeAge, safeGradeLabel)}`;

  // Classification is a simple, low-stakes task — the fast/cheap model tier
  // is the right fit, not the same model used for actual teaching.
  const result = await callAndValidate(
    () => callGemini(SYSTEM_PROMPT, [{ text: userPrompt }], { model: FAST_MODEL }),
    isValidShape,
    1
  );

  if (!result.ok) {
    logger.error('analyze-question', 'classifier unavailable — refusing silent fallback', { error: result.error, userId });
    return res.status(503).json({
      code: 'ai_unavailable',
      message: 'خدمة تحليل السؤال غير متاحة حاليًا. لم نستخدم تصنيفًا افتراضيًا حتى لا نضللك.'
    });
  }

  await setCached(cacheKey, result.data);
  return res.status(200).json(result.data);
}

module.exports = withMetrics('analyze-question', handler);
