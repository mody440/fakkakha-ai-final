const crypto = require('crypto');

function requestId(req) {
  if (req?.__requestId) return req.__requestId;
  const incoming = req?.headers?.['x-request-id'];
  const id = typeof incoming === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
  return id;
}

class ServiceUnavailableError extends Error {
  constructor(message = 'الخدمة غير متاحة حاليًا. حاول مرة أخرى لاحقًا.') {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.code = 'service_unavailable';
  }
}

function isApiError(status, payload) {
  return status >= 400 && status <= 599 && payload && typeof payload === 'object' && !Array.isArray(payload);
}

function normalizeError(status, payload, req, fallbackMessage = 'حدث خطأ غير متوقع.') {
  const id = requestId(req);
  const code = typeof payload?.code === 'string' ? payload.code
    : typeof payload?.error === 'string' ? payload.error
    : status === 503 ? 'service_unavailable'
    : status === 429 ? 'rate_limited'
    : status === 401 ? 'unauthenticated'
    : status === 403 ? 'forbidden'
    : status === 400 ? 'bad_request'
    : status === 404 ? 'not_found'
    : status === 405 ? 'method_not_allowed'
    : 'internal_error';
  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message
    : fallbackMessage;
  return { code, message, requestId: id };
}

function attachRequestId(req, res) {
  const id = requestId(req);
  res.setHeader?.('x-request-id', id);
  if (req) req.__requestId = id;
  return id;
}

module.exports = { requestId, attachRequestId, normalizeError, isApiError, ServiceUnavailableError };
