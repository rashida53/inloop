const db = require('./index');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/**
 * Generate a hash of the request for deduplication.
 * Useful for detecting if the same request was retried.
 */
function hashRequest(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * Claim an idempotency key for processing.
 *
 * Returns { claimed: boolean, reclaimed: boolean, existing: { status, response, ownerId } | null }
 *
 * - claimed=true, reclaimed=false → fresh claim, no prior attempt
 * - claimed=true, reclaimed=true  → took over a row whose previous attempt
 *                                   ended in status='failed'; safe to retry
 * - claimed=false                 → row exists with status='done' or
 *                                   'processing'; caller must return cached
 *                                   response or wait
 *
 * The reclaim path is what makes the orchestrator recoverable when the
 * pipeline crashes mid-flight (e.g. Postgres rejects a JSONB null byte and
 * saveResponse marks the key 'failed'). Without it, the same event_id can
 * never be retried without manual DB cleanup.
 *
 * Implementation: a single INSERT ... ON CONFLICT DO UPDATE with a WHERE
 * clause that only matches rows in 'failed' state. Postgres's xmax system
 * column tells us whether the returned row was newly inserted (xmax=0) or
 * updated from a prior 'failed' row (xmax!=0). Two concurrent reclaim
 * attempts serialize via row lock — only one can move 'failed' →
 * 'processing'; the other sees status='processing' and gets claimed=false.
 */
async function claimKey(key, requestBody, ownerId = process.pid) {
  if (!key) throw new Error('Idempotency key is required');

  const requestHash = hashRequest(requestBody);
  const ttlSeconds = parseInt(process.env.IDEMPOTENCY_TTL || '300', 10);

  try {
    const insertResult = await db.query(
      `
      INSERT INTO idempotency_keys (key, request_hash, status, owner_id, expires_at)
      VALUES ($1, $2, 'processing', $3, NOW() + INTERVAL '1 second' * $4)
      ON CONFLICT (key) DO UPDATE
        SET status = 'processing',
            request_hash = EXCLUDED.request_hash,
            owner_id = EXCLUDED.owner_id,
            expires_at = EXCLUDED.expires_at,
            response = NULL,
            error_message = NULL,
            attempt_count = idempotency_keys.attempt_count + 1,
            updated_at = NOW()
        WHERE idempotency_keys.status = 'failed'
      RETURNING key, status, response, owner_id, (xmax <> 0) AS reclaimed;
      `,
      [key, requestHash, ownerId, ttlSeconds],
      { name: 'idempotency_claim' }
    );

    if (insertResult.rows.length > 0) {
      const row = insertResult.rows[0];
      const reclaimed = row.reclaimed === true;
      if (reclaimed) {
        logger.warn(
          { key },
          'Idempotency key reclaimed from previously-failed attempt'
        );
      } else {
        logger.debug({ key }, 'Idempotency key claimed');
      }
      return { claimed: true, reclaimed, existing: null };
    }

    // Conflict and WHERE filter didn't match — row is 'done' or 'processing'.
    // Fetch it so the caller can return the cached response.
    const existingResult = await db.query(
      `SELECT status, response, owner_id FROM idempotency_keys WHERE key = $1;`,
      [key],
      { name: 'idempotency_get' }
    );

    if (existingResult.rows.length === 0) {
      // Rare: row was deleted (e.g. cleanup job) between the upsert and the
      // select. Retry once — the next attempt will see no row and insert.
      logger.warn({ key }, 'Idempotency key not found after conflict; retrying...');
      return claimKey(key, requestBody, ownerId);
    }

    const record = existingResult.rows[0];
    logger.info({ key, status: record.status }, 'Idempotency key already exists');
    return {
      claimed: false,
      reclaimed: false,
      existing: {
        status: record.status,
        response: record.response,
        ownerId: record.owner_id,
      },
    };
  } catch (err) {
    logger.error({ err, key }, 'Error claiming idempotency key');
    throw err;
  }
}

/**
 * Save the response for an idempotency key.
 * Should be called after processing is complete, whether successful or failed.
 */
async function saveResponse(key, response, status = 'done', errorMessage = null) {
  if (!key) throw new Error('Idempotency key is required');

  try {
    const updateResult = await db.query(
      `
      UPDATE idempotency_keys
      SET status = $2, response = $3, error_message = $4, updated_at = NOW(),
          attempt_count = attempt_count + 1
      WHERE key = $1
      RETURNING status;
      `,
      [key, status, JSON.stringify(response), errorMessage],
      { name: 'idempotency_save' }
    );

    if (updateResult.rows.length === 0) {
      logger.warn({ key }, 'Idempotency key not found when saving response');
      return;
    }

    logger.debug({ key, status }, 'Idempotency response saved');
  } catch (err) {
    logger.error({ err, key }, 'Error saving idempotency response');
    throw err;
  }
}

/**
 * Get a cached response for an idempotency key.
 * Returns the cached response if status is 'done'; null otherwise.
 */
async function getResponse(key) {
  if (!key) return null;

  try {
    const result = await db.query(
      `SELECT status, response FROM idempotency_keys WHERE key = $1;`,
      [key],
      { name: 'idempotency_get_response' }
    );

    if (result.rows.length === 0) {
      return null;
    }

    const record = result.rows[0];
    if (record.status !== 'done') {
      return null;
    }

    return record.response;
  } catch (err) {
    logger.error({ err, key }, 'Error getting idempotency response');
    throw err;
  }
}

/**
 * Delete expired idempotency keys.
 * Should be called periodically (e.g., by a background job).
 */
async function cleanupExpired() {
  try {
    const result = await db.query(
      `DELETE FROM idempotency_keys WHERE expires_at < NOW();`,
      [],
      { name: 'idempotency_cleanup' }
    );

    logger.info({ deletedCount: result.rowCount }, 'Idempotency keys cleaned up');
    return result.rowCount;
  } catch (err) {
    logger.error({ err }, 'Error cleaning up idempotency keys');
    throw err;
  }
}

module.exports = {
  claimKey,
  saveResponse,
  getResponse,
  cleanupExpired,
  hashRequest,
};
