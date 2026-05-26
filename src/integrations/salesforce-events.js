/**
 * Salesforce Event lookup + Opportunity matching for InLoop.
 *
 * Given a Zoom meeting (host email + start time + subject + transcript-
 * extracted accountName), figure out which Salesforce Opportunity the
 * meeting was about. The result feeds salesforce-cds.js for CDS pre-fill.
 *
 * Two-tier matching strategy, decided 2026-05-22 with Ian (SF admin):
 *
 *   Tier 1 — Event lookup (preferred, deterministic when populated):
 *     EAC (Einstein Activity Capture) auto-creates Event records in
 *     Salesforce from Google Calendar. When the rep has set the
 *     Related-To Opportunity on the Event, we can read it directly.
 *     Match by: OwnerId = host's user, StartDateTime ≈ meeting start,
 *     What.Type = 'Opportunity'. No fuzzy logic needed.
 *
 *   Tier 2 — Fuzzy Account name match (fallback):
 *     When EAC hasn't created an Event, the Event exists but has no
 *     WhatId set, or the WhatId points elsewhere (Account, Lead, etc.),
 *     fall back to matching by the transcript-extracted account name.
 *     SOQL: Name LIKE search → narrow to host's open Opportunities.
 *
 * Result shape lets the orchestrator decide what to do:
 *   - one high-confidence match → proceed with CDS creation
 *   - multiple candidates       → DM rep with a picker
 *   - no matches                → DM rep to manually link
 */

const logger = require('../utils/logger');
const sf = require('./salesforce-api');

// Salesforce uses a fixed 3-char prefix per object type embedded in
// every Id. Opportunity Ids start with "006". Useful for client-side
// filtering of polymorphic WhatId fields without making a second query.
const OPPORTUNITY_ID_PREFIX = '006';

// How wide a time window to search around the Zoom meeting's start
// time when looking for the matching Salesforce Event. EAC mirrors
// Google Calendar timestamps so the start time should match to within
// minutes — 30 min is comfortably generous without pulling in
// unrelated meetings.
const EVENT_TIME_TOLERANCE_MINUTES = 30;

// Escape single quotes for inclusion in SOQL string literals. Salesforce
// SOQL doesn't support parameterized queries, so we do this defensively
// even though inputs flow from internal sources (transcript-extracted
// names) rather than user input.
function escapeSoql(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Look up a Salesforce User by email.
 * Returns the User's Id or null when not found.
 *
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function findUserIdByEmail(email) {
  if (!email) return null;

  const result = await sf.queryRecords(
    `SELECT Id FROM User WHERE Email = '${escapeSoql(email)}' AND IsActive = true LIMIT 1`
  );
  return result.records?.[0]?.Id || null;
}

/**
 * Find Salesforce Event records owned by the given user that started
 * near the given time. Returns the raw Event records — caller filters
 * for ones with an Opportunity-typed WhatId.
 *
 * @param {object} params
 * @param {string} params.ownerId  - Salesforce User Id (from findUserIdByEmail)
 * @param {string|Date} params.startTime - Meeting start, ISO-8601 or Date
 * @param {number} [params.toleranceMinutes] - Time window half-width
 * @returns {Promise<object[]>}
 */
async function findEventsNearTime({ ownerId, startTime, toleranceMinutes = EVENT_TIME_TOLERANCE_MINUTES }) {
  if (!ownerId || !startTime) return [];

  const startMs = new Date(startTime).getTime();
  if (Number.isNaN(startMs)) return [];

  const windowMs = toleranceMinutes * 60 * 1000;
  const lower = new Date(startMs - windowMs).toISOString();
  const upper = new Date(startMs + windowMs).toISOString();

  const soql =
    `SELECT Id, Subject, StartDateTime, EndDateTime, OwnerId, WhatId ` +
    `FROM Event ` +
    `WHERE OwnerId = '${escapeSoql(ownerId)}' ` +
    `AND StartDateTime >= ${lower} ` +
    `AND StartDateTime <= ${upper} ` +
    `ORDER BY StartDateTime ASC`;

  const result = await sf.queryRecords(soql);
  return result.records || [];
}

/**
 * Find Opportunities owned by the given user whose Account name
 * resembles the given query string. Used as the fallback matching
 * path when Event lookup fails.
 *
 * @param {object} params
 * @param {string} params.ownerId
 * @param {string} params.accountName - Transcript-extracted account name
 * @returns {Promise<object[]>}
 */
async function findOpenOppsByAccountName({ ownerId, accountName }) {
  if (!ownerId || !accountName) return [];

  // First find candidate Accounts whose Name contains the search string.
  // SOQL LIKE is case-insensitive; % is the wildcard. Trimming + escaping
  // protects against trailing whitespace and embedded quotes.
  const cleanedName = escapeSoql(accountName.trim());
  if (!cleanedName) return [];

  const accountResult = await sf.queryRecords(
    `SELECT Id, Name FROM Account WHERE Name LIKE '%${cleanedName}%' LIMIT 25`
  );
  const accountIds = (accountResult.records || []).map((a) => a.Id);
  if (accountIds.length === 0) return [];

  // Then find open Opportunities on those Accounts owned by the host.
  const accountIdList = accountIds.map((id) => `'${escapeSoql(id)}'`).join(',');
  const oppResult = await sf.queryRecords(
    `SELECT Id, Name, AccountId, OwnerId, StageName, IsClosed ` +
      `FROM Opportunity ` +
      `WHERE OwnerId = '${escapeSoql(ownerId)}' ` +
      `AND AccountId IN (${accountIdList}) ` +
      `AND IsClosed = false ` +
      `ORDER BY LastModifiedDate DESC ` +
      `LIMIT 10`
  );
  return oppResult.records || [];
}

/**
 * Main entry point. Given a Zoom meeting's metadata, returns a match
 * result describing which Salesforce Opportunity (if any) the meeting
 * was about.
 *
 * Result envelope:
 *   {
 *     matchSource: 'event' | 'fuzzy_account' | 'none',
 *     matchConfidence: 'high' | 'medium' | 'low' | 'none',
 *     oppId: string | null,
 *     candidates: object[],   // populated when source is 'fuzzy_account' or ambiguous
 *     eventId: string | null, // populated when matched via Event
 *     details: { ... }        // diagnostic info for logging
 *   }
 *
 * Confidence ladder:
 *   high   — single Event in time window with Opportunity-typed WhatId
 *   medium — single open Opportunity matching the account name + host
 *   low    — multiple candidate Opps; needs human disambiguation
 *   none   — no match path produced any candidates
 *
 * @param {object} meeting
 * @param {string} meeting.hostEmail
 * @param {string|Date} meeting.startTime
 * @param {string} [meeting.subject]      - Meeting title (used for diagnostic only today)
 * @param {string} [meeting.accountName]  - Claude-extracted account name (fallback path)
 * @returns {Promise<object>}
 */
async function findOppFromMeeting({ hostEmail, startTime, subject = '', accountName = '' }) {
  const details = { hostEmail, startTime, subject, accountName };

  // Resolve the host's User Id once — both tiers need it.
  const ownerId = await findUserIdByEmail(hostEmail);
  if (!ownerId) {
    logger.warn({ hostEmail }, 'No Salesforce User found for meeting host; matching cannot proceed');
    return {
      matchSource: 'none',
      matchConfidence: 'none',
      oppId: null,
      candidates: [],
      eventId: null,
      details: { ...details, reason: 'host_email_not_in_salesforce' },
    };
  }
  details.ownerId = ownerId;

  // ── Tier 1: Event lookup ──────────────────────────────────────────
  const events = await findEventsNearTime({ ownerId, startTime });
  details.eventsInWindow = events.length;

  const eventsWithOpp = events.filter(
    (e) => typeof e.WhatId === 'string' && e.WhatId.startsWith(OPPORTUNITY_ID_PREFIX)
  );

  if (eventsWithOpp.length === 1) {
    const ev = eventsWithOpp[0];
    logger.info(
      { hostEmail, eventId: ev.Id, oppId: ev.WhatId },
      'Matched meeting to Opportunity via Salesforce Event lookup (high confidence)'
    );
    return {
      matchSource: 'event',
      matchConfidence: 'high',
      oppId: ev.WhatId,
      candidates: [{ oppId: ev.WhatId, eventId: ev.Id, subject: ev.Subject }],
      eventId: ev.Id,
      details,
    };
  }

  if (eventsWithOpp.length > 1) {
    // Multiple Events in the time window all linked to Opportunities.
    // Rare but possible (e.g., a rep blocks two back-to-back meetings).
    // Caller resolves by asking the rep.
    logger.info(
      { hostEmail, eventCount: eventsWithOpp.length },
      'Multiple Events with Opportunity links in time window; returning candidates for disambiguation'
    );
    return {
      matchSource: 'event',
      matchConfidence: 'low',
      oppId: null,
      candidates: eventsWithOpp.map((e) => ({
        oppId: e.WhatId,
        eventId: e.Id,
        subject: e.Subject,
        startTime: e.StartDateTime,
      })),
      eventId: null,
      details,
    };
  }

  // ── Tier 2: Fuzzy Account name match ──────────────────────────────
  if (!accountName) {
    logger.info(
      { hostEmail },
      'No Event matched and no transcript-extracted accountName provided; cannot fuzzy-match'
    );
    return {
      matchSource: 'none',
      matchConfidence: 'none',
      oppId: null,
      candidates: [],
      eventId: null,
      details: { ...details, reason: 'no_event_and_no_account_name' },
    };
  }

  const fuzzyOpps = await findOpenOppsByAccountName({ ownerId, accountName });
  details.fuzzyCandidateCount = fuzzyOpps.length;

  if (fuzzyOpps.length === 0) {
    logger.info(
      { hostEmail, accountName },
      'No Event match and no open Opps found for transcript account name'
    );
    return {
      matchSource: 'none',
      matchConfidence: 'none',
      oppId: null,
      candidates: [],
      eventId: null,
      details: { ...details, reason: 'no_event_and_no_fuzzy_match' },
    };
  }

  if (fuzzyOpps.length === 1) {
    const opp = fuzzyOpps[0];
    logger.info(
      { hostEmail, accountName, oppId: opp.Id, oppName: opp.Name },
      'Matched meeting to Opportunity via fuzzy account name (medium confidence)'
    );
    return {
      matchSource: 'fuzzy_account',
      matchConfidence: 'medium',
      oppId: opp.Id,
      candidates: [{ oppId: opp.Id, oppName: opp.Name, accountId: opp.AccountId, stage: opp.StageName }],
      eventId: null,
      details,
    };
  }

  // Multiple open Opps match the account name — needs human resolution.
  logger.info(
    { hostEmail, accountName, candidateCount: fuzzyOpps.length },
    'Multiple open Opps match account name; returning candidates for disambiguation'
  );
  return {
    matchSource: 'fuzzy_account',
    matchConfidence: 'low',
    oppId: null,
    candidates: fuzzyOpps.map((o) => ({
      oppId: o.Id,
      oppName: o.Name,
      accountId: o.AccountId,
      stage: o.StageName,
    })),
    eventId: null,
    details,
  };
}

module.exports = {
  findOppFromMeeting,
  findUserIdByEmail,
  findEventsNearTime,
  findOpenOppsByAccountName,
  // Exported for tests
  OPPORTUNITY_ID_PREFIX,
  EVENT_TIME_TOLERANCE_MINUTES,
};
