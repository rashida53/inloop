const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
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

function handleUrlValidation(event, res) {
  try {
    const challenge = event.payload?.validationToken || event.challenge;
    if (!challenge) {
      logger.warn({ event }, 'url_validation event missing challenge or validationToken');
      return res.status(400).json({ ok: false, message: 'Missing challenge' });
    }

    logger.info(
      { challenge: challenge.substring(0, 10) },
      'Zoom endpoint validation challenge received'
    );

    return res.status(200).json({ plainTextToken: challenge });
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
function handleMeetingSummaryCompleted(event, res) {
  const eventId = event.event_id;
  const zoomMeetingId = event.object?.id || event.object?.meeting_id || null;

  logger.info(
    { eventId, zoomMeetingId },
    'Accepted meeting.summary_completed; dispatching to orchestrator'
  );

  setImmediate(() => {
    processMeeting(event).catch((err) => {
      logger.error(
        { err, eventId, zoomMeetingId },
        'processMeeting threw unexpectedly (programmer bug — should return envelope)'
      );
    });
  });

  return res.status(202).json({
    ok: true,
    eventId,
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
        return handleMeetingSummaryCompleted(event, res);

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
