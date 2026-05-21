/**
 * End-to-end orchestrator test: drives processMeeting through every stage
 * with all externals (DB, Anthropic, Slack) mocked at module boundaries.
 * Verifies the full pipeline (adapt → claim → resolveHost → persist →
 * guard → extract → deliver → saveResults → finalize) on the happy path,
 * plus the major branch points.
 */

const { installDbMock } = require('../mocks/db');
const dbHandle = installDbMock();

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({ messages: { create } }));
  Anthropic.__create = create;
  return { Anthropic };
});

jest.mock('../../src/integrations/slack', () => {
  const conversationsOpen = jest.fn();
  const chatPostMessage = jest.fn();
  const usersLookupByEmail = jest.fn();
  return {
    slackClient: {
      conversations: { open: conversationsOpen },
      chat: { postMessage: chatPostMessage },
      users: { lookupByEmail: usersLookupByEmail },
    },
    __mocks: { conversationsOpen, chatPostMessage, usersLookupByEmail },
  };
});

const { Anthropic } = require('@anthropic-ai/sdk');
const slackMock = require('../../src/integrations/slack').__mocks;
const config = require('../../src/config');
const { processMeeting } = require('../../src/server');

const zoomFixtures = require('../fixtures/zoom');
const claudeFixtures = require('../fixtures/claude');
const slackFixtures = require('../fixtures/slack');

const INTERNAL_HOST_ROW = {
  email: 'alice@inmarket.com',
  full_name: 'Alice Chen',
  slack_id: 'U01ALICE',
  created_at: new Date(),
  updated_at: new Date(),
};

function happyPathDbResponses() {
  return {
    users_find_by_email: { rows: [INTERNAL_HOST_ROW] },
    idempotency_claim: { rows: [{ key: 'k', status: 'processing', response: null, owner_id: 1 }] },
    meetings_upsert_from_webhook: { rows: [{ id: 'meet_uuid_01' }] },
    meetings_find_by_uuid: {
      rows: [{ id: 'meet_uuid_01', zoom_id: '99887766', digest_sent_at: null, digest_slack_ts: null }],
    },
    meetings_save_extraction_and_digest: { rows: [], rowCount: 1 },
    idempotency_save: { rows: [{ status: 'done' }] },
  };
}

beforeEach(() => {
  dbHandle.reset();
  Anthropic.__create.mockReset();
  Object.values(slackMock).forEach((m) => m.mockReset());
  // Reset the MVP allowlist between tests — default is "no gate".
  config.allowedHostEmails = new Set();
});

describe('processMeeting — happy path', () => {
  test('runs all eight stages and returns delivered=true', async () => {
    dbHandle.mockQueryByName(happyPathDbResponses());
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    slackMock.conversationsOpen.mockResolvedValueOnce(slackFixtures.conversationsOpenSuccess);
    slackMock.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const event = zoomFixtures.meetingSummaryCompleted();
    const result = await processMeeting(event);

    expect(result).toMatchObject({
      ok: true,
      eventId: 'evt_01HXYZTEST',
      delivered: true,
      digestTs: '1715800000.001100',
      idempotencyKey: expect.stringContaining('zoom:meeting:99887766'),
    });

    // Verify each stage was actually called (proxied through the named queries)
    const expectedQueries = [
      'idempotency_claim',
      'users_find_by_email',
      'meetings_upsert_from_webhook',
      'meetings_find_by_uuid',
      'meetings_save_extraction_and_digest',
      'idempotency_save',
    ];
    expectedQueries.forEach((name) => {
      expect(dbHandle.findQueryCalls(name).length).toBeGreaterThan(0);
    });

    // Verify externals were actually invoked
    expect(Anthropic.__create).toHaveBeenCalledTimes(1);
    expect(slackMock.conversationsOpen).toHaveBeenCalledWith({ users: 'U01ALICE' });
    expect(slackMock.chatPostMessage).toHaveBeenCalledTimes(1);

    // Per-stage timings recorded (ms durations). server.js wraps the timed
    // stages with startStage; the idempotency claim and host lookup are
    // intentionally not wrapped (the claim is too short to be useful and
    // host lookup is folded into persistMeeting).
    expect(result.metrics).toMatchObject({
      adaptZoomPayload: expect.any(Number),
      persistMeeting: expect.any(Number),
      duplicateGuard: expect.any(Number),
      extractMeetingIntelligence: expect.any(Number),
      sendSlackDigest: expect.any(Number),
      updateMeetingDeliveryStatus: expect.any(Number),
      processMeeting: expect.any(Number),
    });
  });

  test('uses an upstream-provided correlationId instead of generating one', async () => {
    dbHandle.mockQueryByName(happyPathDbResponses());
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    slackMock.conversationsOpen.mockResolvedValueOnce(slackFixtures.conversationsOpenSuccess);
    slackMock.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const event = zoomFixtures.meetingSummaryCompleted();
    const result = await processMeeting(event, { correlationId: 'req-id-from-pino-http' });

    expect(result.correlationId).toBe('req-id-from-pino-http');
  });
});

describe('processMeeting — duplicate event (idempotency)', () => {
  test('short-circuits when the idempotency key is already claimed', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: { rows: [] }, // INSERT returns 0 rows → already exists
      idempotency_get: {
        rows: [{ status: 'done', response: { ok: true, prior: 'result' }, owner_id: 99 }],
      },
    });

    const event = zoomFixtures.meetingSummaryCompleted();
    const result = await processMeeting(event);

    expect(result).toMatchObject({
      status: 'done',
      cachedResponse: { ok: true, prior: 'result' },
    });

    // None of the downstream stages should have run
    expect(Anthropic.__create).not.toHaveBeenCalled();
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();
    expect(dbHandle.findQueryCalls('meetings_upsert_from_webhook')).toHaveLength(0);
  });
});

describe('processMeeting — cross-event_id duplicate (digest already sent)', () => {
  test('skips Slack delivery when meetings.digest_sent_at is set', async () => {
    dbHandle.mockQueryByName({
      ...happyPathDbResponses(),
      meetings_find_by_uuid: {
        rows: [
          {
            id: 'meet_uuid_01',
            zoom_id: '99887766',
            digest_sent_at: new Date('2026-05-15T15:30:00Z'),
            digest_slack_ts: '1715800000.000099',
          },
        ],
      },
    });

    const event = zoomFixtures.meetingSummaryCompleted();
    const result = await processMeeting(event);

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'duplicate_digest',
      existingDigestTs: '1715800000.000099',
    });

    // Critically: no Slack call this time
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();
    expect(slackMock.conversationsOpen).not.toHaveBeenCalled();
    // And no Claude call — extraction is downstream of the guard
    expect(Anthropic.__create).not.toHaveBeenCalled();
  });

  test('recurring meeting series: two occurrences (same zoom_id, different uuid) both produce digests', async () => {
    // Real-world bug from 2026-05-21: a daily standup webhook arrived
    // with the same zoom_id as yesterday's standup. The duplicate guard
    // was previously keyed on zoom_id, which incorrectly treated today's
    // occurrence as a duplicate of yesterday's. The fix keys on uuid
    // (per-occurrence). This test pins that behavior so we never
    // regress.
    //
    // Setup: findByUuid returns "no existing meeting" for both calls —
    // since each occurrence is its own row, the lookup misses both times.
    dbHandle.mockQueryByName({
      users_find_by_email: { rows: [INTERNAL_HOST_ROW] },
      idempotency_claim: [
        { rows: [{ key: 'k1', status: 'processing', response: null, owner_id: 1, reclaimed: false }] },
        { rows: [{ key: 'k2', status: 'processing', response: null, owner_id: 1, reclaimed: false }] },
      ],
      meetings_upsert_from_webhook: [
        { rows: [{ id: 'meet_uuid_day1' }] },
        { rows: [{ id: 'meet_uuid_day2' }] },
      ],
      meetings_find_by_uuid: [
        { rows: [] }, // day 1: no prior occurrence row
        { rows: [] }, // day 2: still no row for THIS occurrence
      ],
      meetings_save_extraction_and_digest: { rows: [], rowCount: 1 },
      idempotency_save: { rows: [{ status: 'done' }] },
    });
    Anthropic.__create.mockResolvedValue(claudeFixtures.messagesCreateSuccess);
    slackMock.conversationsOpen.mockResolvedValue(slackFixtures.conversationsOpenSuccess);
    slackMock.chatPostMessage.mockResolvedValue(slackFixtures.chatPostMessageSuccess);

    // Same zoom_id (99887766), different per-occurrence uuid + start_time
    const day1 = zoomFixtures.meetingSummaryCompleted({
      event_id: 'evt_standup_day1',
      object: { uuid: 'occurrence-mon==', start_time: '2026-05-20T14:00:00Z' },
    });
    const day2 = zoomFixtures.meetingSummaryCompleted({
      event_id: 'evt_standup_day2',
      object: { uuid: 'occurrence-tue==', start_time: '2026-05-21T14:00:00Z' },
    });

    const result1 = await processMeeting(day1);
    const result2 = await processMeeting(day2);

    // Both occurrences produced a digest — the previous zoom_id-keyed
    // guard would have skipped day2 here.
    expect(result1).toMatchObject({ ok: true, delivered: true });
    expect(result2).toMatchObject({ ok: true, delivered: true });

    // And the upsert queries received DIFFERENT uuids in $1.
    const upsertCalls = dbHandle.findQueryCalls('meetings_upsert_from_webhook');
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0].values[0]).toBe('occurrence-mon==');
    expect(upsertCalls[1].values[0]).toBe('occurrence-tue==');
    // ...but the same zoom_id ($2), confirming the series link is preserved.
    expect(upsertCalls[0].values[1]).toBe('99887766');
    expect(upsertCalls[1].values[1]).toBe('99887766');

    // Two Slack DMs sent — one per occurrence.
    expect(slackMock.chatPostMessage).toHaveBeenCalledTimes(2);
  });
});

describe('processMeeting — external host (no Slack identity)', () => {
  test('completes extraction but skips delivery when host is not in users and Slack does not know them', async () => {
    dbHandle.mockQueryByName({
      ...happyPathDbResponses(),
      users_find_by_email: { rows: [] }, // not cached
    });

    slackMock.usersLookupByEmail.mockRejectedValueOnce(slackFixtures.usersLookupByEmailNotFoundError());
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);

    const event = zoomFixtures.meetingSummaryCompletedExternalHost;
    const result = await processMeeting(event);

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();

    // Extraction must still have run — the meeting record gets the intelligence
    // even when nobody is DM'd
    expect(Anthropic.__create).toHaveBeenCalledTimes(1);
    expect(dbHandle.findQueryCalls('meetings_save_extraction_and_digest')).toHaveLength(1);
  });
});

describe('processMeeting — MVP allowlist gate', () => {
  test('skips entirely when host email is not in ALLOWED_HOST_EMAILS', async () => {
    config.allowedHostEmails = new Set(['someone-else@inmarket.com']);

    const event = zoomFixtures.meetingSummaryCompleted(); // host = alice@inmarket.com
    const result = await processMeeting(event);

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'host_not_in_allowlist',
      hostEmail: 'alice@inmarket.com',
    });

    // Critically: nothing downstream of the filter should have run
    expect(dbHandle.findQueryCalls('idempotency_claim')).toHaveLength(0);
    expect(dbHandle.findQueryCalls('meetings_upsert_from_webhook')).toHaveLength(0);
    expect(Anthropic.__create).not.toHaveBeenCalled();
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();
  });

  test('processes normally when host email is in the allowlist (case-insensitive match)', async () => {
    config.allowedHostEmails = new Set(['alice@inmarket.com']);

    dbHandle.mockQueryByName(happyPathDbResponses());
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    slackMock.conversationsOpen.mockResolvedValueOnce(slackFixtures.conversationsOpenSuccess);
    slackMock.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    // Mixed-case email on the incoming event must still match the lower-case set entry
    const event = zoomFixtures.meetingSummaryCompleted({
      object: { host_email: 'Alice@InMarket.com' },
    });
    const result = await processMeeting(event);

    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(result.skipped).toBeUndefined();
    expect(Anthropic.__create).toHaveBeenCalledTimes(1);
  });

  test('processes every meeting when the allowlist is empty (default — no gate)', async () => {
    // allowedHostEmails is already empty from beforeEach
    dbHandle.mockQueryByName(happyPathDbResponses());
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    slackMock.conversationsOpen.mockResolvedValueOnce(slackFixtures.conversationsOpenSuccess);
    slackMock.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const event = zoomFixtures.meetingSummaryCompleted();
    const result = await processMeeting(event);

    expect(result.skipped).toBeUndefined();
    expect(result.delivered).toBe(true);
  });
});

describe('processMeeting — failure paths', () => {
  test('records error and marks idempotency failed when Claude refuses', async () => {
    dbHandle.mockQueryByName({
      ...happyPathDbResponses(),
      meetings_record_error: { rows: [], rowCount: 1 },
    });
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateRefusal);

    const event = zoomFixtures.meetingSummaryCompleted();

    // The current orchestrator throws on failure; future cleanup may convert
    // it to an envelope. Accept either shape but verify the side effects.
    let thrown = null;
    try {
      await processMeeting(event);
    } catch (err) {
      thrown = err;
    }

    // Either we threw, or the result was {ok: false}. Either way, no Slack post.
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();
    expect(dbHandle.findQueryCalls('meetings_record_error').length).toBeGreaterThanOrEqual(1);
    expect(dbHandle.findQueryCalls('idempotency_save').length).toBeGreaterThanOrEqual(1);

    const lastIdempotencySave = dbHandle.findQueryCalls('idempotency_save').slice(-1)[0];
    expect(lastIdempotencySave.values[1]).toBe('failed'); // status param

    if (thrown) {
      expect(thrown.message).toMatch(/refused/i);
    }
  });

  test('returns null result envelope when the adapter rejects a payload with no meeting ID', async () => {
    // No mocks beyond the default empty-rows behavior — the adapter rejects
    // before any downstream stage.
    const event = zoomFixtures.meetingSummaryMissingId;

    let thrown = null;
    let result = null;
    try {
      result = await processMeeting(event);
    } catch (err) {
      thrown = err;
    }

    // Adapter failure short-circuits BEFORE idempotency claim, so no DB
    // queries should have hit the meetings table.
    expect(dbHandle.findQueryCalls('meetings_upsert_from_webhook')).toHaveLength(0);
    expect(Anthropic.__create).not.toHaveBeenCalled();
    expect(slackMock.chatPostMessage).not.toHaveBeenCalled();

    if (thrown) {
      expect(thrown.message).toMatch(/Invalid Zoom event payload/i);
    } else {
      expect(result?.ok).toBeFalsy();
    }
  });
});
