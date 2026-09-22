const { withMetrics } = require('../lib/withMetrics');
// GET /api/health
// Point a free uptime monitor (UptimeRobot, Better Stack, etc.) at this URL.
// Deliberately does NOT call Gemini — a health check that costs money every
// time a monitor pings it (every 1-5 minutes) would be a waste; checking
// that the key is configured is enough to catch "forgot to set env var".

const { admin } = require('../lib/supabaseAdmin');

async function handler(req, res) {
  const checks = {
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabaseReachable: false
  };

  try {
    const db = admin();
    // Cheapest possible real query — confirms the service role key and
    // network path actually work, not just that the env vars are set.
    const { error } = await db.from('rate_limits').select('key').limit(1);
    checks.supabaseReachable = !error;
  } catch (err) {
    checks.supabaseReachable = false;
    checks.supabaseError = 'unreachable';
  }

  const healthy = checks.geminiConfigured && checks.supabaseConfigured && checks.supabaseReachable;
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks
  });
};

module.exports = withMetrics('health', handler);
