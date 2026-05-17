/**
 * Sample Zoom webhook payloads, shaped to match what the production
 * verify middleware delivers to the orchestrator. The adapter expects
 * meeting.summary_completed events to carry AI Companion fields
 * (summary_overview + summary_details).
 */

function meetingSummaryCompleted(overrides = {}) {
  const base = {
    event: 'meeting.summary_completed',
    event_id: 'evt_01HXYZTEST',
    timestamp: Math.floor(Date.now() / 1000),
    object: {
      id: '99887766',
      topic: 'Acme Q2 SaaS evaluation',
      host_email: 'alice@inmarket.com',
      host_name: 'Alice Chen',
      start_time: '2026-05-15T14:00:00Z',
      end_time: '2026-05-15T15:00:00Z',
      duration: 60,
      participants: [
        {
          name: 'Alice Chen',
          user_email: 'alice@inmarket.com',
          join_time: '2026-05-15T14:00:00Z',
          leave_time: '2026-05-15T15:00:00Z',
        },
        {
          name: 'Bob Customer',
          user_email: 'bob@acme.com',
          join_time: '2026-05-15T14:02:00Z',
          leave_time: '2026-05-15T15:00:00Z',
        },
      ],
      summary_overview:
        'Alice met with Bob from Acme to walk through the SaaS pilot. Bob raised concerns about pricing tiers and requested a 90-day evaluation.',
      summary_details: [
        {
          label: 'Discussion',
          summary:
            'Bob expressed interest in the enterprise tier but pushed back on the $80k/year price point. Alice proposed a 90-day pilot at $50k to demonstrate ROI.',
        },
        {
          label: 'Decisions',
          summary:
            'Agreed to a 90-day pilot at $50k. Pilot scope limited to the analytics module. MSA to be signed by end of month.',
        },
        {
          label: 'Next Steps',
          summary:
            'Alice will send the MSA by Friday. Bob will loop in his procurement team and confirm pilot kickoff date by Monday.',
        },
      ],
    },
  };

  return { ...base, ...overrides, object: { ...base.object, ...(overrides.object || {}) } };
}

const meetingSummaryCompletedExternalHost = meetingSummaryCompleted({
  object: { host_email: 'unknown-customer@external.com' },
});

const meetingSummaryMissingId = {
  event: 'meeting.summary_completed',
  event_id: 'evt_missing_id',
  timestamp: Math.floor(Date.now() / 1000),
  object: {
    // no id, no meeting_id
    topic: 'Broken meeting',
    host_email: 'alice@inmarket.com',
    start_time: '2026-05-15T14:00:00Z',
    end_time: '2026-05-15T15:00:00Z',
  },
};

const meetingSummaryNoAiCompanion = {
  event: 'meeting.summary_completed',
  event_id: 'evt_no_ai_companion',
  timestamp: Math.floor(Date.now() / 1000),
  object: {
    id: '11223344',
    topic: 'Meeting without AI Companion enabled',
    host_email: 'alice@inmarket.com',
    start_time: '2026-05-15T14:00:00Z',
    end_time: '2026-05-15T15:00:00Z',
    duration: 60,
    // no summary_overview, no summary_details, no legacy summary
  },
};

const urlValidation = {
  event: 'endpoint.url_validation',
  event_id: 'evt_url_val_01',
  payload: { validationToken: 'plain-text-token-from-zoom' },
};

const unknownEventType = {
  event: 'meeting.something_unhandled',
  event_id: 'evt_unknown_01',
  timestamp: Math.floor(Date.now() / 1000),
  object: {},
};

module.exports = {
  meetingSummaryCompleted,
  meetingSummaryCompletedExternalHost,
  meetingSummaryMissingId,
  meetingSummaryNoAiCompanion,
  urlValidation,
  unknownEventType,
};
