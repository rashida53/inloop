const logger = require('../utils/logger');

// Centralized error handler that returns a consistent JSON shape.
module.exports = (err, req, res, next) => {
  try {
    const correlationId = req?.correlationId || req?.id || null;
    const status = err.status || err.statusCode || 500;

    // Structured logging with correlation
    logger.error({ err, path: req.path, correlationId, status }, 'Unhandled error');

    const safeMessage = err.expose ? err.message : (err.message || 'Internal Server Error');

    res.status(status).json({
      ok: false,
      error: {
        message: safeMessage,
        code: err.code || 'internal_error',
        correlationId,
        status,
      },
    });
  } catch (logErr) {
    // If error handling itself throws, fall back to a minimal response
    // eslint-disable-next-line no-console
    console.error('errorHandler failed', logErr);
    res.status(500).json({ ok: false, error: { message: 'Internal Server Error' } });
  }
};
