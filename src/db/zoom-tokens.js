const db = require('./index');

const TOKEN_COLUMNS = 'account_id, access_token, refresh_token, token_type, scope, expires_at, created_at, updated_at';

/**
 * Find the persisted OAuth token row for a Zoom account.
 *
 * @param {string} accountId - Zoom account ID
 * @returns {Promise<object|null>} - The token row or null if no install
 *   has been recorded for this account.
 */
async function findByAccountId(accountId) {
  if (!accountId) return null;
  const result = await db.query(
    `SELECT ${TOKEN_COLUMNS} FROM zoom_account_tokens WHERE account_id = $1 LIMIT 1`,
    [accountId],
    { name: 'zoom_tokens_find_by_account_id' }
  );
  return result.rows[0] || null;
}

/**
 * Upsert tokens for a Zoom account. Used on both first install and after
 * every refresh — Zoom rotates refresh_token on each refresh, so always
 * write back whatever Zoom most recently returned.
 *
 * @param {string} accountId
 * @param {object} tokens - { access_token, refresh_token, token_type, scope, expires_at }
 * @returns {Promise<object>} - The upserted row.
 */
async function upsert(accountId, tokens) {
  if (!accountId) throw new Error('upsert: accountId is required');
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error('upsert: tokens must include access_token and refresh_token');
  }

  const result = await db.query(
    `
    INSERT INTO zoom_account_tokens
      (account_id, access_token, refresh_token, token_type, scope, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (account_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      token_type = EXCLUDED.token_type,
      scope = EXCLUDED.scope,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
    RETURNING ${TOKEN_COLUMNS}
    `,
    [
      accountId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.token_type || null,
      tokens.scope || null,
      tokens.expires_at,
    ],
    { name: 'zoom_tokens_upsert' }
  );

  return result.rows[0];
}

module.exports = { findByAccountId, upsert };
