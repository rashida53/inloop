const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const idempotency = require('../db/idempotency');
const userDirectory = require('../users');
const meetings = require('../db/meetings');
const { adaptZoomPayload } = require('../adapters/zoom-adapter');
const { extractFromRecording } = require('../extraction');
const { deliverToSlack } = require('../delivery');

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
    setImmediate(() => {
      processMeetingAsync({ meetingSummary, event, idempotencyKey }).catch((err) => {
        logger.error(
          { err, zoomMeetingId, idempotencyKey },
          'processMeetingAsync escaped its own try/catch (should not happen)'
        );
      });
    });

    // Return 202 Accepted immediately; Zoom will retry if we don't respond in time
    res.status(202).json(acceptedResponse);
  } catch (err) {
    logger.error({ err, event }, 'Unhandled error in meeting.summary_completed');
    res.status(500).json({ ok: false, message: 'Internal error' });
  }
}

/**
 * Background pipeline for a single meeting.summary_completed event.
 * Runs after the 202 has been returned to Zoom.
 *
 * Steps (host-only-DM MVP):
 *   1. Look up the host in the users table (so we know whether to set
 *      host_email on the meeting row and whether to DM the host).
 *   2. Upsert the meeting record from the webhook payload. Captures the
 *      raw event for audit even if downstream steps fail.
 *   3. Extract intelligence via Claude. Today this throws "transcript
 *      required" because nothing upstream transcribes the recording yet —
 *      that gap surfaces here intentionally, which is the right place
 *      for it once the transcription step is wired in upstream of this
 *      pipeline.
 *   4. If the host is internal (found in users) and has a slack_id,
 *      post the digest DM. External-hosted meetings get extraction but
 *      no Slack delivery.
 *   5. Persist extraction results + digest metadata onto the meeting row.
 *   6. Resolve idempotency: done on success, failed on any throw so
 *      Zoom retries are honored.
 */
async function processMeetingAsync({ meetingSummary, event, idempotencyKey }) {
  const zoomMeetingId = meetingSummary.zoomMeetingId;
  const log = logger.child({ zoomMeetingId, idempotencyKey });

  try {
    log.info({ title: meetingSummary.title }, 'Processing meeting');

    const host = await userDirectory.findByEmail(meetingSummary.hostEmail);

    await meetings.upsertFromWebhook(meetingSummary, event, {
      knownHostEmail: host?.email || null,
    });

    const intelligence = await extractFromRecording(meetingSummary);

    let delivery = null;
    if (host?.slack_id) {
      delivery = await deliverToSlack({
        meetingSummary,
        intelligence,
        target: { userId: host.slack_id },
      });
    } else {
      log.info(
        { hostEmail: meetingSummary.hostEmail, hostInUsersTable: !!host },
        'Meeting host has no Slack account in users table; extraction completed but no DM sent'
      );
    }

    await meetings.saveExtractionAndDigest(zoomMeetingId, intelligence, delivery);

    await idempotency.saveResponse(idempotencyKey, {
      ok: true,
      processed: true,
      delivered: !!delivery,
      zoomMeetingId,
      digestTs: delivery?.ts || null,
    });

    log.info({ delivered: !!delivery, digestTs: delivery?.ts }, 'Meeting processing complete');
  } catch (err) {
    log.error({ err, message: err.message }, 'Error processing meeting');

    await meetings.recordError(zoomMeetingId, err.message).catch((dbErr) => {
      log.error({ dbErr }, 'Failed to record meeting error on row');
    });

    await idempotency.saveResponse(
      idempotencyKey,
      { ok: false, error: err.message },
      'failed',
      err.message
    );
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
