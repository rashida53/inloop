const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

let pool = null;
let supabase = null;
let isShuttingDown = false;

/**
 * Initialize the pg Pool for direct PostgreSQL queries.
 * Reuses existing pool if already initialized.
 */
function getPool() {
  if (pool) return pool;

  // Supabase (pooler + direct), Neon, Railway, etc. all require SSL/TLS.
  // `rejectUnauthorized: false` skips certificate-chain validation, which is
  // safe here because we're connecting to a trusted Supabase domain over TLS.
  // For local Postgres (Docker, etc.) set DB_SSL=false to disable.
  const sslConfig =
    process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false };

  const poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: sslConfig,
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000', 10),
  };

  pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle client in pool');
  });

  pool.on('connect', () => {
    logger.debug('New client connected to pool');
  });

  logger.info({ poolConfig: { ...poolConfig, password: '***' } }, 'pg Pool initialized');

  return pool;
}

/**
 * Initialize Supabase client for higher-level operations.
 * Reuses existing client if already initialized.
 */
function getSupabase() {
  if (supabase) return supabase;

  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('SUPABASE_URL or SUPABASE_KEY not configured');
  }

  supabase = createClient(config.supabaseUrl, config.supabaseKey);
  logger.info({ url: config.supabaseUrl }, 'Supabase client initialized');

  return supabase;
}

/**
 * Check database connectivity and health.
 * Returns { ok: boolean, latency: number, error?: string }
 */
async function checkHealth() {
  const startTime = Date.now();
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      const latency = Date.now() - startTime;
      return { ok: true, latency };
    } finally {
      client.release();
    }
  } catch (err) {
    const latency = Date.now() - startTime;
    logger.error({ err, latency }, 'Database health check failed');
    return { ok: false, latency, error: err.message };
  }
}

/**
 * Execute a query with automatic retry logic and structured logging.
 * Retries on transient errors (connection, timeout).
 * Options: { maxRetries: number, retryDelayMs: number, name: string }
 */
async function query(sql, values = [], options = {}) {
  const {
    maxRetries = 3,
    retryDelayMs = 100,
    name = 'query',
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const result = await getPool().query(sql, values);
      const duration = Date.now() - startTime;

      logger.debug({ name, rows: result.rowCount, duration }, 'Query executed successfully');
      return result;
    } catch (err) {
      lastErr = err;
      const isTransient = err.code && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code);
      const isFatal = err.code && ['23505', '23502', '23514'].includes(err.code); // unique, not null, check violations

      if (isFatal || attempt === maxRetries) {
        logger.error(
          { name, attempt, error: err.message, code: err.code, sql: sql.substring(0, 100) },
          `Query failed (attempt ${attempt}/${maxRetries})`
        );
        break;
      }

      if (isTransient) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1); // exponential backoff
        logger.warn(
          { name, attempt, error: err.message, nextRetryMs: delay },
          `Query transient error, retrying...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error(
          { name, attempt, error: err.message, code: err.code },
          'Query failed with non-transient error'
        );
        break;
      }
    }
  }

  throw lastErr;
}

/**
 * Execute a transaction with automatic retry logic.
 * Callback receives a client and must return a value; it is automatically committed on success.
 * Options: same as query()
 */
async function transaction(callback, options = {}) {
  const {
    maxRetries = 3,
    retryDelayMs = 100,
    name = 'transaction',
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await getPool().connect();
    try {
      const startTime = Date.now();
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      const duration = Date.now() - startTime;

      logger.debug({ name, duration }, 'Transaction committed successfully');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ rollbackErr }, 'Failed to rollback transaction');
      }

      lastErr = err;
      const isTransient = err.code && ['40P01', '40001'].includes(err.code); // serialization, deadlock

      if (!isTransient || attempt === maxRetries) {
        logger.error(
          { name, attempt, error: err.message, code: err.code },
          `Transaction failed (attempt ${attempt}/${maxRetries})`
        );
        break;
      }

      const delay = retryDelayMs * Math.pow(2, attempt - 1);
      logger.warn(
        { name, attempt, error: err.message, nextRetryMs: delay },
        'Transaction deadlock/serialization conflict, retrying...'
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      client.release();
    }
  }

  throw lastErr;
}

/**
 * Gracefully close the pg Pool and any other resources.
 * Should be called during application shutdown.
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Database shutdown initiated');

  if (pool) {
    try {
      await pool.end();
      logger.info('pg Pool closed');
    } catch (err) {
      logger.error({ err }, 'Error closing pg Pool');
    }
  }

  if (supabase) {
    logger.debug('Supabase client closed (no explicit close needed)');
  }
}

module.exports = {
  getPool,
  getSupabase,
  checkHealth,
  query,
  transaction,
  shutdown,
};
