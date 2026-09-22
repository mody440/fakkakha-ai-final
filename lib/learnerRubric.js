function getLearnerRubric(age, gradeLabel) {
  const n = Number(age);
  let band = 'general';
  if (Number.isFinite(n)) {
    if (n < 13) band = 'under_13';
    else if (n < 16) band = '13_15';
    else if (n < 19) band = '16_18';
    else band = 'adult';
  }
  const rules = {
    under_13: 'Use very clear vocabulary, short sentences, define new terms, and avoid unnecessary abstraction.',
    '13_15': 'Use clear school-level vocabulary, explain technical terms briefly, and prefer short logical steps before formal detail.',
    '16_18': 'Use secondary-school/early academic vocabulary, preserve important technical terms, and explain assumptions when needed.',
    adult: 'Use precise academic vocabulary appropriate to the stated level; define specialized terms when ambiguity exists.',
    general: 'Use clear accessible language and adapt to the stated grade without assuming a curriculum.'
  };
  return `Learner age: ${Number.isFinite(n) ? n : 'not provided'}\nLearner grade: ${gradeLabel || 'not provided'}\nAge-band rubric: ${rules[band]}`;
}

module.exports = { getLearnerRubric };
