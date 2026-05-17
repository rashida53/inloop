const { v4: uuidv4 } = require('uuid');

// Middleware to expose a stable correlation id on req.correlationId and
// attach it to the request logger (req.log). Assumes pino-http ran earlier
// and attached req.id and req.log.
module.exports = function correlationId(req, res, next) {
  try {
    const incoming = req.headers['x-request-id'];
    const id = req.id || incoming || uuidv4();
    req.correlationId = id;
    res.setHeader('X-Request-ID', id);

    // Promote the request logger to include correlationId
    if (req.log && typeof req.log.child === 'function') {
      req.log = req.log.child({ correlationId: id });
    }
  } catch (err) {
    // Do not fail requests if correlation binding fails
    // eslint-disable-next-line no-console
    console.warn('correlationId middleware error', err && err.message);
  }
  next();
};
