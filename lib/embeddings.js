// Server-side Gemini embeddings. Never expose GEMINI_API_KEY to the browser.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function embedText(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not configured on the server');
  const model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
  const response = await fetch(`${BASE}/${model}:embedContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: String(text).slice(0, 8000) }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 768
    })
  });
  if (!response.ok) throw new Error(`EMBEDDING_ERROR_${response.status}`);
  const data = await response.json();
  const values = data?.embedding?.values || data?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length !== 768) throw new Error('INVALID_EMBEDDING');
  return values;
}

module.exports = { embedText };
