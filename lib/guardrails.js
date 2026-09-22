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
  /disregard\s+(the|all|previous|prior)\s+instructions?/i,
  /forget\s+(all|your|previous|prior)\s+instructions?/i,
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
  return INJECTION_PATTERNS.some(re => re.test(value));
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

module.exports = { detectPromptInjection, redactPII, sanitizeForAI, safeAIMessage };
