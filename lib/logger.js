// lib/logger.js
// Two jobs: (1) consistent JSON log lines for Vercel's log viewer, and
// (2) durable request metrics in Supabase so /api/metrics can answer real
// questions later — "what's my error rate", "what's slow", "how much of
// this is served from cache" — instead of only ever finding out from a
// student's complaint.

const { admin } = require('./supabaseAdmin');

function log(level, endpoint, message, extra = {}) {
  const entry = { level, endpoint, message, timestamp: new Date().toISOString(), ...extra };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

// Never let a logging failure affect the actual response — always swallow.
async function recordRequest({ endpoint, statusCode, durationMs, cached = false, error = null }) {
  try {
    const db = admin();
    await db.from('request_logs').insert({
      endpoint, status_code: statusCode, duration_ms: durationMs, cached, error
    });
  } catch (_) { /* metrics logging must never break the request */ }
}

module.exports = {
  info: (endpoint, message, extra) => log('info', endpoint, message, extra),
  error: (endpoint, message, extra) => log('error', endpoint, message, extra),
  recordRequest,
};
