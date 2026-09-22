// Model routing for Gemini API. Defaults are current stable production models.
const FAST_MODEL = process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite';
const SMART_MODEL = process.env.GEMINI_MODEL_SMART || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
module.exports = { FAST_MODEL, SMART_MODEL };
