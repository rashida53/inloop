require('dotenv').config();
require('express-async-errors');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db');
const healthRoutes = require('./routes/health');
const readyRoutes = require('./routes/ready');
const zoomWebhooks = require('./webhooks/zoom');
const zoomOauth = require('./webhooks/zoom-oauth');
const { captureRawBody, createZoomSignatureVerification } = require('./webhooks/verify');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const correlationId = require('./middleware/correlationId');

const app = express();

// Global middleware
// pino-http request logger (provides req.log, req.id and response timing)
app.use(requestLogger);

// Attach correlationId to req and bind into req.log
app.use(correlationId);

// Zoom webhook route. captureRawBody parses JSON AND exposes req.rawBody
// for HMAC signature verification in a single body-parser pass. The router
// itself only registers POST, so non-POST methods fall through to the 404
// handler — `app.use` is correct here despite accepting all methods, because
// it provides the path-stripping `zoomWebhooks` needs to match its `'/'`
// route. Method restriction is enforced inside the router.
app.use(
  '/webhooks/zoom',
  captureRawBody,
  createZoomSignatureVerification(config.zoomVerificationToken, config.zoomWebhookMaxAgeSeconds),
  zoomWebhooks
);

// All other routes: standard JSON parsing
app.use(express.json({ limit: '1mb' }));

app.use('/health', healthRoutes);
app.use('/ready', readyRoutes);
app.use('/oauth', zoomOauth);

app.use((req, res) => res.status(404).json({ ok: false, message: 'Not Found' }));
app.use(errorHandler);

const port = config.port || 3000;
const server = app.listen(port, () => logger.info({ port }, `InLoop server listening on ${port}`));

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(async () => {
    logger.info('HTTP server closed');
    await db.shutdown();
    logger.info('Database connections closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — initiating graceful shutdown');
  // Initiate graceful shutdown but do not call process.exit directly
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
  // Do not exit the process here; allow the app to continue running.
});
