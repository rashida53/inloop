const db = require('./index');

const TOKEN_COLUMNS =
  'org_id, access_token, refresh_token, instance_url, token_type, scope, identity_url, login_url, expires_at, created_at, updated_at';

/**
 * Find the persisted OAuth token row for a Salesforce org.
 *
 * @param {string} orgId - Salesforce 18-char organization ID
 * @returns {Promise<object|null>} - The token row or null if no install
 *   has been recorded for this org.
 */
async function findByOrgId(orgId) {
  if (!orgId) return null;
  const result = await db.query(
    `SELECT ${TOKEN_COLUMNS} FROM salesforce_org_tokens WHERE org_id = $1 LIMIT 1`,
    [orgId],
    { name: 'salesforce_tokens_find_by_org_id' }
  );
  return result.rows[0] || null;
}

/**
 * Find the most-recently-installed Salesforce org's tokens.
 *
 * Convenience for the MVP single-org case: rather than threading
 * org_id through every caller, we let the API client pick "the org" —
 * which is whichever one most recently installed the Connected App.
 * Once we support multi-org installs this should be removed in favor
 * of explicit findByOrgId lookups.
 *
 * @returns {Promise<object|null>}
 */
async function findCurrent() {
  const result = await db.query(
    `SELECT ${TOKEN_COLUMNS} FROM salesforce_org_tokens ORDER BY updated_at DESC LIMIT 1`,
    [],
    { name: 'salesforce_tokens_find_current' }
  );
  return result.rows[0] || null;
}

/**
 * Upsert tokens for a Salesforce org. Used on both first install and
 * after every refresh.
 *
 * Salesforce refresh tokens are long-lived (org admin controls TTL,
 * default ~90 days inactivity) and don't rotate on every refresh —
 * but we still write the full row in case the org enables rotation.
 *
 * @param {string} orgId
 * @param {object} tokens - { access_token, refresh_token, instance_url,
 *   token_type, scope, identity_url, login_url, expires_at }
 * @returns {Promise<object>} - The upserted row.
 */
async function upsert(orgId, tokens) {
  if (!orgId) throw new Error('upsert: orgId is required');
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error('upsert: tokens must include access_token and refresh_token');
  }
  if (!tokens?.instance_url) {
    throw new Error('upsert: tokens must include instance_url');
  }

  const result = await db.query(
    `
    INSERT INTO salesforce_org_tokens
      (org_id, access_token, refresh_token, instance_url, token_type, scope, identity_url, login_url, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (org_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      instance_url = EXCLUDED.instance_url,
      token_type = EXCLUDED.token_type,
      scope = EXCLUDED.scope,
      identity_url = EXCLUDED.identity_url,
      login_url = EXCLUDED.login_url,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
    RETURNING ${TOKEN_COLUMNS}
    `,
    [
      orgId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.instance_url,
      tokens.token_type || null,
      tokens.scope || null,
      tokens.identity_url || null,
      tokens.login_url || 'https://login.salesforce.com',
      tokens.expires_at,
    ],
    { name: 'salesforce_tokens_upsert' }
  );

  return result.rows[0];
}

module.exports = { findByOrgId, findCurrent, upsert };
