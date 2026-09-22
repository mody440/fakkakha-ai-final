const crypto = require('crypto');

function getRateLimitKey(req, endpoint, userId, sessionId = '') {
  const device = String(req?.headers?.['x-device-id'] || req?.headers?.['x-client-device'] || '').slice(0, 160);
  const deviceHash = device ? crypto.createHash('sha256').update(device).digest('hex').slice(0, 24) : 'no-device';
  const sessionPart = sessionId ? String(sessionId).slice(0, 80) : 'no-session';
  return `${endpoint}:${userId}:${deviceHash}:${sessionPart}`;
}

module.exports = { getRateLimitKey };
