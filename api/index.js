'use strict';

// Single Vercel function router for Hobby-plan deployments.
// Endpoint implementations live in lib/endpoints so the public URLs remain
// unchanged while the deployment contains one serverless function.
const handlers = {
  'analyze-image': require('../lib/endpoints/analyze-image'),
  'analyze-question': require('../lib/endpoints/analyze-question'),
  benchmark: require('../lib/endpoints/benchmark'),
  config: require('../lib/endpoints/config'),
  'detect-mistake': require('../lib/endpoints/detect-mistake'),
  'export-data': require('../lib/endpoints/export-data'),
  'generate-exam': require('../lib/endpoints/generate-exam'),
  health: require('../lib/endpoints/health'),
  metrics: require('../lib/endpoints/metrics'),
  'question-workflow': require('../lib/endpoints/question-workflow'),
  report: require('../lib/endpoints/report-content'),
  research: require('../lib/endpoints/research'),
  'score-exam': require('../lib/endpoints/score-exam'),
  'session-turn-stream': require('../lib/endpoints/session-turn-stream'),
  'session-turn': require('../lib/endpoints/session-turn'),
  'track-event': require('../lib/endpoints/track-event')
};

function routeName(req) {
  const parsed = new URL(req.url || '/', 'http://localhost');
  const fromRewrite = parsed.searchParams.get('route');
  if (fromRewrite) return fromRewrite.replace(/^\/+|\/+$/g, '');
  const match = parsed.pathname.match(/^\/api\/(.+?)(?:\.js)?\/?$/);
  return match ? match[1] : '';
}

module.exports = async function apiRouter(req, res) {
  const route = routeName(req);
  const handler = handlers[route];
  if (!handler) return res.status(404).json({ error: 'not_found', message: 'المسار غير موجود.' });
  return handler(req, res);
};
