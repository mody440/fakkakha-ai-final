// lib/cache.js
// Thousands of students will ask overlapping questions ("اشرحلي قانون نيوتن
// التاني" gets asked constantly). Without this, every single one of those
// is a fresh, paid Gemini call — cost that scales linearly with usage
// forever. With it, the Nth time a question is asked, it's a cheap DB read.
//
// Only used for endpoints whose answer for a given input is genuinely
// reusable across different students (analyze-question, detect-mistake).
// session-turn is NOT cached — it's inherently contextual (depends on the
// specific conversation history), so caching it would return stale or
// wrong answers.

const crypto = require('crypto');
const { admin } = require('./supabaseAdmin');

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 week — classifications don't go stale fast

function makeCacheKey(namespace, input) {
  const normalized = JSON.stringify(input, Object.keys(input).sort());
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `${namespace}:${hash}`;
}

async function getCached(key) {
  const db = admin();
  const { data } = await db.from('response_cache').select('response, created_at').eq('cache_key', key).maybeSingle();
  if (!data) return null;
  const ageSeconds = (Date.now() - new Date(data.created_at).getTime()) / 1000;
  if (ageSeconds > CACHE_TTL_SECONDS) return null;
  return data.response;
}

async function setCached(key, response) {
  const db = admin();
  // Fire-and-forget from the caller's perspective is tempting, but a failed
  // write here should never surface as a user-facing error — swallow it.
  await db.from('response_cache').upsert({ cache_key: key, response, created_at: new Date().toISOString() })
    .then(() => {}, () => {});
}

module.exports = { makeCacheKey, getCached, setCached };
