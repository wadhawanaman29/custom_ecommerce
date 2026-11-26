// WordPress-style REST errors: { code, message, data: { status } }
class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const notFound = (code = 'rest_no_route', message = 'Invalid ID.') => new ApiError(404, code, message);
const badRequest = (code, message, data) => new ApiError(400, code, message, data);

// Wrap async route handlers so thrown errors reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Parse an integer route/query param; throws a WP-style 404 for invalid IDs.
function intParam(value, code = 'rest_invalid_id') {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(404, code, 'Invalid ID.');
  return n;
}

module.exports = { ApiError, notFound, badRequest, ah, intParam };
