// Server-side persistence for Socratic turns.
// Supports the current production schema (learning_sessions/session_messages)
// and the legacy schema used by older deployments and endpoint tests.
const { admin } = require('./supabaseAdmin');

async function getOwnedSession(db, sessionId, userId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;

  const current = await db.from('learning_sessions')
    .select('id,user_id,subject,education_level,school_year,question_text,status')
    .eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (!current.error && current.data) {
    return {
      ...current.data,
      subject_label: current.data.subject,
      grade_label: current.data.school_year || current.data.education_level || '',
      topic: current.data.topic || current.data.subject,
      __table: 'learning_sessions'
    };
  }

  const legacy = await db.from('sessions')
    .select('id,user_id,profile_id,subject,subject_label,topic,grade_label')
    .eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (legacy.error || !legacy.data) return null;
  return { ...legacy.data, __table: 'sessions' };
}

async function findMessage(db, table, sessionId, turnId, role) {
  const actualRole = table === 'session_messages'
    ? (role === 'ai' ? 'assistant' : role === 'student' ? 'user' : 'system')
    : role;
  const { data } = await db.from(table).select('id,role,content')
    .eq('session_id', sessionId).eq('client_turn_id', turnId).eq('role', actualRole).maybeSingle();
  return data || null;
}

async function persistMessage(db, table, { userId, sessionId, turnId, role, content }) {
  const actualRole = table === 'session_messages'
    ? (role === 'ai' ? 'assistant' : role === 'student' ? 'user' : 'system')
    : role;
  const payload = { user_id: userId, session_id: sessionId, role: actualRole, content, client_turn_id: turnId };
  const { error } = await db.from(table).insert(payload);
  return error || null;
}

async function persistStudentTurn({ sessionId, userId, turnId, content }) {
  const db = admin();
  const owned = await getOwnedSession(db, sessionId, userId);
  if (!owned) return { ok: false, error: 'session_not_owned' };
  if (!content) return { ok: true, session: owned };
  const table = owned.__table === 'learning_sessions' ? 'session_messages' : 'messages';
  const existing = await findMessage(db, table, sessionId, turnId, 'student');
  if (!existing) {
    const error = await persistMessage(db, table, { userId, sessionId, turnId, role: 'student', content });
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true, session: owned };
}

async function persistAiTurn({ sessionId, userId, turnId, aiMessage, result }) {
  const db = admin();
  const owned = await getOwnedSession(db, sessionId, userId);
  if (!owned) return { ok: false, error: 'session_not_owned' };
  const table = owned.__table === 'learning_sessions' ? 'session_messages' : 'messages';
  const existing = await findMessage(db, table, sessionId, turnId, 'ai');
  if (!existing) {
    const error = await persistMessage(db, table, { userId, sessionId, turnId, role: 'ai', content: aiMessage });
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true, session: owned };
}

module.exports = { getOwnedSession, persistStudentTurn, persistAiTurn };
