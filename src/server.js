const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const config = require('./config');
const idempotency = require('./db/idempotency');
const meetings = require('./db/meetings');
const userDirectory = require('./users');
const { adaptZoomEvent } = require('./adapters/zoom-adapter');
const { extractFromRecording } = require('./extraction');
const { deliverToSlack } = require('./delivery');
const zoomApi = require('./integrations/zoom-api');
const { parseVtt } = require('./utils/vtt-parser');

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

async function processMeeting(rawEvent, { correlationId: providedCorrelationId } = {}) {
  // Prefer an upstream-provided correlation ID (HTTP request ID from
  // pino-http via the correlationId middleware) so the synchronous webhook
  // logs and the async pipeline logs share one trace ID. Fall back to a
  // generated UUID when invoked outside an HTTP context (e.g., a future
  // queue worker, a backfill script, or a test).
  const correlationId = providedCorrelationId || uuidv4();
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
    // adaptZoomEvent dispatches on rawEvent.event — recording.transcript_completed
    // routes to the transcript adapter (extracts transcriptDownloadUrl + zoomAccountId);
    // anything else falls back to the legacy summary adapter.
    meetingSummary = adaptZoomEvent(rawEvent);
    endStage(adaptTimer, metrics);

    if (!meetingSummary) {
      throw new Error('Invalid Zoom event payload after adapter processing');
    }

    // Pick a unique-per-delivery identifier for the idempotency key.
    // Real Zoom webhooks don't include `event_id` in the body — they use
    // `event_ts` (ms-epoch timestamp). Synthetic tests pass `event_id`
    // directly. Final fallback is a generated UUID so we never block on
    // a totally unidentifiable event.
    const deliveryId =
      rawEvent.event_id ||
      (rawEvent.event_ts ? String(rawEvent.event_ts) : null) ||
      uuidv4();

    log.info(
      { zoomMeetingId: meetingSummary.zoomMeetingId, deliveryId },
      'Meeting payload adapted'
    );

    // MVP cohort gate: only meetings whose host email is on the
    // ALLOWED_HOST_EMAILS list get processed. Empty list (default) means
    // no gate is active — process every meeting. Filtering here, before
    // the idempotency claim and any expensive work, avoids spending
    // Claude tokens, Slack API calls, or DB writes on meetings outside
    // the cohort.
    if (config.allowedHostEmails.size > 0) {
      const hostEmailLower = (meetingSummary.hostEmail || '').toLowerCase();
      if (!config.allowedHostEmails.has(hostEmailLower)) {
        log.info(
          {
            hostEmail: meetingSummary.hostEmail,
            zoomMeetingId: meetingSummary.zoomMeetingId,
            allowlistSize: config.allowedHostEmails.size,
          },
          'Pipeline skipped: host not in ALLOWED_HOST_EMAILS allowlist'
        );
        return {
          correlationId,
          eventId: rawEvent.event_id,
          ok: true,
          skipped: true,
          reason: 'host_not_in_allowlist',
          hostEmail: meetingSummary.hostEmail,
          zoomMeetingId: meetingSummary.zoomMeetingId,
          metrics,
        };
      }
    }

    idempotencyKey = `zoom:meeting:${meetingSummary.zoomMeetingId}:${deliveryId}`;
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

    // If the adapter handed us a transcript download URL (real Zoom
    // recording.transcript_completed event), fetch the VTT, parse it into
    // plain text with speaker labels preserved, and put it on
    // meetingSummary.transcript. The extraction layer prefers .transcript
    // over .summary, so once this stage runs, Claude gets the raw transcript.
    //
    // Synthetic test events skip this stage (no transcriptDownloadUrl) and
    // continue to use the summary path via meetingSummary.summary.
    if (meetingSummary.transcriptDownloadUrl && !meetingSummary.transcript) {
      const fetchTimer = startStage('fetchTranscript');
      try {
        const vtt = await zoomApi.downloadRecordingFile(
          meetingSummary.transcriptDownloadUrl,
          meetingSummary.zoomAccountId,
          meetingSummary.transcriptDownloadToken
        );
        meetingSummary.transcript = parseVtt(vtt);
        endStage(fetchTimer, metrics);
        log.info(
          {
            transcriptChars: meetingSummary.transcript.length,
            usedDownloadToken: !!meetingSummary.transcriptDownloadToken,
          },
          'Transcript fetched and parsed'
        );
      } catch (err) {
        endStage(fetchTimer, metrics);
        log.error({ err }, 'fetchTranscript failed');
        throw err;
      }
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

    // Testing CC: send the same digest to each DIGEST_SHADOW_RECIPIENTS email,
    // skipping anyone whose email matches the host's (to avoid double-DM).
    // Failures are logged but never fail the pipeline — this is observability
    // scaffolding, not part of the production guarantee.
    if (config.digestShadowRecipients.size > 0) {
      const hostEmailLower = (meetingSummary.hostEmail || '').toLowerCase();
      const shadowTargets = Array.from(config.digestShadowRecipients).filter(
        (email) => email !== hostEmailLower
      );

      for (const shadowEmail of shadowTargets) {
        try {
          const shadowUser = await userDirectory.findByEmail(shadowEmail);
          if (!shadowUser?.slack_id) {
            log.warn(
              { shadowEmail },
              'Shadow recipient has no Slack ID; skipping shadow DM'
            );
            continue;
          }
          const shadowDelivery = await deliverToSlack({
            meetingSummary,
            intelligence,
            target: { userId: shadowUser.slack_id },
          });
          log.info(
            { shadowEmail, shadowDigestTs: shadowDelivery?.ts },
            'Shadow digest delivered'
          );
        } catch (shadowErr) {
          log.warn(
            { err: shadowErr, shadowEmail },
            'Shadow digest delivery failed (best-effort, not retried)'
          );
        }
      }
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
