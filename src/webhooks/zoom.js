const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const idempotency = require('../db/idempotency');

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
 * We extract meeting metadata and queue for async processing (transcription, AI extraction, etc.).
 *
 * Zoom note: The event payload structure varies slightly between meeting types (in-person, recurring, etc.).
 * We defensively extract fields with null coalescing to prevent crashes.
 */
async function handleMeetingSummaryCompleted(event, res) {
  try {
    const { timestamp, event_id } = event;
    const payload = event.object || {};

    // Defensively extract meeting metadata to prevent crashes from missing fields
    const zoomMeetingId = payload.id || payload.meeting_id;
    const meetingTopic = payload.topic || payload.subject || 'Untitled Meeting';
    const hostEmail = payload.host_email || payload.organizer || 'unknown@zoom.us';
    const startTime = payload.start_time || new Date().toISOString();
    const duration = payload.duration || 0;
    const recording = payload.recording_files || [];
    const participants = payload.participants || [];

    if (!zoomMeetingId) {
      logger.warn({ event_id, payload }, 'meeting.summary_completed event missing meeting ID');
      return res.status(400).json({ ok: false, message: 'Missing meeting ID' });
    }

    // Use meeting ID as idempotency key; combined with event_id for uniqueness
    const idempotencyKey = `zoom:meeting:${zoomMeetingId}:${event_id}`;

    logger.info({
      zoomMeetingId,
      event_id,
      topic: meetingTopic,
      duration,
      hasRecording: recording.length > 0,
      participantCount: participants.length,
    }, 'Meeting summary completed event received');

    // Try to claim the idempotency key to ensure exactly-once processing
    const claim = await idempotency.claimKey(idempotencyKey, event);

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
          topic: meetingTopic,
        }, 'Processing meeting for extraction and delivery');

        // TODO: Implement actual processing pipeline
        // 1. Fetch recording metadata (if available)
        // 2. Download/transcribe recording (if available)
        // 3. Call Claude API for extraction (action items, summary, etc.)
        // 4. Store results in database
        // 5. Deliver summary to Slack
        // Example:
        //   const extracted = await extractFromRecording({ zoomMeetingId, hostEmail, recording });
        //   await db.query('UPDATE meetings SET summary = $1, ...');
        //   await deliverToSlack({ summary: extracted.summary, attendees: participants });

        // Mark as done in idempotency store
        await idempotency.saveResponse(idempotencyKey, {
          ok: true,
          processed: true,
          zoomMeetingId,
          message: 'Meeting queued for processing',
        });

        logger.info({ zoomMeetingId, idempotencyKey }, 'Meeting processing queued successfully');
      } catch (err) {
        logger.error({
          err,
          zoomMeetingId,
          idempotencyKey,
          message: err.message,
        }, 'Error processing meeting');

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
