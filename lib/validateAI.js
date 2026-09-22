// lib/validateAI.js
// Never trust raw AI output. Parse defensively, validate against a shape
// check, retry once on failure, and let the caller decide the safe fallback.

function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      return null;
    }
  }
}

/**
 * @param {() => Promise<string>} promptFn - calls Gemini, returns raw text
 * @param {(obj: any) => boolean} schemaCheck - returns true if shape is valid
 * @param {number} retries
 */
async function callAndValidate(promptFn, schemaCheck, retries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await promptFn();
      const parsed = safeParseJSON(raw);
      if (parsed && schemaCheck(parsed)) return { ok: true, data: parsed };
    } catch (err) {
      lastError = err.message || String(err);
    }
  }
  return { ok: false, error: lastError || 'INVALID_AI_RESPONSE' };
}

module.exports = { safeParseJSON, callAndValidate };
