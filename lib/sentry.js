const crypto = require('crypto');

// Lightweight Sentry integration without shipping a client SDK.
// Set SENTRY_DSN in server environment. Events contain no request body or
// secrets; only endpoint, error type, and requestId are sent.
function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, '');
    const publicKey = u.username;
    if (!publicKey || !projectId) return null;
    const host = `${u.protocol}//${u.host}`;
    return { host, publicKey, projectId };
  } catch { return null; }
}

async function captureException(error, context = {}) {
  const dsn = parseDsn(process.env.SENTRY_DSN || '');
  if (!dsn) return false;
  const payload = {
    event_id: crypto.randomUUID(),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    message: String(error?.message || error || 'unknown_error').slice(0, 500),
    exception: { values: [{ type: error?.name || 'Error', value: String(error?.message || error).slice(0, 500) }] },
    tags: { endpoint: context.endpoint || 'unknown' },
    extra: { requestId: context.requestId || null }
  };
  const url = `${dsn.host}/api/${dsn.projectId}/store/?sentry_version=7&sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_client=fakkakha/1.0`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return response.ok;
  } catch { return false; }
}

module.exports = { captureException };
