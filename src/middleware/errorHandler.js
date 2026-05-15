const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
  try {
    logger.error({ err, path: req.path, message: err.message });
  } catch (e) {
    // swallow logging errors
  }
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || 'Internal Server Error' });
};
