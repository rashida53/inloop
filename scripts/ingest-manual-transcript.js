#!/usr/bin/env node
/**
 * scripts/ingest-manual-transcript.js
 *
 * Push a meeting transcript through the full pipeline (Claude extraction →
 * Slack digest delivery) from a local file. Used to recover meetings that
 * weren't cloud-recorded (no Zoom webhook fired) but the host has a
 * transcript file from another source (local recording → Whisper, manual
 * notes, etc.).
 *
 * Supports two input formats:
 *   - WebVTT (.vtt) — Zoom's native format; parsed with speaker labels
 *     preserved and unique speakers added as attendees.
 *   - Plain text (.txt or anything else) — used as-is, no speaker
 *     extraction.
 *
 * Usage:
 *   TRANSCRIPT_FILE=path/to/transcript.vtt \
 *   HOST_EMAIL=alice@inmarket.com \
 *   TITLE='Acme RFP review' \
 *   node scripts/ingest-manual-transcript.js
 *
 * Optional env vars:
 *   MEETING_ID         — unique Zoom-style meeting ID (default: manual-<timestamp>)
 *   ZOOM_ACCOUNT_ID    — for token-using paths (unused for manual ingestion since
 *                        no Zoom API call is made; supply if known to keep DB
 *                        host_email FK aligned)
 *   MEETING_DATE       — ISO 8601 timestamp of meeting (default: now)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { processMeeting } = require('../src/server');
const db = require('../src/db');
const { parseVtt } = require('../src/utils/vtt-parser');

const transcriptFile = process.env.TRANSCRIPT_FILE;
const hostEmail = process.env.HOST_EMAIL;
const title = process.env.TITLE || 'Manually-ingested meeting';

if (!transcriptFile) {
  console.error('Missing TRANSCRIPT_FILE env var. See script header for usage.');
  process.exit(1);
}
if (!hostEmail) {
  console.error('Missing HOST_EMAIL env var. See script header for usage.');
  process.exit(1);
}
if (!fs.existsSync(transcriptFile)) {
  console.error(`Transcript file not found: ${transcriptFile}`);
  process.exit(1);
}

const rawBuffer = fs.readFileSync(transcriptFile);
// Reject binary files (docx, pdf, encrypted Zoom transcript dumps, etc.).
// Postgres JSONB rejects \u0000 (error 22P05), so catch this here with a
// clear message instead of crashing during the persist stage.
const firstKb = rawBuffer.slice(0, 1024);
const nullByteCount = firstKb.filter((b) => b === 0x00).length;
const nonPrintableCount = firstKb.filter(
  (b) => b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b === 0x7f)
).length;
if (nullByteCount > 0 || nonPrintableCount > 32) {
  console.error(
    `\n❌ ${transcriptFile} looks like a binary file, not plain text.`
  );
  console.error(
    `   First 1KB has ${nullByteCount} null bytes and ${nonPrintableCount} non-printable bytes.`
  );
  console.error(`   Likely cause: a .docx or .pdf saved with a .txt extension.`);
  console.error(
    `   Fix: open the doc, select all + copy, then run \`pbpaste > ${transcriptFile}\` to overwrite it with clipboard text.`
  );
  process.exit(1);
}

// Sanitize defensively: strip any stray null bytes that survived (rare but
// possible in legitimately-text files mangled by an editor).
const fileContents = rawBuffer.toString('utf8').replace(/\u0000/g, '');
const ext = path.extname(transcriptFile).toLowerCase();
const looksLikeVtt =
  ext === '.vtt' || fileContents.trim().slice(0, 6).toUpperCase() === 'WEBVTT';

let transcriptText;
let speakers;
if (looksLikeVtt) {
  const parsed = parseVtt(fileContents);
  transcriptText = parsed.transcript;
  speakers = parsed.speakers;
} else {
  transcriptText = fileContents.trim();
  speakers = [];
}

if (!transcriptText) {
  console.error('Transcript file is empty after parsing.');
  process.exit(1);
}

const meetingId = process.env.MEETING_ID || `manual-${Date.now()}`;
const eventId = `evt-manual-${uuidv4()}`;
const meetingDate = process.env.MEETING_DATE || new Date().toISOString();

// Construct a recording.transcript_completed-shaped event with the
// inline transcript fields the adapter recognizes for manual ingestion.
const event = {
  event: 'recording.transcript_completed',
  event_id: eventId,
  event_ts: Date.now(),
  inline_transcript: transcriptText,
  inline_speakers: speakers,
  payload: {
    account_id: process.env.ZOOM_ACCOUNT_ID || null,
    object: {
      id: meetingId,
      uuid: `manual-uuid-${meetingId}`,
      topic: title,
      host_email: hostEmail,
      host_name: 'Manual Ingest',
      start_time: meetingDate,
      end_time: meetingDate,
      duration: 0,
      participants: [],
      recording_files: [],
    },
  },
};

function banner(t) {
  const bar = '='.repeat(56);
  console.log(`\n${bar}\n  ${t}\n${bar}`);
}

async function main() {
  banner('Manual transcript ingestion');
  console.log(`Transcript file:  ${transcriptFile}`);
  console.log(`Format detected:  ${looksLikeVtt ? 'WebVTT' : 'plain text'}`);
  console.log(`Transcript chars: ${transcriptText.length}`);
  console.log(`Speakers found:   ${speakers.length} ${speakers.length ? '(' + speakers.join(', ') + ')' : ''}`);
  console.log(`Host email:       ${hostEmail}`);
  console.log(`Meeting title:    ${title}`);
  console.log(`Meeting ID:       ${meetingId}`);
  console.log('\nFiring processMeeting()...\n');

  const start = Date.now();
  const result = await processMeeting(event, { correlationId: `manual-${Date.now()}` });
  const elapsed = Date.now() - start;

  banner('Result envelope');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nWall-clock total: ${elapsed}ms`);

  banner('What to verify');
  if (result.ok && result.delivered) {
    console.log('✅ End-to-end success.');
    console.log('   - Slack DM sent to the host');
    console.log(`   - Supabase: SELECT * FROM meetings WHERE zoom_id = '${meetingId}';`);
  } else if (result.skipped) {
    console.log(`⚠️  Pipeline skipped — reason: ${result.reason || 'unknown'}`);
    if (result.reason === 'host_not_in_allowlist') {
      console.log(`   Add ${hostEmail} to ALLOWED_HOST_EMAILS and re-run.`);
    }
  } else if (result.ok && !result.delivered) {
    console.log('⚠️  Pipeline ran but no Slack DM was sent.');
    console.log(`   Likely cause: host "${hostEmail}" doesnt resolve to a Slack user.`);
  } else {
    console.log('❌ Pipeline failed.');
    if (result.error) console.log(`   Error: ${result.error}`);
  }
}

main()
  .catch((err) => {
    console.error('\n❌ Unhandled error:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.shutdown().catch(() => {});
  });
