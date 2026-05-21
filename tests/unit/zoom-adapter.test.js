const {
  adaptZoomPayload,
  adaptZoomEvent,
  adaptTranscriptCompleted,
} = require('../../src/adapters/zoom-adapter');
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
    // uuid is required for the meetings-table per-occurrence dedup. The
    // base fixture doesn't include one, so the adapter synthesizes a
    // fallback from zoomMeetingId + start_time.
    expect(typeof summary.zoomMeetingUuid).toBe('string');
    expect(summary.zoomMeetingUuid.length).toBeGreaterThan(0);
  });

  test('extracts per-occurrence uuid when Zoom provides one', () => {
    const event = fixtures.meetingSummaryCompleted({
      object: { uuid: 'real-zoom-uuid-base64==' },
    });
    const summary = adaptZoomPayload(event.object, event.event_id);
    expect(summary.zoomMeetingUuid).toBe('real-zoom-uuid-base64==');
  });

  test('two occurrences of the same recurring meeting series produce distinct uuids', () => {
    // Real-world bug: same zoom_id (e.g. daily standup 84740555455) across
    // multiple days. The uuid must differ per occurrence so the meetings
    // table doesn't dedupe them into one row.
    const day1 = fixtures.meetingSummaryCompleted({
      object: { uuid: 'occurrence-mon==', start_time: '2026-05-20T14:00:00Z' },
    });
    const day2 = fixtures.meetingSummaryCompleted({
      object: { uuid: 'occurrence-tue==', start_time: '2026-05-21T14:00:00Z' },
    });

    const monSummary = adaptZoomPayload(day1.object, day1.event_id);
    const tueSummary = adaptZoomPayload(day2.object, day2.event_id);

    expect(monSummary.zoomMeetingId).toBe(tueSummary.zoomMeetingId);
    expect(monSummary.zoomMeetingUuid).not.toBe(tueSummary.zoomMeetingUuid);
  });

  test('falls back to synthetic uuid when Zoom omits one', () => {
    // Defensive: if Zoom ever sends a payload without uuid (unlikely but
    // possible for legacy/test events), the adapter still produces a
    // unique-enough id so the pipeline keeps running.
    const event = fixtures.meetingSummaryCompleted({
      object: { uuid: undefined, start_time: '2026-05-21T14:00:00Z' },
    });
    delete event.object.uuid;
    const summary = adaptZoomPayload(event.object, event.event_id);
    expect(summary.zoomMeetingUuid).toContain('99887766');
    expect(summary.zoomMeetingUuid).toContain('2026-05-21');
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

describe('adaptTranscriptCompleted', () => {
  test('extracts the TRANSCRIPT download URL and account ID from a recording.transcript_completed event', () => {
    const event = fixtures.recordingTranscriptCompleted();
    const summary = adaptZoomEvent(event);

    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      zoomMeetingId: '99887766',
      title: 'Acme RFP review',
      hostEmail: 'alice@inmarket.com',
      source: 'zoom',
      hasRecording: true,
      transcriptDownloadUrl: 'https://us02web.zoom.us/rec/download/transcript.vtt',
      transcriptDownloadToken: 'test-download-token-xyz',
      zoomAccountId: 'inmarket-zoom-account',
    });
  });

  test('warns but does not return null when the recording bundle has no transcript file', () => {
    const summary = adaptZoomEvent(fixtures.recordingTranscriptCompletedNoTranscriptFile);

    expect(summary).not.toBeNull();
    expect(summary.transcriptDownloadUrl).toBeNull();
    expect(summary.warnings.some((w) => /transcript/i.test(w))).toBe(true);
  });

  test('returns null when essential fields are missing', () => {
    const broken = {
      event: 'recording.transcript_completed',
      event_id: 'evt_broken',
      payload: { account_id: 'x', object: {} }, // no id, no meeting_id, no uuid
    };
    expect(adaptZoomEvent(broken)).toBeNull();
  });

  test('handles MP4/M4A recording_files entries without a TRANSCRIPT (degrades gracefully)', () => {
    const summary = adaptTranscriptCompleted(
      {
        id: '12345',
        topic: 'No transcript meeting',
        host_email: 'host@x.com',
        start_time: '2026-05-19T14:00:00Z',
        end_time: '2026-05-19T15:00:00Z',
        recording_files: [
          { file_type: 'M4A', download_url: 'https://example.com/audio.m4a' },
        ],
      },
      'acct-1',
      {},
      'evt-test'
    );

    expect(summary.transcriptDownloadUrl).toBeNull();
    expect(summary.zoomAccountId).toBe('acct-1');
  });
});

describe('adaptZoomEvent dispatcher', () => {
  test('routes recording.transcript_completed to the transcript adapter', () => {
    const event = fixtures.recordingTranscriptCompleted();
    const summary = adaptZoomEvent(event);
    expect(summary.transcriptDownloadUrl).toBeTruthy();
  });

  test('routes meeting.summary_completed to the legacy summary adapter', () => {
    const event = fixtures.meetingSummaryCompleted();
    const summary = adaptZoomEvent(event);
    // Transcript fields should NOT be set for summary events
    expect(summary.transcriptDownloadUrl).toBeUndefined();
    // Summary content should be assembled from AI Companion fields
    expect(summary.summary).toMatch(/Overview:/);
  });

  test('returns null for malformed input', () => {
    expect(adaptZoomEvent(null)).toBeNull();
    expect(adaptZoomEvent('string')).toBeNull();
    expect(adaptZoomEvent(undefined)).toBeNull();
  });
});
