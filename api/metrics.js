const { withMetrics } = require('../lib/withMetrics');
// GET /api/metrics?key=YOUR_ADMIN_METRICS_KEY
// Protected by a shared secret (ADMIN_METRICS_KEY env var) rather than a
// full admin auth system — proportionate for a single-operator dashboard,
// and trivial to rotate if it ever leaks (just change the env var).
//
// Returns a 24h summary: request volume, error rate, latency, and cache
// hit rate per endpoint — enough to actually notice a problem before a
// student has to tell you about it.

const { admin } = require('../lib/supabaseAdmin');
const crypto = require('crypto');

// Plain !== is a variable-time comparison — over a network the difference
// is normally swamped by jitter, but this is a single-secret admin gate, so
// a constant-time compare costs nothing and removes the theoretical timing
// side-channel entirely.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function handler(req, res) {
  const key = req.query?.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_METRICS_KEY || !key || !safeEqual(key, process.env.ADMIN_METRICS_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const db = admin();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [{ data: requestRows }, { data: eventRows }] = await Promise.all([
    db.from('request_logs').select('endpoint, status_code, duration_ms, cached').gte('created_at', since),
    db.from('analytics_events').select('event_name').gte('created_at', since)
  ]);

  const byEndpoint = {};
  for (const r of requestRows || []) {
    const e = (byEndpoint[r.endpoint] ||= { count: 0, errors: 0, totalDuration: 0, cached: 0 });
    e.count++;
    e.totalDuration += r.duration_ms;
    if (r.status_code >= 400) e.errors++;
    if (r.cached) e.cached++;
  }
  const endpointSummary = Object.entries(byEndpoint).map(([endpoint, e]) => ({
    endpoint,
    requests: e.count,
    errorRate: e.count ? +(e.errors / e.count * 100).toFixed(1) : 0,
    avgDurationMs: e.count ? Math.round(e.totalDuration / e.count) : 0,
    cacheHitRate: e.count ? +(e.cached / e.count * 100).toFixed(1) : 0
  }));

  const eventCounts = {};
  for (const ev of eventRows || []) {
    eventCounts[ev.event_name] = (eventCounts[ev.event_name] || 0) + 1;
  }

  return res.status(200).json({
    windowHours: 24,
    generatedAt: new Date().toISOString(),
    endpoints: endpointSummary,
    events: eventCounts
  });
};

module.exports = withMetrics('metrics', handler);
