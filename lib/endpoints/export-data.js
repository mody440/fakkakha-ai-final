const { admin } = require('../supabaseAdmin');
const { requireUser } = require('../verifyAuth');
const { withMetrics } = require('../withMetrics');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated' }); }

  const db = admin();
  const tables = ['profiles','skills','sessions','messages','mistake_log','exam_sessions','exam_answers','analytics_events','flagged_content'];
  const out = {};
  for (const table of tables) {
    const { data, error } = await db.from(table).select('*').eq('user_id', userId).limit(5000);
    if (error) return res.status(503).json({ error: 'db_error', message: `تعذر تصدير بيانات ${table}.` });
    out[table] = data || [];
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fakkakha-data-export.json"');
  return res.status(200).json({ exportedAt: new Date().toISOString(), userId, data: out });
}
module.exports = withMetrics('export-data', handler);
