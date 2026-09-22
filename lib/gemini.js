// lib/gemini.js
// The ONLY module in this project that talks to Gemini.
// GEMINI_API_KEY must be set as a server-side environment variable
// (Vercel dashboard -> Settings -> Environment Variables). It is never
// sent to, or readable by, the browser.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Calls Gemini with a system instruction + user prompt, asking for a pure
 * JSON response (per Gemini's own responseMimeType feature, so we don't
 * have to hand-strip markdown fences).
 * @param {string} systemPrompt
 * @param {Array<object>} parts - Gemini "parts" array (text, or inlineData for images)
 * @param {object} opts - opts.model overrides which model tier is used (see lib/models.js)
 */
async function callGemini(systemPrompt, parts, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }
  const model = opts.model || process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_SMART || 'gemini-3.8-flash';

  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: opts.json === false ? 'text/plain' : 'application/json',
      temperature: opts.temperature ?? 0.4
    },
    // Explicit safety thresholds instead of relying on Gemini's defaults —
    // this is a children's education product, so err on the strict side.
    // BLOCK_LOW_AND_ABOVE blocks low, medium, and high probability harmful
    // content, only letting through content classified as negligible risk.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 20000);

  let res;
  try {
    res = await fetch(`${BASE}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw new Error('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GEMINI_ERROR_${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();

  // A response can come back with no candidates at all if every candidate
  // was blocked by the safety settings above — that's a deliberate refusal,
  // not a malformed response, so it gets its own clear error.
  if (data?.promptFeedback?.blockReason || !data?.candidates?.length) {
    throw new Error('CONTENT_BLOCKED');
  }

  const text = data.candidates[0]?.content?.parts?.map(p => p.text || '').join('') ?? '';
  if (!text) throw new Error('EMPTY_RESPONSE');
  return text;
}

module.exports = { callGemini };
