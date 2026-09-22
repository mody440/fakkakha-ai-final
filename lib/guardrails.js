// Input/output safety layer for AI requests.
// Keeps obvious prompt-injection attempts and direct PII out of model prompts.
// NOTE ON LIMITS: this is a first-pass filter, not a security boundary. A
// regex list can always be evaded by rephrasing, spacing letters out,
// switching language mid-sentence, or hiding the instruction inside content
// that looks like a legitimate question. The real defense is structural —
// every prompt in this codebase explicitly separates "trusted instructions"
// from "untrusted student/RAG text" and tells the model not to follow
// instructions found in the untrusted part, and every AI response is
// validated against a strict output schema (see lib/validateAI.js and each
// endpoint's isValidShape) before it's used for anything. This list only
// catches the cheap, common attempts so they're rejected before spending a
// Gemini call at all — it must never be the only layer relied upon.
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|prior)\s+instructions?/i,
  /i\s*gnore\s+(all|any|previous|prior)\s+instructions?/i,
  /disregard\s+(the|all|previous|prior)\s+instructions?/i,
  /forget\s+(all|your|previous|prior)\s+instructions?/i,
  /reveal\s+(the\s+)?hidden\s+(prompt|instructions?)/i,
  /system\s*prompt/i,
  /developer\s*(message|mode)/i,
  /you\s+are\s+now\s+(in\s+)?(developer|admin|jailbreak|dan)\s*mode/i,
  /reveal\s+(your|the)\s+(prompt|instructions|api\s*key|system\s*message)/i,
  /print\s+(your|the)\s+(system\s*prompt|instructions)/i,
  /act\s+as\s+(if\s+you\s+(have\s+)?no\s+restrictions|an?\s+unfiltered)/i,
  /تعليمات\s*النظام/,
  /تجاهل\s+(كل|أي|التعليمات|التعليمات\s*السابقة)/,
  /انسى\s+(كل|التعليمات)/,
  /اكشف\s+(البرومبت|التعليمات|المفتاح|السيستم)/,
  /اظهر\s+(البرومبت|التعليمات\s*الداخلية)/
];

function detectPromptInjection(text) {
  const value = String(text || '');
  // Normalize Unicode and remove zero-width/control formatting so attackers
  // cannot evade the cheap filter by inserting invisible characters.
  const normalized = value.normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return INJECTION_PATTERNS.some(re => re.test(value) || re.test(normalized));
}

function redactPII(text) {
  let value = String(text || '');
  // Email addresses.
  value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]');
  // International/Egyptian-style phone numbers. Keep short numeric answers intact.
  value = value.replace(/(?:\+?20\s?|0)(?:1[0125]|10|11|12|15)[\s-]?\d{3}[\s-]?\d{4}/g, '[PHONE_REDACTED]');
  // Common ID-like long numeric strings, but do not redact ordinary equations.
  value = value.replace(/\b\d{10,16}\b/g, '[ID_REDACTED]');
  return value;
}

function sanitizeForAI(text) {
  const original = String(text || '');
  return {
    text: redactPII(original),
    injectionDetected: detectPromptInjection(original)
  };
}

function safeAIMessage(text) {
  return redactPII(String(text || '')).replace(/(?:GEMINI_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*\S+/gi, '[SECRET_REDACTED]');
}

function domainSafetyNotice(subjectOrText) {
  const value = String(subjectOrText || '').toLowerCase();
  if (/(medicine|medical|health|doctor|symptom|drug|طب|طبي|دواء|أعراض|تنفس|تشخيص)/i.test(value)) {
    return 'هذا محتوى تعليمي عام فقط: لا تشخّص مرضًا ولا تصف دواءً ولا تعطِ جرعات. في الطوارئ أو الأعراض الخطيرة وجّه الطالب لطبيب أو خدمات الطوارئ.';
  }
  if (/(law|legal|court|contract|محام|قانون|قضية|عقد|حقوق)/i.test(value)) {
    return 'هذا شرح تعليمي عام وليس استشارة قانونية. لا تجزم بقاعدة قانونية محلية، واطلب الرجوع لمحامٍ أو مصدر حكومي عند وجود أثر قانوني.';
  }
  if (/(engineering|engineer|construction|electrical|هندسة|إنشاء|كهرباء|ميكانيكا)/i.test(value)) {
    return 'هذا شرح تعليمي فقط. لا تعتمد عليه لتنفيذ تصميم أو عمل كهربائي أو إنشائي حقيقي؛ نبّه إلى ضرورة مراجعة مهندس مرخّص ومعايير السلامة.';
  }
  return 'قدّم شرحًا تعليميًا دقيقًا، واذكر حدود اليقين، ولا تخترع مصدرًا أو معلومة.';
}

function inferLanguage(text) {
  const value = String(text || '');
  const arabic = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return latin > 0 && latin >= arabic ? 'en' : 'ar';
}

module.exports = { detectPromptInjection, redactPII, sanitizeForAI, safeAIMessage, domainSafetyNotice, inferLanguage };
