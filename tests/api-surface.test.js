const test = require('node:test');
const assert = require('node:assert/strict');

const endpoints = [
  'analyze-image','analyze-question','benchmark','config','detect-mistake',
  'export-data','generate-exam','health','metrics','question-workflow',
  'report-content','research','score-exam','session-turn','session-turn-stream','track-event'
];

test('all API endpoint modules are present and loadable', () => {
  for (const name of endpoints) {
    const handler = require(`../api/${name}.js`);
    assert.equal(typeof handler, 'function', `${name} must export a handler`);
  }
});
