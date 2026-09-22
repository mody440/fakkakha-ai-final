// lib/supabaseAdmin.js
// SERVER-SIDE ONLY. Uses the service role key, which bypasses RLS entirely.
// Never import this file from anything that runs in the browser.
// SUPABASE_SERVICE_ROLE_KEY must be set only in Vercel's environment
// variables — it is as sensitive as GEMINI_API_KEY.

let client = null;
function admin() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server');
  }
  // Required lazily, right here, instead of at module load time. This is
  // what lets tests fully replace admin() with a fake client via
  // mock.method without the real @supabase/supabase-js package needing to
  // be installed at all for the test run — this require() line simply
  // never executes when admin() itself is mocked out.
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

module.exports = { admin };
