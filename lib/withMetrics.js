const logger = require('./logger');
const { attachRequestId, normalizeError, isApiError, ServiceUnavailableError } = require('./apiResponse');
const { captureException } = require('./sentry');

function withMetrics(endpointName, handler) {
  return async (req, res) => {
    const start = Date.now();
    let statusCode = 200;
    let caughtError = null;
    const requestId = attachRequestId(req, res);

    const originalStatus = res.status.bind(res);
    const originalJson = res.json?.bind(res);
    res.status = (code) => { statusCode = code; return originalStatus(code); };

    if (originalJson) {
      res.json = (payload) => {
        if (isApiError(statusCode, payload)) {
          payload = normalizeError(statusCode, payload, req);
        }
        return originalJson(payload);
      };
    }

    try {
      await handler(req, res);
    } catch (err) {
      caughtError = err?.message || String(err);
      void captureException(err, { endpoint: endpointName, requestId });
      statusCode = err instanceof ServiceUnavailableError ? 503 : 500;
      if (!res.headersSent) {
        res.status(statusCode).json(normalizeError(
          statusCode,
          { code: err.code, message: err.message },
          req,
          statusCode === 503 ? 'الخدمة غير متاحة حاليًا. حاول مرة أخرى لاحقًا.' : 'حصل عطل غير متوقع.'
        ));
      }
    } finally {
      logger.recordRequest({ endpoint: endpointName, statusCode, durationMs: Date.now() - start, cached: Boolean(res._cached), error: caughtError, requestId });
    }
  };
}

module.exports = { withMetrics };
