const { adaptZoomPayload } = require('../../src/adapters/zoom-adapter');
const fixtures = require('../fixtures/zoom');

describe('adaptZoomPayload', () => {
  test('returns null when no meeting ID can be found', () => {
    const result = adaptZoomPayload(fixtures.meetingSummaryMissingId.object, 'evt_missing_id');
    expect(result).toBeNull();
  });

  test('returns null when the payload is not an object', () => {
    expect(adaptZoomPayload(null, 'evt')).toBeNull();
    expect(adaptZoomPayload('string', 'evt')).toBeNull();
  });

  test('produces a MeetingSummary with all expected top-level fields', () => {
    const event = fixtures.meetingSummaryCompleted();
    const summary = adaptZoomPayload(event.object, event.event_id);

    expect(summary).toMatchObject({
      zoomMeetingId: '99887766',
      title: 'Acme Q2 SaaS evaluation',
      hostEmail: 'alice@inmarket.com',
      hostName: 'Alice Chen',
      durationMinutes: 60,
      attendeeCount: 2,
      hasRecording: false,
      source: 'zoom',
    });
    expect(typeof summary.startTime).toBe('string');
    expect(typeof summary.endTime).toBe('string');
    expect(typeof summary.extractedAt).toBe('string');
    expect(Array.isArray(summary.attendees)).toBe(true);
    expect(Array.isArray(summary.warnings)).toBe(true);
  });

  test('deduplicates attendees by email and tags the host', () => {
    const event = fixtures.meetingSummaryCompleted({
      object: {
        participants: [
          { name: 'Alice Chen', user_email: 'alice@inmarket.com' },
          { name: 'Alice Chen', user_email: 'alice@inmarket.com' }, // dup
          { name: 'Bob Customer', user_email: 'bob@acme.com' },
        ],
      },
    });

    const summary = adaptZoomPayload(event.object, event.event_id);

    expect(summary.attendees).toHaveLength(2);
    const alice = summary.attendees.find((a) => a.email === 'alice@inmarket.com');
    expect(alice.isHost).toBe(true);
    expect(summary.attendees.find((a) => a.email === 'bob@acme.com').isHost).toBe(false);
  });

  test('assembles meeting body from AI Companion summary_overview + summary_details', () => {
    const event = fixtures.meetingSummaryCompleted();
    const summary = adaptZoomPayload(event.object, event.event_id);

    expect(summary.summary).toContain('Overview:');
    expect(summary.summary).toContain('Discussion:');
    expect(summary.summary).toContain('Decisions:');
    expect(summary.summary).toContain('Next Steps:');
    expect(summary.summary).toContain('90-day pilot at $50k');
  });

  test('leaves summary empty when AI Companion fields are absent and no legacy summary present', () => {
    const summary = adaptZoomPayload(
      fixtures.meetingSummaryNoAiCompanion.object,
      fixtures.meetingSummaryNoAiCompanion.event_id
    );

    expect(summary.summary).toBeFalsy();
  });

  test('falls back to legacy `summary` field when AI Companion fields absent', () => {
    const event = fixtures.meetingSummaryCompleted({
      object: {
        summary_overview: undefined,
        summary_details: undefined,
        summary: 'Legacy summary text from an older Zoom payload shape.',
      },
    });

    const summary = adaptZoomPayload(event.object, event.event_id);
    expect(summary.summary).toContain('Legacy summary text');
  });

  test('only includes summary_details entries that have content', () => {
    const event = fixtures.meetingSummaryCompleted({
      object: {
        summary_overview: 'Overview text',
        summary_details: [
          { label: 'Has content', summary: 'kept' },
          { label: 'Empty', summary: '' },
          { label: 'Null', summary: null },
          { summary: 'Missing label, has content' },
        ],
      },
    });

    const summary = adaptZoomPayload(event.object, event.event_id);
    expect(summary.summary).toContain('Has content:\nkept');
    expect(summary.summary).not.toContain('Empty:');
    expect(summary.summary).not.toContain('Null:');
    // entry with missing label gets the default 'Section' label
    expect(summary.summary).toContain('Section:\nMissing label, has content');
  });

  test('records warnings when timestamps are missing', () => {
    const event = fixtures.meetingSummaryCompleted({
      object: { start_time: undefined, end_time: undefined },
    });

    const summary = adaptZoomPayload(event.object, event.event_id);
    expect(summary.warnings.length).toBeGreaterThan(0);
    expect(summary.warnings.some((w) => w.includes('timestamps'))).toBe(true);
  });
});
