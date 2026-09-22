// POST /api/detect-mistake
// Body: { question: string, attempt: string }
// Returns: { category, firstStep, why, tiny, practice }

const { callGemini } = require('../lib/gemini');
const { callAndValidate } = require('../lib/validateAI');
const { checkRateLimit } = require('../lib/rateLimit');
const { requireUser } = require('../lib/verifyAuth');
const { withMetrics } = require('../lib/withMetrics');
const { getCached, setCached, makeCacheKey } = require('../lib/cache');
const { SMART_MODEL } = require('../lib/models');
const logger = require('../lib/logger');
const { sanitizeForAI, safeAIMessage } = require('../lib/guardrails');
const { MAX_QUESTION_LEN, MAX_ATTEMPT_LEN, MAX_MISTAKE_FIELD_LEN } = require('../lib/limits');

const MISTAKE_CATEGORIES = [
  'CONCEPT_MISUNDERSTANDING', 'WRONG_FORMULA', 'WRONG_RULE', 'CALCULATION_ERROR',
  'SIGN_ERROR', 'UNIT_ERROR', 'READING_ERROR', 'LOGIC_ERROR',
  'INCOMPLETE_REASONING', 'CARELESS_ERROR', 'NONE'
];

const SYSTEM_PROMPT = `أنت "Mistake Detective" — جزء من فكّكها AI متخصص في تحليل محاولات حل الطلاب.
هتاخد سؤال ومحاولة حل الطالب، ولازم تحدد:
- أول خطوة غلط فيها الطالب بالظبط
- نوع الخطأ (من القايمة المحددة)
- ليه حصل الخطأ ده
- شرح مختصر جدًا للمفهوم الصح
- سؤال تدريب واحد يستهدف نفس نقطة الضعف

لو الحل كان صح فعلاً، رجّع category = "NONE" وقولّه كده بوضوح.

أرجع JSON فقط بالشكل ده بالظبط:
{
  "category": ${JSON.stringify(MISTAKE_CATEGORIES)},
  "firstStep": "وصف مكان أول خطأ",
  "why": "سبب الخطأ",
  "tiny": "شرح مصغر للمفهوم الصحيح",
  "practice": "سؤال تدريب واحد مستهدف"
}`;

function isValidShape(obj) {
  const isBoundedText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_MISTAKE_FIELD_LEN;
  return obj && MISTAKE_CATEGORIES.includes(obj.category) &&
    isBoundedText(obj.firstStep) && isBoundedText(obj.why) &&
    isBoundedText(obj.tiny) && isBoundedText(obj.practice);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { question, attempt } = req.body || {};
  if (!question || !attempt) {
    return res.status(400).json({ error: 'missing_fields', message: 'السؤال والمحاولة مطلوبين' });
  }
  const safeQuestion = sanitizeForAI(question);
  const safeAttempt = sanitizeForAI(attempt);
  if (safeQuestion.injectionDetected || safeAttempt.injectionDetected) return res.status(400).json({ error: 'unsafe_prompt', message: 'الطلب فيه تعليمات غير آمنة للنظام.' });
  if (question.length > MAX_QUESTION_LEN || attempt.length > MAX_ATTEMPT_LEN) {
    return res.status(400).json({ error: 'input_too_long', message: `السؤال أو المحاولة طويلين أوي (أقصى حد ${MAX_QUESTION_LEN} و ${MAX_ATTEMPT_LEN} حرف بالترتيب).` });
  }

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated', message: 'محتاج تسجّل دخول (حتى لو مجهول) الأول.' }); }

  const limitKey = 'detect-mistake:' + userId;
  const limit = await checkRateLimit(limitKey, 20, 600); // 20 / 10 min
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: `استنى ${limit.retryAfterSeconds} ثانية وجرب تاني.` });
  }

  // Two different students rarely submit byte-identical attempts, but the
  // exact same textbook question + a common wrong answer absolutely
  // repeats — still worth checking the cache before spending a call.
  const cacheKey = makeCacheKey('detect-mistake', { q: safeQuestion.text.trim().toLowerCase(), a: safeAttempt.text.trim().toLowerCase() });
  const cached = await getCached(cacheKey);
  if (cached) {
    res._cached = true;
    return res.status(200).json({ ...cached, cached: true });
  }

  const userPrompt = `السؤال: ${safeQuestion.text}\nمحاولة الطالب:\n${safeAttempt.text}`;

  // This needs real reasoning about the student's specific steps — worth
  // the better model, unlike the simple classification in analyze-question.
  const result = await callAndValidate(
    () => callGemini(SYSTEM_PROMPT, [{ text: userPrompt }], { model: SMART_MODEL }),
    isValidShape,
    1
  );

  if (!result.ok) {
    logger.error('detect-mistake', 'gemini call failed, returning graceful fallback', { error: result.error, userId });
    return res.status(200).json({
      category: 'CONCEPT_MISUNDERSTANDING',
      firstStep: 'مقدرناش نحدد مكان الخطأ بدقة دلوقتي.',
      why: 'الخدمة واجهت عطل مؤقت في التحليل.',
      tiny: 'راجع تعريف المفهوم الأساسي في السؤال ده وحاول تاني.',
      practice: 'أعد كتابة محاولتك بخطوات مرقمة وابعتها تاني.',
      fallback: true
    });
  }

  await setCached(cacheKey, result.data);
  result.data.firstStep = safeAIMessage(result.data.firstStep);
  result.data.why = safeAIMessage(result.data.why);
  result.data.tiny = safeAIMessage(result.data.tiny);
  result.data.practice = safeAIMessage(result.data.practice);
  return res.status(200).json(result.data);
}

module.exports = withMetrics('detect-mistake', handler);
