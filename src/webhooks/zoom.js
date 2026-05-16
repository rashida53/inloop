const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const idempotency = require('../db/idempotency');
const { adaptZoomPayload } = require('../adapters/zoom-adapter');

/**
 * Production-grade Zoom webhook handler for Express.
 *
 * Zoom webhook event types handled:
 * 1. endpoint.url_validation: Zoom's challenge-response to verify endpoint ownership.
 *    Zoom sends a challenge and expects us to echo it back in a specific format.
 *    This is NOT idempotent and should return immediately with 200 OK.
 *
 * 2. meeting.summary_completed: Meeting details are ready for processing.
 *    This is the event we care about; process async and return 202 Accepted.
 *    Use idempotency to ensure exactly-once processing.
 *
 * Security considerations:
 * - HMAC-SHA256 signature verification (timing-safe comparison)
 * - Timestamp validation (reject events older than 5 minutes)
 * - Payload sanitization to prevent crashes from malformed data
 * - Structured logging of all security events
 * - Async processing to keep response times low
 */

/**
 * Handle endpoint.url_validation events.
 * Zoom sends this to verify the webhook endpoint before enabling webhooks.
 * We must echo back the challenge in the required format.
 *
 * Zoom note: This is a special case that doesn't need idempotency.
 * It's a one-time challenge during setup, not a repeated event.
 */
function handleUrlValidation(event, res) {
  try {
    const challenge = event.payload?.validationToken || event.challenge;
    if (!challenge) {
      logger.warn({ event }, 'url_validation event missing challenge or validationToken');
      return res.status(400).json({ ok: false, message: 'Missing challenge' });
    }

    logger.info({ challenge: challenge.substring(0, 10) }, 'Zoom endpoint validation challenge received');

    // Return challenge in the required format for Zoom to validate endpoint
    res.status(200).json({
      plainTextToken: challenge,
    });
  } catch (err) {
    logger.error({ err, event }, 'Error handling url_validation');
    res.status(500).json({ ok: false, message: 'Internal error' });
  }
}

/**
 * Handle meeting.summary_completed events.
 * This event indicates a meeting has completed and summary/recording info is available.
 * We normalize the payload via the adapter, then queue for async processing.
 *
 * Zoom note: The event payload structure varies slightly between meeting types (in-person, recurring, etc.).
 * The adapter handles all defensive extraction and normalization.
 */
async function handleMeetingSummaryCompleted(event, res) {
  try {
    const { timestamp, event_id } = event;
    const payload = event.object || {};

    // Normalize and validate the Zoom payload using the adapter
    // This single call handles all extraction, validation, field normalization, and error handling
    const meetingSummary = adaptZoomPayload(payload, event_id);

    if (!meetingSummary) {
      logger.error({ event_id, payload: JSON.stringify(payload).substring(0, 200) }, 
        'Failed to adapt Zoom payload; invalid or missing required fields');
      return res.status(400).json({ ok: false, message: 'Invalid meeting data' });
    }

    const { zoomMeetingId, title, hostEmail, attendeeCount, hasRecording, warnings } = meetingSummary;

    // Create idempotency key from normalized data
    const idempotencyKey = `zoom:meeting:${zoomMeetingId}:${event_id}`;

    logger.info({
      zoomMeetingId,
      title,
      hostEmail,
      attendeeCount,
      hasRecording,
      dataQualityWarnings: warnings.length,
      eventId: event_id,
    }, 'Meeting summary completed - payload adapted successfully');

    // Try to claim the idempotency key to ensure exactly-once processing
    const claim = await idempotency.claimKey(idempotencyKey, meetingSummary);

    // If not claimed, this meeting is either already processed or being processed
    if (!claim.claimed) {
      const { status, response } = claim.existing;
      logger.info({
        zoomMeetingId,
        idempotencyKey,
        status,
      }, 'Meeting already processed or processing');

      if (status === 'done' && response) {
        return res.status(200).json(response);
      }
      if (status === 'processing') {
        return res.status(202).json({ ok: true, message: 'Already processing' });
      }
      if (status === 'failed') {
        return res.status(409).json({ ok: false, message: 'Previous attempt failed' });
      }
    }

    // We claimed the key; queue for async processing and return immediately
    const acceptedResponse = {
      ok: true,
      idempotencyKey,
      zoomMeetingId,
      timestamp: new Date().toISOString(),
    };

    // Process asynchronously to keep HTTP response fast
    // This prevents Zoom from timing out and retrying the webhook
    setImmediate(async () => {
      try {
        logger.info({
          zoomMeetingId,
          idempotencyKey,
          title,
          attendeeCount,
        }, 'Processing meeting for extraction and delivery');

        // TODO: Implement extraction/delivery pipeline
        // Pass the normalized meetingSummary object to downstream handlers:
        // - extractFromRecording(meetingSummary): transcribe, extract with Claude
        // - persistToDatabase(meetingSummary): store in meetings table
        // - deliverToSlack(meetingSummary): send summary to relevant channels
        //
        // Example:
        //   const extracted = await extractFromRecording(meetingSummary);
        //   await db.query('INSERT INTO meetings (...) VALUES (...)', [...]
        //   await deliverToSlack(extracted);

        // Mark as done in idempotency store
        await idempotency.saveResponse(idempotencyKey, {
          ok: true,
          processed: true,
          zoomMeetingId,
          message: 'Meeting queued for extraction and delivery',
        });

        logger.info({ zoomMeetingId, idempotencyKey }, 'Meeting processing completed');
      } catch (err) {
        logger.error({
          err,
          zoomMeetingId,
          idempotencyKey,
          message: err.message,
        }, 'Error processing meeting in async handler');

        // Mark as failed in idempotency store so retries are allowed
        await idempotency.saveResponse(
          idempotencyKey,
          { ok: false, error: err.message },
          'failed',
          err.message
        );
      }
    });

    // Return 202 Accepted immediately; Zoom will retry if we don't respond in time
    res.status(202).json(acceptedResponse);
  } catch (err) {
    logger.error({ err, event }, 'Unhandled error in meeting.summary_completed');
    res.status(500).json({ ok: false, message: 'Internal error' });
  }
}

/**
 * Main Zoom webhook route.
 * Receives events from Zoom after HMAC verification and timestamp validation.
 * Routes to appropriate handler based on event type.
 *
 * Zoom sends events in this format:
 * {
 *   "event": "meeting.summary_completed",
 *   "event_id": "uuid",
 *   "timestamp": 1234567890,
 *   "payload": { ... event-specific data ... }
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const event = req.body || {};
    const eventType = event.event || 'unknown';

    logger.info({
      eventType,
      eventId: event.event_id,
      timestamp: event.timestamp,
    }, 'Zoom webhook event received');

    // Route to appropriate handler based on event type
    switch (eventType) {
      case 'endpoint.url_validation':
        return handleUrlValidation(event, res);

      case 'meeting.summary_completed':
        return handleMeetingSummaryCompleted(event, res);

      default:
        logger.debug({ eventType }, 'Unhandled Zoom event type; returning 202');
        // Return 202 for unknown events to prevent Zoom from retrying
        return res.status(202).json({ ok: true, message: 'Event received' });
    }
  } catch (err) {
    logger.error({ err, message: err.message }, 'Unhandled error in Zoom webhook');
    next(err);
  }
});

module.exports = router;
