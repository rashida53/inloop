const db = require('./index');

const USER_COLUMNS = 'email, full_name, slack_id, created_at, updated_at';

/**
 * Look up a user by email address.
 *
 * @param {string} email - The user's email (primary key in the users table).
 * @returns {Promise<object|null>} - The user row or null if not found.
 */
async function findByEmail(email) {
  if (!email) return null;

  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 LIMIT 1`,
    [email],
    { name: 'users_find_by_email' }
  );

  return result.rows[0] || null;
}

/**
 * Look up a user by Slack ID.
 *
 * @param {string} slackId - The Slack user ID (e.g. "U01ABC123").
 * @returns {Promise<object|null>} - The user row or null if not found.
 */
async function findBySlackId(slackId) {
  if (!slackId) return null;

  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE slack_id = $1 LIMIT 1`,
    [slackId],
    { name: 'users_find_by_slack_id' }
  );

  return result.rows[0] || null;
}

/**
 * Cache a Slack user object as a row in the users table. Used by the
 * user directory after a successful Slack users.lookupByEmail so the
 * next webhook for the same host hits the DB instead of Slack.
 *
 * On conflict (the user already exists by email), updates slack_id and
 * full_name — useful if the user changed their name or was originally
 * inserted without a slack_id by another path.
 *
 * @param {object} slackUser - The `user` field from Slack's users.lookupByEmail.
 * @returns {Promise<object>} - The upserted user row.
 */
async function upsertFromSlackProfile(slackUser) {
  const email = slackUser?.profile?.email;
  if (!email) {
    throw new Error('upsertFromSlackProfile: slackUser.profile.email is required');
  }

  const fullName =
    slackUser.profile?.real_name ||
    slackUser.profile?.display_name ||
    slackUser.real_name ||
    slackUser.name ||
    null;

  const result = await db.query(
    `
    INSERT INTO users (email, full_name, slack_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET
      slack_id = EXCLUDED.slack_id,
      full_name = EXCLUDED.full_name,
      updated_at = NOW()
    RETURNING ${USER_COLUMNS}
    `,
    [email, fullName, slackUser.id],
    { name: 'users_upsert_from_slack_profile' }
  );

  return result.rows[0];
}

module.exports = { findByEmail, findBySlackId, upsertFromSlackProfile };
