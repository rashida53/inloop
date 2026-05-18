const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const config = require('../config');
const { processMeeting } = require('../server');

/**
 * Zoom webhook handler.
 *
 * Runs after HMAC + timestamp verification (see src/webhooks/verify.js).
 * Two event types are handled here:
 *
 *   - endpoint.url_validation: one-time setup challenge. Echo synchronously.
 *   - meeting.summary_completed: acknowledge with 202 immediately, then
 *     hand the raw event to the orchestrator (src/server.js) which owns
 *     adapt / idempotency / extract / deliver / persist.
 *
 * Everything else is acknowledged with 202 so Zoom doesn't retry; the
 * orchestrator is the boundary for all real processing logic.
 */

/**
 * Zoom Webhook Only apps use CRC validation: Zoom POSTs a plainToken and
 * expects back { plainToken, encryptedToken } where encryptedToken is
 * HMAC-SHA256(plainToken, secret_token) hex-encoded. The HMAC is computed
 * against ZOOM_VERIFICATION_TOKEN — the same secret Zoom uses to sign
 * regular events.
 *
 * Legacy fields (`validationToken` and top-level `challenge`) are accepted
 * as a fallback for older app shapes / tests that haven't migrated.
 */
function handleUrlValidation(event, res) {
  try {
    const plainToken =
      event.payload?.plainToken ||
      event.payload?.validationToken ||
      event.challenge;

    if (!plainToken) {
      logger.warn({ event }, 'url_validation event missing plainToken / validationToken');
      return res.status(400).json({ ok: false, message: 'Missing challenge token' });
    }

    if (!config.zoomVerificationToken) {
      logger.error('ZOOM_VERIFICATION_TOKEN is not configured; cannot complete CRC');
      return res.status(500).json({ ok: false, message: 'Server misconfiguration' });
    }

    const encryptedToken = crypto
      .createHmac('sha256', config.zoomVerificationToken)
      .update(plainToken)
      .digest('hex');

    logger.info(
      { plainTokenPrefix: plainToken.substring(0, 10) },
      'Zoom endpoint validation: responding with CRC'
    );

    return res.status(200).json({ plainToken, encryptedToken });
  } catch (err) {
    logger.error({ err, event }, 'Error handling url_validation');
    return res.status(500).json({ ok: false, message: 'Internal error' });
  }
}

/**
 * Acknowledge a meeting.summary_completed webhook and dispatch processing
 * to the orchestrator in the background. The orchestrator handles
 * idempotency, errors, and persistence — duplicate webhooks return 202
 * here and are short-circuited inside processMeeting.
 *
 * processMeeting catches its own errors and returns a result envelope.
 * The .catch() below is a safety net for programmer bugs that escape
 * its top-level try/catch — it should never fire in normal operation.
 */
function handleMeetingSummaryCompleted(event, res, correlationId) {
  const eventId = event.event_id;
  const zoomMeetingId = event.object?.id || event.object?.meeting_id || null;

  logger.info(
    { eventId, zoomMeetingId, correlationId },
    'Accepted meeting.summary_completed; dispatching to orchestrator'
  );

  // Hand the HTTP correlation ID down to the background pipeline so its
  // logs are joined to the synchronous response under one trace ID.
  setImmediate(() => {
    processMeeting(event, { correlationId }).catch((err) => {
      logger.error(
        { err, eventId, zoomMeetingId, correlationId },
        'processMeeting threw unexpectedly (programmer bug — should return envelope)'
      );
    });
  });

  return res.status(202).json({
    ok: true,
    eventId,
    correlationId,
    acceptedAt: new Date().toISOString(),
  });
}

/**
 * Main Zoom webhook route.
 *
 * Zoom sends events in this format:
 * {
 *   "event": "meeting.summary_completed",
 *   "event_id": "uuid",
 *   "timestamp": 1234567890,
 *   "object" | "payload": { ... event-specific data ... }
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const event = req.body || {};
    const eventType = event.event || 'unknown';

    logger.info(
      { eventType, eventId: event.event_id, timestamp: event.timestamp },
      'Zoom webhook event received'
    );

    switch (eventType) {
      case 'endpoint.url_validation':
        return handleUrlValidation(event, res);

      case 'meeting.summary_completed':
        return handleMeetingSummaryCompleted(event, res, req.correlationId);

      default:
        logger.debug({ eventType }, 'Unhandled Zoom event type; returning 202');
        // 202 prevents Zoom from retrying events we don't care about.
        return res.status(202).json({ ok: true, message: 'Event received' });
    }
  } catch (err) {
    logger.error({ err, message: err.message }, 'Unhandled error in Zoom webhook');
    next(err);
  }
});

module.exports = router;
