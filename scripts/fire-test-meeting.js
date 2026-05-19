#!/usr/bin/env node
/**
 * scripts/fire-test-meeting.js
 *
 * Drive a synthetic meeting.summary_completed event straight through
 * the orchestrator. Skips the HTTP / signature-verification boundary
 * (already covered by jest) but exercises everything downstream:
 *
 *   adapt → claim → resolveHost → persist → guard → extract → deliver → save
 *
 * A successful run will:
 *   - Insert a row into the `meetings` table
 *   - Make a real Claude Messages API call (counts against quota)
 *   - Send you a real Slack DM with the meeting digest
 *   - Insert a row into `idempotency_keys`
 *
 * Usage:
 *   node scripts/fire-test-meeting.js
 *
 * Optional env overrides:
 *   TEST_HOST_EMAIL  — host email on the synthetic event
 *                      (default: first email in ALLOWED_HOST_EMAILS,
 *                       or 'rkapadia@inmarket.com')
 *   TEST_MEETING_ID  — Zoom meeting ID to use
 *                      (default: a unique value per invocation)
 */

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { processMeeting } = require('../src/server');
const db = require('../src/db');

const hostEmail =
  process.env.TEST_HOST_EMAIL ||
  (process.env.ALLOWED_HOST_EMAILS || '').split(',')[0].trim() ||
  'rkapadia@inmarket.com';

const meetingId = process.env.TEST_MEETING_ID || `synthetic-${Date.now()}`;
const eventId = `evt-synthetic-${uuidv4()}`;

const event = {
  event: 'meeting.summary_completed',
  event_id: eventId,
  timestamp: Math.floor(Date.now() / 1000),
  object: {
    id: meetingId,
    topic: 'Acme Q2 SaaS evaluation (synthetic test)',
    host_email: hostEmail,
    host_name: 'Test Host',
    start_time: '2026-05-18T14:00:00Z',
    end_time: '2026-05-18T15:00:00Z',
    duration: 60,
    participants: [
      { name: 'Test Host', user_email: hostEmail },
      { name: 'Bob Customer', user_email: 'bob@acme-test.com' },
      { name: 'Carol Buyer', user_email: 'carol@acme-test.com' },
    ],
    // Explicit RFP review content with a concrete campaign launch date so
    // Claude reliably classifies as "rfp_review" AND extracts a launch date
    // for the timeline renderer to compute milestones from.
    summary_overview:
      'RFP review call: Test Host walked Bob and Carol from Acme through the InLoop SaaS RFP response and proposed campaign plan. Confirmed campaign launch date of 2026-08-15. Bob raised concerns about pricing tiers; Carol emphasized SOC 2 Type II attestation. Aligned on a 90-day pilot at $50k contingent on SOC 2 documentation delivery, with the campaign going live on August 15, 2026.',
    summary_details: [
      {
        label: 'Discussion',
        summary:
          'Bob pushed back on the enterprise tier at $80k/year, citing budget constraints for FY26. Carol asked detailed questions about data residency and the SOC 2 Type II report — currently Type I, with Type II expected by Q3. Bob asked about contract length flexibility (3-year vs 1-year).',
      },
      {
        label: 'Decisions',
        summary:
          'Pilot agreed at $50k for 90 days, scoped to the analytics module only. Campaign go-live confirmed for August 15, 2026 (2026-08-15). MSA to follow standard InLoop template. Pilot kickoff is blocked on SOC 2 docs being shared.',
      },
      {
        label: 'Campaign Timing',
        summary:
          'Campaign launch date confirmed: 2026-08-15. Acme requires final creative and copy locked at least two weeks before launch, with QA window leading into go-live.',
      },
      {
        label: 'Next Steps',
        summary:
          'Test Host to send MSA draft + SOC 2 Type I report by Friday. Bob to confirm procurement timeline by Monday. Carol to identify the technical contact for the analytics integration. Mid-pilot check-in at day 30.',
      },
    ],
  },
};

function banner(title) {
  const bar = '='.repeat(48);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

async function main() {
  banner('Synthetic meeting test');
  console.log(`Host email:     ${hostEmail}`);
  console.log(`Meeting ID:     ${meetingId}`);
  console.log(`Event ID:       ${eventId}`);
  console.log(`Correlation:    manual-${Date.now()}`);
  console.log('\nFiring processMeeting()...');

  const wallStart = Date.now();
  const result = await processMeeting(event, { correlationId: `manual-${Date.now()}` });
  const wallTotal = Date.now() - wallStart;

  banner('Result envelope');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nWall-clock total: ${wallTotal}ms`);

  banner('What to verify');
  if (result.ok && result.delivered) {
    console.log('✅ End-to-end success.');
    console.log('   1. Slack: check your DMs — a "Meeting Digest" message should be there');
    console.log(`   2. Supabase: SELECT * FROM meetings WHERE zoom_id = '${meetingId}';`);
    console.log(`   3. Supabase: SELECT * FROM idempotency_keys WHERE key LIKE 'zoom:meeting:${meetingId}:%';`);
  } else if (result.skipped) {
    console.log(`⚠️  Pipeline skipped — reason: ${result.reason}`);
    if (result.reason === 'host_not_in_allowlist') {
      console.log('   Add the host email to ALLOWED_HOST_EMAILS in your .env, then re-run.');
    } else if (result.reason === 'duplicate_digest') {
      console.log('   This meeting was already digested in a previous run.');
      console.log('   Use TEST_MEETING_ID=<new-id> to force a fresh meeting.');
    }
  } else if (result.duplicate) {
    console.log('⚠️  Duplicate event — idempotency claim already exists.');
    console.log('   The event_id is unique per run, so this is unexpected.');
  } else if (result.ok && !result.delivered) {
    console.log('⚠️  Pipeline ran but no Slack DM was sent.');
    console.log(`   Likely cause: host "${hostEmail}" doesnt resolve to a Slack user.`);
    console.log('   Check: does your Slack workspace have a member with that exact email?');
  } else {
    console.log('❌ Pipeline failed.');
    if (result.error) console.log(`   Error: ${result.error}`);
    if (result.failedStage) console.log(`   Failed stage: ${result.failedStage}`);
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('\n❌ Unhandled error from processMeeting:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.shutdown().catch(() => {});
  });
