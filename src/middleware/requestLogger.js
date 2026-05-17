const pinoHttp = require('pino-http');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// Configure pino-http to integrate with the app's pino logger.
// genReqId will favor an incoming X-Request-ID header, otherwise generate one.
const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || uuidv4(),
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

module.exports = requestLogger;
