// tests/endpoints.test.js
// Unlike tests/unit.test.js (pure functions), these exercise the ACTUAL
// exported endpoint handlers end-to-end against a fake Supabase backend and
// a mocked Gemini call — catching bugs in auth checks, rate limiting, and
// caching that pure-function tests can't see.
//
// Mocking order matters: lib/supabaseAdmin.admin and lib/gemini.callGemini
// must be patched BEFORE any endpoint (or the lib files it depends on) is
// required for the first time in this process, since each file destructures
// its dependency at require-time (`const { admin } = require(...)`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const { createFakeSupabase } = require('./fakeSupabase');

const supabaseAdminModule = require('../lib/supabaseAdmin');
const geminiModule = require('../lib/gemini');

const VALID_TOKEN = 'valid-test-token';
const USER_ID = 'test-user-id';

let fakeDb;
mock.method(supabaseAdminModule, 'admin', () => fakeDb);

let geminiResponse = null;
mock.method(geminiModule, 'callGemini', async () => geminiResponse);

// Required AFTER the mocks above are installed, so their internal
// `const { admin } = require('../lib/supabaseAdmin')` picks up the mock.
const analyzeQuestion = require('../api/analyze-question');
const analyzeImage = require('../api/analyze-image');
const detectMistake = require('../api/detect-mistake');
const generateExam = require('../api/generate-exam');
const sessionTurn = require('../api/session-turn');
const scoreExam = require('../api/score-exam');

function fakeReqRes(body, headers = {}) {
  const req = { method: 'POST', body, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
    headersSent: false,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  };
  return { req, res };
}

test.beforeEach(() => {
  fakeDb = createFakeSupabase({ validToken: VALID_TOKEN, userId: USER_ID });
});
function seedSession(id = 'session-1') {
  fakeDb._store.set('sessions', [{ id, user_id: USER_ID, profile_id: 'my-profile', subject: 'math', subject_label: 'رياضيات', topic: 'جبر' }]);
  return id;
}


test('API errors use the unified error envelope with a requestId', async () => {
  const { req, res } = fakeReqRes({ question: '' }, {});
  await analyzeQuestion(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'empty_question');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(typeof res.body.requestId, 'string');
  assert.equal(res.headers['x-request-id'], res.body.requestId);
});

test('analyze-question: rejects a request with no auth token', async () => {
  const { req, res } = fakeReqRes({ question: 'اشرحلي قانون نيوتن' }, {});
  await analyzeQuestion(req, res);
  assert.equal(res.statusCode, 401);
});

test('analyze-question: rejects an invalid token', async () => {
  const { req, res } = fakeReqRes(
    { question: 'اشرحلي قانون نيوتن' },
    { authorization: 'Bearer garbage-token' }
  );
  await analyzeQuestion(req, res);
  assert.equal(res.statusCode, 401);
});

test('analyze-question: happy path returns the classification with a valid token', async () => {
  geminiResponse = JSON.stringify({
    subject: 'physics', subjectLabel: 'فيزياء', topic: 'قانون نيوتن الثاني',
    intent: 'explain', difficulty: 'medium'
  });
  const { req, res } = fakeReqRes(
    { question: 'اشرحلي قانون نيوتن التاني', gradeLabel: 'إعدادي' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeQuestion(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subject, 'physics');
  assert.equal(res.body.topic, 'قانون نيوتن الثاني');
});

test('analyze-question: second identical question is served from cache, not a fresh Gemini call', async () => {
  geminiResponse = JSON.stringify({
    subject: 'math', subjectLabel: 'رياضيات', topic: 'معادلات', intent: 'solve', difficulty: 'easy'
  });
  const callsBefore = geminiModule.callGemini.mock.callCount();

  const { req: req1, res: res1 } = fakeReqRes(
    { question: 'حل 2x + 5 = 17', gradeLabel: 'ثانوي' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeQuestion(req1, res1);
  const callsAfterFirst = geminiModule.callGemini.mock.callCount();

  const { req: req2, res: res2 } = fakeReqRes(
    { question: 'حل 2x + 5 = 17', gradeLabel: 'ثانوي' }, // byte-identical question
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeQuestion(req2, res2);
  const callsAfterSecond = geminiModule.callGemini.mock.callCount();

  assert.equal(callsAfterFirst - callsBefore, 1, 'first call should hit Gemini once');
  assert.equal(callsAfterSecond - callsAfterFirst, 0, 'second identical call should NOT hit Gemini again');
  assert.equal(res2.body.cached, true);
  assert.equal(res2.body.topic, 'معادلات');
});

test('analyze-question: rejects a question over the length limit before ever touching Gemini', async () => {
  const callsBefore = geminiModule.callGemini.mock.callCount();
  const { req, res } = fakeReqRes(
    { question: 'س'.repeat(5000) },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeQuestion(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(geminiModule.callGemini.mock.callCount(), callsBefore, 'must not spend a Gemini call on an oversized input');
});

test('generate-exam: refuses to build an exam on a profile that is not the caller\'s', async () => {
  fakeDb._store.set('profiles', [{ id: 'someone-elses-profile', user_id: 'a-different-user' }]);
  const { req, res } = fakeReqRes(
    { profileId: 'someone-elses-profile', subjectLabel: 'رياضيات', topics: ['جبر'], count: 5 },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await generateExam(req, res);
  assert.equal(res.statusCode, 403);
});

test('generate-exam: proceeds when the profile really belongs to the caller', async () => {
  fakeDb._store.set('profiles', [{ id: 'my-profile', user_id: USER_ID }]);
  geminiResponse = JSON.stringify({
    questions: Array.from({ length: 3 }, (_, i) => ({
      type: 'mcq', text: `سؤال ${i}`, options: ['أ', 'ب', 'ج', 'د'], correctIndex: 0, topic: 'جبر'
    }))
  });
  const { req, res } = fakeReqRes(
    { profileId: 'my-profile', subjectLabel: 'رياضيات', topics: ['جبر'], count: 3 },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await generateExam(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.questions.length, 3);
  // The correct answer must never be sent to the browser.
  for (const q of res.body.questions) {
    assert.equal(q.correctIndex, undefined);
  }
});

// --- session-turn: the core Socratic teaching engine ---

test('session-turn: rejects a request with no auth token', async () => {
  const { req, res } = fakeReqRes({ subjectLabel: 'فيزياء', topic: 'قانون نيوتن', action: 'start', sessionId: seedSession(), turnId: 'turn-no-auth' }, {});
  await sessionTurn(req, res);
  assert.equal(res.statusCode, 401);
});

test('session-turn: happy path returns the AI message and verdict', async () => {
  geminiResponse = JSON.stringify({
    aiMessage: 'تمام، خطوة خطوة هنفهمها', verdict: null, mistakeCategory: null,
    sessionComplete: false, masteryDelta: 0
  });
  const { req, res } = fakeReqRes(
    { subjectLabel: 'فيزياء', topic: 'قانون نيوتن الثاني', action: 'start', history: [], sessionId: seedSession(), turnId: 'turn-happy' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await sessionTurn(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.aiMessage, 'تمام، خطوة خطوة هنفهمها');
});

test('session-turn: repeated same turnId is idempotent and does not call Gemini twice', async () => {
  seedSession('session-idem');
  geminiResponse = JSON.stringify({
    aiMessage: 'رد محفوظ', verdict: null, mistakeCategory: null, sessionComplete: false, masteryDelta: 0
  });
  const before = geminiModule.callGemini.mock.callCount();
  const body = { subjectLabel: 'رياضيات', topic: 'جبر', action: 'start', history: [], sessionId: 'session-idem', turnId: 'same-turn' };
  const a = fakeReqRes(body, { authorization: 'Bearer ' + VALID_TOKEN });
  await sessionTurn(a.req, a.res);
  const b = fakeReqRes(body, { authorization: 'Bearer ' + VALID_TOKEN });
  await sessionTurn(b.req, b.res);
  assert.equal(a.res.statusCode, 200);
  assert.equal(b.res.statusCode, 200);
  assert.equal(b.res.body.cached, true);
  assert.equal(geminiModule.callGemini.mock.callCount() - before, 1);
  const rows = fakeDb._store.get('messages') || [];
  assert.equal(rows.filter(r => r.session_id === 'session-idem' && r.client_turn_id === 'same-turn').length, 1);
});


test('session-turn: clamps an out-of-range masteryDelta from Gemini instead of trusting it as-is', async () => {
  // Simulates Gemini disobeying the prompt's stated -0.1..0.2 range —
  // the endpoint must defend against this itself, not just hope.
  geminiResponse = JSON.stringify({
    aiMessage: 'برافو عليك!', verdict: 'correct', mistakeCategory: null,
    sessionComplete: true, masteryDelta: 5 // way outside the documented range
  });
  const { req, res } = fakeReqRes(
    { subjectLabel: 'رياضيات', topic: 'جبر', action: 'answer', studentAnswer: 'x = 6', history: [], sessionId: seedSession(), turnId: 'turn-clamp' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await sessionTurn(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.masteryDelta <= 0.2, `masteryDelta ${res.body.masteryDelta} should be clamped to <= 0.2`);
});

test('session-turn: rejects an answer over the length limit before touching Gemini', async () => {
  const callsBefore = geminiModule.callGemini.mock.callCount();
  const { req, res } = fakeReqRes(
    { subjectLabel: 'رياضيات', topic: 'جبر', action: 'answer', studentAnswer: 'س'.repeat(3000), history: [], sessionId: seedSession(), turnId: 'turn-long' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await sessionTurn(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(geminiModule.callGemini.mock.callCount(), callsBefore);
});

test('generate-exam: strict unit mode refuses questions outside requested topics', async () => {
  fakeDb._store.set('profiles', [{ id: 'my-profile', user_id: USER_ID }]);
  geminiResponse = JSON.stringify({
    questions: [
      { type: 'mcq', text: 'سؤال من موضوع آخر', options: ['أ','ب','ج','د'], correctIndex: 0, topic: 'موضوع مختلف' },
      { type: 'mcq', text: 'سؤال صحيح', options: ['أ','ب','ج','د'], correctIndex: 1, topic: 'جبر' },
      { type: 'mcq', text: 'سؤال صحيح', options: ['أ','ب','ج','د'], correctIndex: 2, topic: 'جبر' }
    ]
  });
  const { req, res } = fakeReqRes(
    { profileId: 'my-profile', subjectLabel: 'رياضيات', topics: ['جبر'], count: 3, strictUnit: true },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await generateExam(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'unit_boundary_violation');
});

// --- analyze-image ---

const TINY_BASE64 = Buffer.from('fake-image-bytes').toString('base64');

test('analyze-image: rejects an unsupported mime type before calling Gemini', async () => {
  const callsBefore = geminiModule.callGemini.mock.callCount();
  const { req, res } = fakeReqRes(
    { imageBase64: TINY_BASE64, mimeType: 'image/gif' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeImage(req, res);
  assert.equal(res.statusCode, 415);
  assert.equal(geminiModule.callGemini.mock.callCount(), callsBefore);
});

test('analyze-image: happy path returns a bounded classification', async () => {
  geminiResponse = JSON.stringify({
    readable: true, extractedText: 'حل المعادلة 2x + 3 = 7',
    subject: 'math', subjectLabel: 'رياضيات', topic: 'معادلات', intent: 'solve'
  });
  const { req, res } = fakeReqRes(
    { imageBase64: TINY_BASE64, mimeType: 'image/png' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeImage(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.readable, true);
  assert.equal(res.body.subject, 'math');
});

test('analyze-image: unreadable image is accepted without a classification', async () => {
  geminiResponse = JSON.stringify({ readable: false, extractedText: 'الصورة مش واضحة، جرب تصوّرها تاني بإضاءة أحسن' });
  const { req, res } = fakeReqRes(
    { imageBase64: TINY_BASE64, mimeType: 'image/png' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeImage(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.readable, false);
});

test('analyze-image: falls back gracefully instead of trusting an out-of-range Gemini output', async () => {
  // subject not in the allowed list — must NOT pass through to the client as-is.
  geminiResponse = JSON.stringify({
    readable: true, extractedText: 'x', subject: 'history', subjectLabel: 'تاريخ', topic: 'شيء', intent: 'solve'
  });
  const { req, res } = fakeReqRes(
    { imageBase64: TINY_BASE64, mimeType: 'image/png' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await analyzeImage(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fallback, true);
  assert.equal(res.body.readable, false);
});

// --- detect-mistake ---

test('detect-mistake: rejects an oversized attempt before ever touching Gemini', async () => {
  const callsBefore = geminiModule.callGemini.mock.callCount();
  const { req, res } = fakeReqRes(
    { question: 'حل 2x=8', attempt: 'أ'.repeat(5000) },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await detectMistake(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(geminiModule.callGemini.mock.callCount(), callsBefore);
});

test('detect-mistake: happy path returns a bounded category and fields', async () => {
  geminiResponse = JSON.stringify({
    category: 'SIGN_ERROR', firstStep: 'قلبت الإشارة غلط', why: 'نسيت تقلب الإشارة لما نقلت الحد',
    tiny: 'لما تنقل حد لجهة تانية بتقلب إشارته', practice: 'حل -3x + 4 = 10'
  });
  const { req, res } = fakeReqRes(
    { question: 'حل 2x + 5 = 17', attempt: '2x = 17 + 5' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await detectMistake(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.category, 'SIGN_ERROR');
});

test('detect-mistake: falls back gracefully when Gemini returns a field over the length bound', async () => {
  geminiResponse = JSON.stringify({
    category: 'SIGN_ERROR', firstStep: 'س'.repeat(2000), why: 'سبب', tiny: 'شرح', practice: 'تدريب'
  });
  const { req, res } = fakeReqRes(
    { question: 'حل 2x + 5 = 17', attempt: '2x = 17 - 5' },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await detectMistake(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fallback, true);
});

// --- score-exam: including the short_answer judging round-trip ---
test('score-exam: refuses to score an exam that is not the caller\'s', async () => {
  fakeDb._store.set('exam_sessions', [{ id: 'exam1', user_id: 'someone-else' }]);
  const { req, res } = fakeReqRes(
    { examSessionId: 'exam1', answers: [] },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await scoreExam(req, res);
  assert.equal(res.statusCode, 403);
});

test('score-exam: judges a short_answer question via Gemini and scores it correctly', async () => {
  fakeDb._store.set('exam_sessions', [{ id: 'exam2', user_id: USER_ID }]);
  fakeDb._store.set('exam_questions', [
    { id: 'q1', exam_session_id: 'exam2', text: 'إيه قانون نيوتن الثاني؟', type: 'short_answer', correct_answer: 'F = m * a', topic: 'فيزياء', options: null, correct_index: null }
  ]);
  geminiResponse = JSON.stringify({ correct: true });
  const { req, res } = fakeReqRes(
    { examSessionId: 'exam2', answers: [{ questionId: 'q1', textAnswer: 'القوة تساوي الكتلة في التسارع' }] },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await scoreExam(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.score, 1);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.mistakes.length, 0);
});

test('score-exam: a short_answer question judged incorrect by Gemini shows up as a mistake', async () => {
  fakeDb._store.set('exam_sessions', [{ id: 'exam3', user_id: USER_ID }]);
  fakeDb._store.set('exam_questions', [
    { id: 'q1', exam_session_id: 'exam3', text: 'إيه قانون نيوتن الثاني؟', type: 'short_answer', correct_answer: 'F = m * a', topic: 'فيزياء', options: null, correct_index: null }
  ]);
  geminiResponse = JSON.stringify({ correct: false });
  const { req, res } = fakeReqRes(
    { examSessionId: 'exam3', answers: [{ questionId: 'q1', textAnswer: 'مش عارف' }] },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await scoreExam(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.score, 0);
  assert.equal(res.body.mistakes[0].correctAnswer, 'F = m * a');
});

test('score-exam: refuses to re-score an exam that already has a finished_at', async () => {
  fakeDb._store.set('exam_sessions', [{ id: 'exam4', user_id: USER_ID, finished_at: new Date().toISOString(), score: 1, total: 1 }]);
  fakeDb._store.set('exam_questions', [
    { id: 'q1', exam_session_id: 'exam4', text: 'ما القوة؟', type: 'mcq', options: ['أ', 'ب', 'ج', 'د'], correct_index: 0, topic: 'فيزياء' }
  ]);
  const { req, res } = fakeReqRes(
    { examSessionId: 'exam4', answers: [{ questionId: 'q1', selectedIndex: 0 }] },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  await scoreExam(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'exam_already_scored');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(typeof res.body.requestId, 'string');
});

test('score-exam: two concurrent submits for the same unfinished session — exactly one wins, no duplicate exam_answers', async () => {
  fakeDb._store.set('exam_sessions', [{ id: 'exam5', user_id: USER_ID }]);
  fakeDb._store.set('exam_questions', [
    { id: 'q1', exam_session_id: 'exam5', text: 'ما القوة؟', type: 'mcq', options: ['أ', 'ب', 'ج', 'د'], correct_index: 0, topic: 'فيزياء' }
  ]);
  const makeReqRes = () => fakeReqRes(
    { examSessionId: 'exam5', answers: [{ questionId: 'q1', selectedIndex: 0 }] },
    { authorization: 'Bearer ' + VALID_TOKEN }
  );
  const a = makeReqRes();
  const b = makeReqRes();
  // Fire both "at the same time" (interleaved microtasks), the way a
  // double-click or a retried request actually arrives in production.
  await Promise.all([scoreExam(a.req, a.res), scoreExam(b.req, b.res)]);

  const statuses = [a.res.statusCode, b.res.statusCode].sort();
  assert.deepEqual(statuses, [200, 409]);

  const answerRows = fakeDb._store.get('exam_answers') || [];
  assert.equal(answerRows.filter(r => r.exam_session_id === 'exam5').length, 1);
});
