const logger = require('../utils/logger');
const { slackClient } = require('../integrations/slack');
const usersDb = require('../db/users');

/**
 * User directory — resolves user identity from any signal we trust.
 *
 * Today the resolution chain for an email is:
 *   1. The local `users` table (DB cache).
 *   2. Slack's users.lookupByEmail (live directory).
 *      On a hit, the row is cached in `users` for future lookups.
 *      On a miss (`users_not_found`), returns null without caching —
 *      the email belongs to a guest, an external attendee, or someone
 *      not yet in the workspace.
 *
 * Failure modes:
 *   - `users_not_found` from Slack -> returns null (expected, not an error).
 *   - Any other Slack error (auth, rate limit, network) is logged and
 *     rethrown — the caller decides whether to fail the pipeline or skip.
 *
 * Requires the Slack bot token to have `users:read.email` scope.
 */

function isUserNotFoundError(err) {
  return err?.data?.error === 'users_not_found';
}

async function findByEmail(email) {
  if (!email) return null;

  const normalized = email.trim().toLowerCase();

  const cached = await usersDb.findByEmail(normalized);
  if (cached) return cached;

  let slackUser;
  try {
    const response = await slackClient.users.lookupByEmail({ email: normalized });
    if (!response.ok || !response.user) {
      logger.warn(
        { email: normalized, slackError: response.error },
        'Slack users.lookupByEmail returned non-ok response'
      );
      return null;
    }
    slackUser = response.user;
  } catch (err) {
    if (isUserNotFoundError(err)) {
      logger.info(
        { email: normalized },
        'Slack user not found for email; meeting host is external, a guest, or not in this workspace'
      );
      return null;
    }
    logger.error(
      { err, email: normalized, slackError: err?.data?.error },
      'Slack users.lookupByEmail failed'
    );
    throw err;
  }

  const cachedUser = await usersDb.upsertFromSlackProfile(slackUser);
  logger.info(
    { email: normalized, slackId: slackUser.id },
    'Cached new user from Slack directory'
  );
  return cachedUser;
}

module.exports = { findByEmail };
