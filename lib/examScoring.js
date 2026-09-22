// lib/examScoring.js
// Pure function: given the real questions (mcq with correct_index, or
// short_answer with correct_answer + a pre-computed judgedCorrect flag) and
// the submitted answers, compute the score, per-topic breakdown, and
// mistake list. No I/O and no Gemini call here — that's what keeps this
// testable in isolation (see tests/unit.test.js). For short_answer
// questions, the caller (api/score-exam.js) is responsible for judging
// correctness via Gemini BEFORE calling this, and attaching the result as
// `judgedCorrect` on the matching answer.

/**
 * @param {Array<{id, text, type, options, correct_index, correct_answer, topic}>} questions
 * @param {Array<{questionId, selectedIndex?, textAnswer?, judgedCorrect?}>} answers
 * @returns {{ score, total, breakdown, mistakes, answerRows }}
 */
function computeExamResult(questions, answers) {
  const answeredById = Object.fromEntries((answers || []).map(a => [a.questionId, a]));
  const topicTally = {};
  const mistakes = [];
  const answerRows = [];
  let score = 0;

  for (const q of questions) {
    const answer = answeredById[q.id];
    const hasAnswer = Boolean(answer && (answer.selectedIndex !== undefined && answer.selectedIndex !== null || answer.textAnswer));
    const correct = determineCorrectness(q, answer, hasAnswer);
    if (correct) score++;

    topicTally[q.topic] = topicTally[q.topic] || { correct: 0, total: 0 };
    topicTally[q.topic].total++;
    if (correct) topicTally[q.topic].correct++;

    if (!correct) {
      mistakes.push({
        question: q.text,
        yourAnswer: describeYourAnswer(q, answer, hasAnswer),
        correctAnswer: q.type === 'short_answer' ? q.correct_answer : q.options[q.correct_index],
        topic: q.topic
      });
    }
    answerRows.push({
      question_id: q.id,
      selected_index: q.type === 'mcq' ? (answer ? answer.selectedIndex : null) : null,
      is_correct: correct
    });
  }

  const breakdown = Object.entries(topicTally).map(([topic, t]) => ({ topic, correct: t.correct, total: t.total }));

  return { score, total: questions.length, breakdown, mistakes, answerRows };
}

function determineCorrectness(q, answer, hasAnswer) {
  if (!hasAnswer) return false;
  if (q.type === 'short_answer') return Boolean(answer.judgedCorrect);
  return q.correct_index === answer.selectedIndex;
}

function describeYourAnswer(q, answer, hasAnswer) {
  if (!hasAnswer) return '(من غير إجابة — انتهى الوقت)';
  if (q.type === 'short_answer') return answer.textAnswer;
  return q.options[answer.selectedIndex] ?? '(اختيار غير معروف)';
}

module.exports = { computeExamResult };
