const { withMetrics } = require('../withMetrics');
// GET /api/health
// Point a free uptime monitor (UptimeRobot, Better Stack, etc.) at this URL.
// Deliberately does NOT call Gemini — a health check that costs money every
// time a monitor pings it (every 1-5 minutes) would be a waste; checking
// that the key is configured is enough to catch "forgot to set env var".

const { admin } = require('../supabaseAdmin');

async function handler(req, res) {
  const checks = {
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabaseReachable: false,
    learningSessionsTable: false,
    sessionMessagesTable: false
  };

  try {
    const db = admin();
    // Cheapest possible real query — confirms the service role key and
    // network path actually work, not just that the env vars are set.
    // `profiles` is part of the deployed schema; rate_limits is optional and
    // is not present in every Supabase project using this application.
    const [{ error: profileError }, { error: sessionsError }, { error: messagesError }] = await Promise.all([
      db.from('profiles').select('id').limit(1),
      db.from('learning_sessions').select('id').limit(1),
      db.from('session_messages').select('id').limit(1)
    ]);
    checks.supabaseReachable = !profileError;
    checks.learningSessionsTable = !sessionsError;
    checks.sessionMessagesTable = !messagesError;
  } catch (err) {
    checks.supabaseReachable = false;
    checks.supabaseError = 'unreachable';
  }

  const healthy = checks.geminiConfigured && checks.supabaseConfigured && checks.supabaseReachable &&
    checks.learningSessionsTable && checks.sessionMessagesTable;
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks
  });
};

module.exports = withMetrics('health', handler);
