const db = require('./index');

/**
 * Insert or update the meeting record from the initial webhook payload.
 * Captures everything we know before extraction runs, so we have an audit
 * row even when extraction or delivery fails.
 *
 * host_email is only set when the host is known to be in the users table
 * (the FK is `host_email REFERENCES users(email)` — an unknown email would
 * 23503 the insert). The caller does the lookup and passes the result.
 *
 * @param {object} meetingSummary - Normalized MeetingSummary from adaptZoomPayload.
 * @param {object} rawEvent - The raw Zoom webhook event, stored for audit.
 * @param {object} [options]
 * @param {string|null} [options.knownHostEmail] - Set host_email only if non-null.
 * @returns {Promise<{id: string}>} - The meeting row's UUID.
 */
async function upsertFromWebhook(meetingSummary, rawEvent, { knownHostEmail = null } = {}) {
  const result = await db.query(
    `
    INSERT INTO meetings (zoom_id, title, attendees, host_email, recorded_at, source, raw_payload)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb)
    ON CONFLICT (zoom_id) DO UPDATE SET
      title = EXCLUDED.title,
      attendees = EXCLUDED.attendees,
      host_email = EXCLUDED.host_email,
      recorded_at = EXCLUDED.recorded_at,
      source = EXCLUDED.source,
      raw_payload = EXCLUDED.raw_payload,
      updated_at = NOW()
    RETURNING id
    `,
    [
      meetingSummary.zoomMeetingId,
      meetingSummary.title || null,
      JSON.stringify(meetingSummary.attendees || []),
      knownHostEmail,
      meetingSummary.startTime || null,
      meetingSummary.source || 'zoom',
      JSON.stringify(rawEvent),
    ],
    { name: 'meetings_upsert_from_webhook' }
  );

  return result.rows[0];
}

/**
 * Persist Claude's extraction results and Slack digest metadata onto an
 * existing meeting row. Clears any previous `error` since this is a success path.
 *
 * @param {string} zoomMeetingId
 * @param {object} intelligence - { followUpEmail, salesforceNotes } from extractMeetingIntelligence.
 * @param {object|null} delivery - { ts, channel } from deliverToSlack, or null if no DM was sent.
 */
async function saveExtractionAndDigest(zoomMeetingId, intelligence, delivery) {
  const notes = intelligence.salesforceNotes || {};
  const nextStepsText = Array.isArray(notes.nextSteps) && notes.nextSteps.length
    ? notes.nextSteps.join('\n')
    : null;

  await db.query(
    `
    UPDATE meetings
    SET summary = $1,
        next_steps = $2,
        digest_sent_at = $3,
        digest_slack_ts = $4,
        error = NULL,
        updated_at = NOW()
    WHERE zoom_id = $5
    `,
    [
      notes.notesSummary || null,
      nextStepsText,
      delivery?.ts ? new Date() : null,
      delivery?.ts || null,
      zoomMeetingId,
    ],
    { name: 'meetings_save_extraction_and_digest' }
  );
}

/**
 * Best-effort: record a processing error on the meeting row.
 * Caller should swallow any throw from this — the meeting row may not
 * exist yet if the failure happened before upsertFromWebhook completed.
 *
 * @param {string} zoomMeetingId
 * @param {string} message
 */
async function recordError(zoomMeetingId, message) {
  await db.query(
    `UPDATE meetings SET error = $1, updated_at = NOW() WHERE zoom_id = $2`,
    [String(message || 'unknown error').slice(0, 1000), zoomMeetingId],
    { name: 'meetings_record_error' }
  );
}

module.exports = { upsertFromWebhook, saveExtractionAndDigest, recordError };
