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
 * Returns { claimed: boolean, existing: { status, response, ownerId } | null }
 * If claimed=true, caller must process and call saveResponse().
 * If claimed=false, caller must return the cached response or wait for completion.
 */
async function claimKey(key, requestBody, ownerId = process.pid) {
  if (!key) throw new Error('Idempotency key is required');

  const requestHash = hashRequest(requestBody);
  const ttlSeconds = parseInt(process.env.IDEMPOTENCY_TTL || '300', 10);

  try {
    // Try to insert; if key exists, return the existing record
    const insertResult = await db.query(
      `
      INSERT INTO idempotency_keys (key, request_hash, status, owner_id, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 second' * $5)
      ON CONFLICT (key) DO NOTHING
      RETURNING key, status, response, owner_id;
      `,
      [key, requestHash, 'processing', ownerId, ttlSeconds],
      { name: 'idempotency_claim' }
    );

    if (insertResult.rows.length > 0) {
      // We claimed the key; proceed with processing
      logger.debug({ key }, 'Idempotency key claimed');
      return { claimed: true, existing: null };
    }

    // Key exists; fetch the record
    const existingResult = await db.query(
      `SELECT status, response, owner_id FROM idempotency_keys WHERE key = $1;`,
      [key],
      { name: 'idempotency_get' }
    );

    if (existingResult.rows.length === 0) {
      logger.warn({ key }, 'Idempotency key not found after conflict; retrying...');
      // Rare race condition; retry once
      return claimKey(key, requestBody, ownerId);
    }

    const record = existingResult.rows[0];
    logger.info({ key, status: record.status }, 'Idempotency key already exists');
    return {
      claimed: false,
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
