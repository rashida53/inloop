const { WebClient } = require('@slack/web-api');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Shared Slack WebClient instance.
 *
 * All Slack-touching modules (delivery, user directory, etc.) should
 * import from here rather than constructing their own — one client
 * means one token, one connection pool, one place to swap auth.
 *
 * Required Slack OAuth bot scopes:
 *   - chat:write             (post digests)
 *   - im:write               (open DMs to users)
 *   - users:read             (read user objects)
 *   - users:read.email       (look up users by email — required for the
 *                              host-email → slack_id resolution path)
 */
const slackClient = new WebClient(config.slackBotToken, { logger });

module.exports = { slackClient };
