// lib/verifyAuth.js
// Every endpoint that costs money (calls Gemini) or touches a specific
// profile's data MUST call this first. It verifies the caller actually
// holds a valid Supabase session token — a client can no longer just claim
// any userId string to dodge rate limiting or write to someone else's rows.

const { admin } = require('./supabaseAdmin');

/**
 * @param {object} req - the Vercel request object
 * @returns {Promise<string>} the verified user id
 * @throws {Error} 'UNAUTHENTICATED' if there's no valid token
 */
async function requireUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('UNAUTHENTICATED');

  const { data, error } = await admin().auth.getUser(token);
  if (error || !data?.user) throw new Error('UNAUTHENTICATED');
  return data.user.id;
}

module.exports = { requireUser };
