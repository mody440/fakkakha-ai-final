// POST /api/report-content
// Body: { context, aiMessage, reason? }
// Every session-turn / detect-mistake response reaches the browser after
// Gemini's own safety filtering (see the safetySettings in lib/gemini.js),
// but no automated filter is perfect for a children's education product.
// This is the second layer: a real, durable place for a human to flag
// something that got through wrong or inappropriate, reviewed later via
// Supabase's table editor (flagged_content, reviewed = false by default).

const { admin } = require('../lib/supabaseAdmin');
const { requireUser } = require('../lib/verifyAuth');
const { checkRateLimit } = require('../lib/rateLimit');
const { withMetrics } = require('../lib/withMetrics');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { context, aiMessage, reason } = req.body || {};
  if (typeof context !== 'string' || typeof aiMessage !== 'string' || !context.trim() || !aiMessage.trim()) {
    return res.status(400).json({ error: 'missing_fields', message: 'context و aiMessage مطلوبين' });
  }
  if (context.length > 100 || aiMessage.length > 4000 || (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 1000))) {
    return res.status(400).json({ error: 'input_too_long' });
  }

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated' }); }

  const limit = await checkRateLimit('report-content:' + userId, 20, 3600);
  if (!limit.allowed) return res.status(429).json({ error: 'rate_limited', message: 'بلاغات كتير أوي دلوقتي، جرب تاني بعدين.' });

  const db = admin();
  const { error } = await db.from('flagged_content').insert({
    user_id: userId, context, ai_message: aiMessage, reason: reason || null
  });
  if (error) return res.status(500).json({ error: 'db_error', message: 'مقدرناش نحفظ البلاغ دلوقتي.' });

  return res.status(200).json({ ok: true, message: 'شكرًا، هنراجعها.' });
}

module.exports = withMetrics('report-content', handler);
