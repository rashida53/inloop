/**
 * Tests for the Salesforce Event → Opportunity matcher. Covers the
 * two-tier strategy: Event lookup first, fuzzy Account match fallback.
 *
 * Mocks salesforce-api.queryRecords. Each test sets up the mock to
 * return what Salesforce would return for that scenario; assertions
 * check the match envelope (source, confidence, oppId, candidates).
 */

const mockQueryRecords = jest.fn();

jest.mock('../../src/integrations/salesforce-api', () => ({
  queryRecords: mockQueryRecords,
}));

const {
  findOppFromMeeting,
  findUserIdByEmail,
  findEventsNearTime,
  findOpenOppsByAccountName,
  OPPORTUNITY_ID_PREFIX,
} = require('../../src/integrations/salesforce-events');

const HOST_EMAIL = 'erin@inmarket.com';
const HOST_USER_ID = '005ErinGriffis';
const MEETING_START = '2026-05-20T14:00:00.000Z';
const SAMPLE_OPP_ID = '006Ru00000SJpwQIAT';
const SAMPLE_EVENT_ID = '00UTestEvent01';

// Helper to seed the user lookup, which fires at the start of every
// findOppFromMeeting call.
function mockUserLookupHit() {
  mockQueryRecords.mockResolvedValueOnce({
    records: [{ Id: HOST_USER_ID }],
    totalSize: 1,
  });
}

function mockUserLookupMiss() {
  mockQueryRecords.mockResolvedValueOnce({ records: [], totalSize: 0 });
}

describe('findUserIdByEmail', () => {
  beforeEach(() => {
    mockQueryRecords.mockReset();
  });

  test('returns the User Id when found', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [{ Id: HOST_USER_ID }] });
    const result = await findUserIdByEmail(HOST_EMAIL);
    expect(result).toBe(HOST_USER_ID);
  });

  test('returns null when not found', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    const result = await findUserIdByEmail(HOST_EMAIL);
    expect(result).toBeNull();
  });

  test('returns null for empty email without querying', async () => {
    const result = await findUserIdByEmail('');
    expect(result).toBeNull();
    expect(mockQueryRecords).not.toHaveBeenCalled();
  });

  test('escapes single quotes to prevent SOQL injection', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    await findUserIdByEmail("o'malley@example.com");

    const soql = mockQueryRecords.mock.calls[0][0];
    expect(soql).toContain("o\\'malley@example.com");
  });
});

describe('findEventsNearTime', () => {
  beforeEach(() => {
    mockQueryRecords.mockReset();
  });

  test('builds a SOQL with a ±30min window by default', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    await findEventsNearTime({ ownerId: HOST_USER_ID, startTime: MEETING_START });

    const soql = mockQueryRecords.mock.calls[0][0];
    // ±30 min around 14:00:00 → 13:30 to 14:30
    expect(soql).toMatch(/StartDateTime >= 2026-05-20T13:30:00/);
    expect(soql).toMatch(/StartDateTime <= 2026-05-20T14:30:00/);
    expect(soql).toContain(`OwnerId = '${HOST_USER_ID}'`);
  });

  test('honors custom toleranceMinutes', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    await findEventsNearTime({
      ownerId: HOST_USER_ID,
      startTime: MEETING_START,
      toleranceMinutes: 5,
    });

    const soql = mockQueryRecords.mock.calls[0][0];
    expect(soql).toMatch(/StartDateTime >= 2026-05-20T13:55:00/);
    expect(soql).toMatch(/StartDateTime <= 2026-05-20T14:05:00/);
  });

  test('returns empty array when ownerId is missing', async () => {
    const result = await findEventsNearTime({ ownerId: '', startTime: MEETING_START });
    expect(result).toEqual([]);
    expect(mockQueryRecords).not.toHaveBeenCalled();
  });

  test('returns empty array when startTime is invalid', async () => {
    const result = await findEventsNearTime({ ownerId: HOST_USER_ID, startTime: 'not-a-date' });
    expect(result).toEqual([]);
    expect(mockQueryRecords).not.toHaveBeenCalled();
  });
});

describe('findOpenOppsByAccountName', () => {
  beforeEach(() => {
    mockQueryRecords.mockReset();
  });

  test('returns empty when no matching Accounts', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    const result = await findOpenOppsByAccountName({
      ownerId: HOST_USER_ID,
      accountName: 'Taylor Farms',
    });
    expect(result).toEqual([]);
    // Should NOT have queried Opportunities since no Accounts matched
    expect(mockQueryRecords).toHaveBeenCalledTimes(1);
  });

  test('LIKE-queries Account name + filters Opportunities by AccountId + Owner + IsClosed', async () => {
    mockQueryRecords
      .mockResolvedValueOnce({ records: [{ Id: '001AB', Name: 'Taylor Farms, Inc.' }] })
      .mockResolvedValueOnce({
        records: [
          {
            Id: SAMPLE_OPP_ID,
            Name: 'Taylor Farms BTS',
            AccountId: '001AB',
            OwnerId: HOST_USER_ID,
            StageName: 'Proposal',
            IsClosed: false,
          },
        ],
      });

    const result = await findOpenOppsByAccountName({
      ownerId: HOST_USER_ID,
      accountName: 'Taylor Farms',
    });

    expect(result).toHaveLength(1);
    expect(result[0].Id).toBe(SAMPLE_OPP_ID);

    const accountSoql = mockQueryRecords.mock.calls[0][0];
    expect(accountSoql).toMatch(/Name LIKE '%Taylor Farms%'/);

    const oppSoql = mockQueryRecords.mock.calls[1][0];
    expect(oppSoql).toContain("OwnerId = '" + HOST_USER_ID + "'");
    expect(oppSoql).toContain('IsClosed = false');
  });

  test('escapes single quotes in account name', async () => {
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    await findOpenOppsByAccountName({
      ownerId: HOST_USER_ID,
      accountName: "Trader Joe's",
    });
    expect(mockQueryRecords.mock.calls[0][0]).toContain("Trader Joe\\'s");
  });

  test('returns empty when accountName is empty', async () => {
    const result = await findOpenOppsByAccountName({
      ownerId: HOST_USER_ID,
      accountName: '',
    });
    expect(result).toEqual([]);
    expect(mockQueryRecords).not.toHaveBeenCalled();
  });
});

describe('findOppFromMeeting', () => {
  beforeEach(() => {
    mockQueryRecords.mockReset();
  });

  test('returns none when the host email has no matching Salesforce User', async () => {
    mockUserLookupMiss();

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Taylor Farms',
    });

    expect(result.matchSource).toBe('none');
    expect(result.matchConfidence).toBe('none');
    expect(result.oppId).toBeNull();
    expect(result.details.reason).toBe('host_email_not_in_salesforce');
  });

  test('Tier 1 happy path: single Event with Opportunity WhatId → high confidence match', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        {
          Id: SAMPLE_EVENT_ID,
          Subject: 'Taylor Farms BTS Discovery',
          StartDateTime: MEETING_START,
          OwnerId: HOST_USER_ID,
          WhatId: SAMPLE_OPP_ID, // starts with 006 → Opportunity
        },
      ],
    });

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Taylor Farms',
    });

    expect(result.matchSource).toBe('event');
    expect(result.matchConfidence).toBe('high');
    expect(result.oppId).toBe(SAMPLE_OPP_ID);
    expect(result.eventId).toBe(SAMPLE_EVENT_ID);
    expect(result.candidates).toHaveLength(1);
  });

  test('Tier 1 ambiguity: multiple Events in window → low confidence with candidates', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        {
          Id: 'evt1',
          Subject: 'Taylor Farms',
          StartDateTime: MEETING_START,
          OwnerId: HOST_USER_ID,
          WhatId: '006OPP1AAA',
        },
        {
          Id: 'evt2',
          Subject: 'Earthbound Farm',
          StartDateTime: MEETING_START,
          OwnerId: HOST_USER_ID,
          WhatId: '006OPP2BBB',
        },
      ],
    });

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
    });

    expect(result.matchSource).toBe('event');
    expect(result.matchConfidence).toBe('low');
    expect(result.oppId).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.oppId)).toEqual(
      expect.arrayContaining(['006OPP1AAA', '006OPP2BBB'])
    );
  });

  test('Event has no Opportunity WhatId → falls through to fuzzy match', async () => {
    mockUserLookupHit();
    // Event exists but its WhatId points to an Account (001), not an Opp
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        {
          Id: SAMPLE_EVENT_ID,
          Subject: 'Meeting w/ Taylor Farms',
          StartDateTime: MEETING_START,
          OwnerId: HOST_USER_ID,
          WhatId: '001AccountAAA', // Account prefix, not Opp
        },
      ],
    });
    // Fuzzy match: one Account → one open Opp
    mockQueryRecords
      .mockResolvedValueOnce({ records: [{ Id: '001AccountAAA', Name: 'Taylor Farms' }] })
      .mockResolvedValueOnce({
        records: [
          {
            Id: SAMPLE_OPP_ID,
            Name: 'Taylor Farms BTS FY26',
            AccountId: '001AccountAAA',
            StageName: 'Proposal',
          },
        ],
      });

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Taylor Farms',
    });

    expect(result.matchSource).toBe('fuzzy_account');
    expect(result.matchConfidence).toBe('medium');
    expect(result.oppId).toBe(SAMPLE_OPP_ID);
    expect(result.eventId).toBeNull();
  });

  test('no Event found + fuzzy match finds one Opp → medium confidence fuzzy match', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({ records: [] }); // no Events
    mockQueryRecords
      .mockResolvedValueOnce({ records: [{ Id: '001A', Name: 'Taylor Farms' }] })
      .mockResolvedValueOnce({
        records: [
          {
            Id: SAMPLE_OPP_ID,
            Name: 'Taylor Farms BTS',
            AccountId: '001A',
            StageName: 'Discovery',
          },
        ],
      });

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Taylor Farms',
    });

    expect(result.matchSource).toBe('fuzzy_account');
    expect(result.matchConfidence).toBe('medium');
    expect(result.oppId).toBe(SAMPLE_OPP_ID);
  });

  test('no Event + fuzzy match finds multiple Opps → low confidence with candidates', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({ records: [] }); // no Events
    mockQueryRecords
      .mockResolvedValueOnce({
        records: [{ Id: '001A', Name: 'Taylor Farms' }, { Id: '001B', Name: 'Taylor Fresh Foods' }],
      })
      .mockResolvedValueOnce({
        records: [
          { Id: '006OPP1', Name: 'TF BTS 2026', AccountId: '001A', StageName: 'Proposal' },
          { Id: '006OPP2', Name: 'TF Q4 Spike', AccountId: '001B', StageName: 'Discovery' },
        ],
      });

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Taylor',
    });

    expect(result.matchSource).toBe('fuzzy_account');
    expect(result.matchConfidence).toBe('low');
    expect(result.oppId).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  test('no Event + no accountName extracted from transcript → none', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({ records: [] }); // no Events

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: '',
    });

    expect(result.matchSource).toBe('none');
    expect(result.matchConfidence).toBe('none');
    expect(result.details.reason).toBe('no_event_and_no_account_name');
  });

  test('no Event + fuzzy match finds nothing → none', async () => {
    mockUserLookupHit();
    mockQueryRecords.mockResolvedValueOnce({ records: [] }); // no Events
    mockQueryRecords.mockResolvedValueOnce({ records: [] }); // no Accounts

    const result = await findOppFromMeeting({
      hostEmail: HOST_EMAIL,
      startTime: MEETING_START,
      accountName: 'Nonexistent Brand',
    });

    expect(result.matchSource).toBe('none');
    expect(result.matchConfidence).toBe('none');
    expect(result.details.reason).toBe('no_event_and_no_fuzzy_match');
  });

  test('classifies WhatId by Salesforce prefix — 006 = Opportunity', async () => {
    // Defensive: prefix-based filtering matches Salesforce's actual
    // Id structure (003=Contact, 00Q=Lead, 001=Account, 006=Opp, etc.)
    expect(OPPORTUNITY_ID_PREFIX).toBe('006');
  });
});
