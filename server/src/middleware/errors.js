const { ApiError } = require('../lib/http');

function notFoundRoute(req, res) {
  res.status(404).json({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ code: err.code, message: err.message, data: { status: err.status, ...err.data } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'rest_invalid_json', message: 'Invalid JSON body passed.', data: { status: 400 } });
  }
  // Prisma known errors
  if (err.code === 'P2002') {
    const field = (err.meta && err.meta.target) || 'field';
    return res.status(400).json({ code: 'rest_duplicate', message: `A resource with this ${field} already exists.`, data: { status: 400 } });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ code: 'rest_invalid_id', message: 'Invalid ID.', data: { status: 404 } });
  }
  console.error(err);
  return res.status(500).json({ code: 'internal_server_error', message: 'There has been a critical error.', data: { status: 500 } });
}

module.exports = { notFoundRoute, errorHandler };
