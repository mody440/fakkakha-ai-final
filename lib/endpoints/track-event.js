// POST /api/track-event
// Body: { eventName, metadata? }
// First-party, minimal analytics. Deliberately NOT Google Analytics or
// similar — this app is used by minors, and routing their usage data
// through a third-party tracker adds privacy/compliance surface area for
// no real benefit at this scale. This table answers the questions that
// actually matter (which features get used, where sessions end) without
// sending anything to an outside company.

const { admin } = require('../supabaseAdmin');
const { requireUser } = require('../verifyAuth');
const { checkRateLimit } = require('../rateLimit');
const { withMetrics } = require('../withMetrics');
const { MAX_EVENT_METADATA_BYTES } = require('../limits');

const ALLOWED_EVENTS = new Set([
  'profile_created', 'session_started', 'session_completed',
  'exam_started', 'exam_completed', 'mistake_detective_used',
  'image_question_used', 'account_linked'
]);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { eventName, metadata } = req.body || {};
  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    return res.status(400).json({ error: 'invalid_metadata' });
  }
  if (metadata !== undefined && metadata !== null) {
    let metadataBytes = 0;
    try { metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_metadata' }); }
    if (metadataBytes > MAX_EVENT_METADATA_BYTES) return res.status(400).json({ error: 'metadata_too_large' });
  }
  if (!ALLOWED_EVENTS.has(eventName)) {
    // Fixed allow-list, not free-text — keeps the events table meaningful
    // and stops it from becoming a dumping ground for arbitrary strings.
    return res.status(400).json({ error: 'invalid_event' });
  }

  let userId;
  try { userId = await requireUser(req); }
  catch { return res.status(401).json({ error: 'unauthenticated' }); }

  // Analytics calls are free (no Gemini cost) but still shouldn't be
  // spammable into an unbounded table — generous but real limit.
  const limit = await checkRateLimit('track-event:' + userId, 200, 3600);
  if (!limit.allowed) return res.status(429).json({ error: 'rate_limited' });

  const db = admin();
  await db.from('analytics_events').insert({
    event_name: eventName,
    user_id: userId,
    metadata: metadata && typeof metadata === 'object' ? metadata : null
  });

  return res.status(204).end();
}

module.exports = withMetrics('track-event', handler);
