const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const idempotency = require('./db/idempotency');
const meetings = require('./db/meetings');
const userDirectory = require('./users');
const { adaptZoomPayload } = require('./adapters/zoom-adapter');
const { extractFromRecording } = require('./extraction');
const { deliverToSlack } = require('./delivery');

/**
 * processMeeting — orchestration entry point for one Zoom
 * meeting.summary_completed event.
 *
 * Pipeline (each stage timed into `metrics`):
 *
 *   1. adapt                 → MeetingSummary from raw Zoom payload
 *   2. claim                 → idempotency.claimKey (exactly-once per event_id)
 *   3. persistMeeting        → upsert audit row (captures raw event)
 *   4. duplicateGuard        → meetings.digest_sent_at check (cross-event_id)
 *   5. extract               → Claude meeting intelligence
 *   6. deliver (conditional) → Slack DM to host if internal + not yet sent
 *   7. saveResults           → write extraction + digest metadata
 *   8. finalize              → idempotency.saveResponse(done | skipped)
 *
 * Designed to be queue-friendly: input is plain JSON, no closures or
 * Express handles, all state lives in the database. To move processing
 * onto BullMQ/SQS/Pub-Sub, the producer enqueues `rawEvent` and the
 * consumer calls processMeeting(rawEvent); nothing else changes.
 */

function startStage(stageName) {
  return { stageName, start: Date.now() };
}

function endStage(timer, metrics) {
  if (!timer) return undefined;
  const duration = Date.now() - timer.start;
  metrics[timer.stageName] = duration;
  return duration;
}

async function processMeeting(rawEvent) {
  const correlationId = uuidv4();
  const log = logger.child({ correlationId, eventId: rawEvent?.event_id });
  const metrics = {};

  let meetingSummary = null;
  let host = null;
  let intelligence = null;
  let delivery = null;
  let idempotencyKey = null;

  const overallTimer = startStage('processMeeting');

  try {
    const adaptTimer = startStage('adaptZoomPayload');
    const rawPayload = rawEvent.payload || rawEvent.object || {};
    meetingSummary = adaptZoomPayload(rawPayload, rawEvent.event_id);
    endStage(adaptTimer, metrics);

    if (!meetingSummary) {
      throw new Error('Invalid Zoom event payload after adapter processing');
    }

    if (!rawEvent.event_id) {
      throw new Error('Zoom event is missing event_id');
    }

    log.info({ zoomMeetingId: meetingSummary.zoomMeetingId }, 'Meeting payload adapted');

    idempotencyKey = `zoom:meeting:${meetingSummary.zoomMeetingId}:${rawEvent.event_id}`;
    const claim = await idempotency.claimKey(idempotencyKey, rawEvent);

    if (!claim.claimed) {
      log.info(
        { idempotencyKey, existing: claim.existing },
        'Duplicate Zoom event detected; idempotency key already claimed'
      );
      return {
        correlationId,
        eventId: rawEvent.event_id,
        idempotencyKey,
        status: claim.existing?.status || 'unknown',
        cachedResponse: claim.existing?.response || null,
        metrics,
      };
    }

    const persistTimer = startStage('persistMeeting');
    host = await userDirectory.findByEmail(meetingSummary.hostEmail).catch((err) => {
      log.warn({ err: err.message, hostEmail: meetingSummary.hostEmail }, 'Unable to resolve meeting host to Slack user');
      return null;
    });

    await meetings.upsertFromWebhook(meetingSummary, rawEvent, {
      knownHostEmail: host?.email || null,
    });
    endStage(persistTimer, metrics);

    // Cross-event_id duplicate guard: the meetings row is the source of
    // truth for "has this meeting already been digested". A different
    // event_id for the same meeting (or a manual replay) won't double-DM.
    const guardTimer = startStage('duplicateGuard');
    const existingMeeting = await meetings.findByZoomId(meetingSummary.zoomMeetingId);
    endStage(guardTimer, metrics);

    if (existingMeeting?.digest_sent_at) {
      log.info(
        {
          zoomMeetingId: meetingSummary.zoomMeetingId,
          existingDigestTs: existingMeeting.digest_slack_ts,
          existingDigestSentAt: existingMeeting.digest_sent_at,
        },
        'Digest already sent for this meeting; skipping duplicate delivery'
      );
      const response = {
        ok: true,
        skipped: true,
        reason: 'duplicate_digest',
        existingDigestTs: existingMeeting.digest_slack_ts,
      };
      await idempotency.saveResponse(idempotencyKey, response, 'done');
      return { correlationId, eventId: rawEvent.event_id, idempotencyKey, ...response, metrics };
    }

    const extractTimer = startStage('extractMeetingIntelligence');
    intelligence = await extractFromRecording(meetingSummary);
    endStage(extractTimer, metrics);

    const slackUserId = host?.slack_id || null;

    if (slackUserId) {
      const deliveryTimer = startStage('sendSlackDigest');
      delivery = await deliverToSlack({
        meetingSummary,
        intelligence,
        target: { userId: slackUserId },
      });
      endStage(deliveryTimer, metrics);
    } else {
      log.info(
        { hostEmail: meetingSummary.hostEmail, hostInUsersTable: !!host },
        'Slack delivery skipped: host has no slack_id in users table'
      );
    }

    const updateTimer = startStage('updateMeetingDeliveryStatus');
    await meetings.saveExtractionAndDigest(meetingSummary.zoomMeetingId, intelligence, delivery);
    endStage(updateTimer, metrics);

    const result = {
      correlationId,
      eventId: rawEvent.event_id,
      idempotencyKey,
      ok: true,
      delivered: Boolean(delivery),
      digestTs: delivery?.ts || null,
      metrics,
    };

    await idempotency.saveResponse(idempotencyKey, result, 'done');

    log.info({ result }, 'Meeting pipeline completed successfully');
    return result;
  } catch (err) {
    log.error({ err, stage: 'processMeeting' }, 'Meeting pipeline failed');

    if (meetingSummary?.zoomMeetingId) {
      await meetings.recordError(meetingSummary.zoomMeetingId, err.message).catch((dbErr) => {
        log.error({ dbErr }, 'Failed to persist meeting failure metadata');
      });
    }

    if (idempotencyKey) {
      await idempotency.saveResponse(idempotencyKey, { ok: false, error: err.message }, 'failed', err.message).catch((saveErr) => {
        log.error({ saveErr }, 'Unable to save idempotency failure state');
      });
    }

    throw err;
  } finally {
    endStage(overallTimer, metrics);
    log.info({ metrics, durationMs: metrics.processMeeting }, 'processMeeting finished');
  }
}

module.exports = { processMeeting };
