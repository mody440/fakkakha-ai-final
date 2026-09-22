// POST /api/analyze-image
// Body: { imageBase64: string, mimeType: string }  (no data: prefix in imageBase64)
// Returns: { readable: boolean, extractedText, subject, subjectLabel, topic, intent }

const { callGemini } = require('../gemini');
const { callAndValidate } = require('../validateAI');
const { checkRateLimit } = require('../rateLimit');
const { requireUser } = require('../verifyAuth');
const { withMetrics } = require('../withMetrics');
const { SMART_MODEL } = require('../models');
const logger = require('../logger');
const { sanitizeForAI, safeAIMessage } = require('../guardrails');
const { MAX_EXTRACTED_TEXT_LEN, MAX_SUBJECT_LABEL_LEN, MAX_TOPIC_LEN } = require('../limits');

const ALLOWED_SUBJECTS = ['math', 'physics', 'chemistry', 'biology', 'arabic_lang', 'english_lang', 'general'];
const ALLOWED_INTENTS = ['explain', 'solve', 'understand'];

const SYSTEM_PROMPT = `أنت جزء من فكّكها AI متخصص في قراءة صور الأسئلة التعليمية (مطبوعة أو بخط اليد).
هتشوف صورة، وتحدد:
- لو ممكن تقرأها بوضوح
- نص السؤال المستخرج
- المادة والموضوع والقصد منه

لو الصورة مش واضحة كفاية، رجّع readable=false واشرح إيه اللي ناقص.

أرجع JSON فقط بالشكل ده بالظبط:
{
  "readable": true أو false,
  "extractedText": "النص المستخرج أو سبب عدم الوضوح",
  "subject": "math | physics | chemistry | biology | arabic_lang | english_lang | general",
  "subjectLabel": "اسم المادة بالعربي",
  "topic": "اسم الموضوع",
  "intent": "explain | solve | understand"
}`;

function isValidShape(obj) {
  if (!obj || typeof obj.readable !== 'boolean') return false;
  if (typeof obj.extractedText !== 'string' || obj.extractedText.length > MAX_EXTRACTED_TEXT_LEN) return false;
  // An unreadable image legitimately has no classification to check —
  // only bound the fields we DO always trust from the model.
  if (!obj.readable) return true;
  return typeof obj.subject === 'string' && ALLOWED_SUBJECTS.includes(obj.subject) &&
    typeof obj.subjectLabel === 'string' && obj.subjectLabel.trim().length > 0 && obj.subjectLabel.length <= MAX_SUBJECT_LABEL_LEN &&
    typeof obj.topic === 'string' && obj.topic.trim().length > 0 && obj.topic.length <= MAX_TOPIC_LEN &&
    typeof obj.intent === 'string' && ALLOWED_INTENTS.includes(obj.intent);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { imageBase64, mimeType } = req.body || {};
  if (typeof imageBase64 !== 'string' || typeof mimeType !== 'string' || !imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'missing_image', message: 'الصورة مطلوبة' });
  }
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mimeType)) {
    return res.status(415).json({ error: 'unsupported_image_type', message: 'نوع الصورة غير مدعوم.' });
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(imageBase64)) {
    return res.status(400).json({ error: 'invalid_image_data', message: 'بيانات الصورة غير صالحة.' });
  }
  // Basic size guard — keep payloads reasonable, compress on the client first.
  if (imageBase64.length > 6_000_000) {
    return res.status(413).json({ error: 'image_too_large', message: 'الصورة كبيرة جدًا، جرب تضغطها' });
  }

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated', message: 'محتاج تسجّل دخول (حتى لو مجهول) الأول.' }); }

  const limitKey = 'analyze-image:' + userId;
  const limit = await checkRateLimit(limitKey, 15, 600); // 15 / 10 min — vision calls cost more
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', message: `استنى ${limit.retryAfterSeconds} ثانية وجرب تاني.` });
  }

  const parts = [
    { inlineData: { mimeType, data: imageBase64 } },
    { text: 'حلل الصورة دي.' }
  ];

  const result = await callAndValidate(
    () => callGemini(SYSTEM_PROMPT, parts, { model: SMART_MODEL }),
    isValidShape,
    1
  );

  if (!result.ok) {
    logger.error('analyze-image', 'gemini call failed, returning graceful fallback', { error: result.error, userId });
    return res.status(200).json({
      readable: false,
      extractedText: 'مقدرناش نحلل الصورة دلوقتي — جرب تاني أو اكتب السؤال يدويًا.',
      fallback: true
    });
  }

  result.data.extractedText = safeAIMessage(result.data.extractedText);
  return res.status(200).json(result.data);
}

module.exports = withMetrics('analyze-image', handler);
