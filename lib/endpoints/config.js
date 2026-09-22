const { withMetrics } = require('../withMetrics');
// GET /api/config
// Exposes only the browser-safe Supabase URL + anon key. Server secrets are
// never returned from this endpoint. Keeping these values in environment
// variables avoids editing public/app.js for every deployment.
function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY || '';
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ error: 'supabase_public_config_missing' });
  }
  return res.status(200).json({ supabaseUrl, supabaseAnonKey });
};

module.exports = withMetrics('config', handler);
