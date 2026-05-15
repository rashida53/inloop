require('dotenv').config();
require('express-async-errors');
const express = require('express');
const morgan = require('morgan');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db');
const healthRoutes = require('./routes/health');
const zoomWebhooks = require('./webhooks/zoom');
const { captureRawBody, createZoomSignatureVerification } = require('./webhooks/verify');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Global middleware
app.use(morgan('combined'));
app.use(pinoHttp({ logger }));

// Zoom webhook route: must capture raw body BEFORE JSON parsing
app.post(
  '/webhooks/zoom',
  captureRawBody,
  express.json({ limit: '1mb' }),
  createZoomSignatureVerification(config.zoomVerificationToken),
  zoomWebhooks
);

// All other routes: standard JSON parsing
app.use(express.json({ limit: '1mb' }));

app.use('/health', healthRoutes);

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
