const config = require('../config');
const logger = require('../utils/logger');
const { slackClient } = require('../integrations/slack');

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;
const MAX_SECTION_TEXT = 1200;
const MAX_BLOCKS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(text, maxLength) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function normalizeList(value, limit = Infinity) {
  let items;
  if (!value) items = [];
  else if (Array.isArray(value)) items = value.filter(Boolean).map(String);
  else
    items = String(value)
      .split(/\r?\n|\|/)
      .map((item) => item.trim())
      .filter(Boolean);

  return limit === Infinity ? items : items.slice(0, limit);
}

function formatMeetingDate(iso) {
  if (!iso) return 'Unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatAttendee(attendee) {
  if (!attendee) return '';
  const name = attendee.name && attendee.name !== 'Unknown' ? attendee.name : null;
  const email = attendee.email;
  if (name && email && !email.startsWith('attendee-')) return `${name} <${email}>`;
  return name || email || 'Unknown';
}

function buildField(label, value, maxChars = 200) {
  return {
    type: 'mrkdwn',
    text: `*${label}:* ${truncateText(String(value || 'N/A'), maxChars)}`,
  };
}

function buildListSection(title, items, maxItems = 5) {
  const list = normalizeList(items, maxItems);
  const text = list.length
    ? list.map((item) => `• ${truncateText(item, 130)}`).join('\n')
    : 'None identified.';

  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${title}:*\n${text}` },
  };
}

// Badge prefix per playbook check action — keeps the rendering visually
// consistent with the action enum defined in the playbook rule files.
const ACTION_BADGES = {
  reconcile_conflict: '🚨',
  confirm_with_client: '⚠️',
  internal_check: '📊',
  sizing_check: '📐',
  internal_setup: '⚙️',
};

const PLAYBOOK_LABELS = {
  iroas: 'Guaranteed iROAS',
  sales_lift: 'Sales Lift Study',
};

/**
 * Render Claude's playbookChecks output as a single Slack section.
 * Returns null when there are no checks — callers should treat null as
 * "no section to add" rather than including an empty block.
 *
 * Visual order: reconcile_conflict first (most urgent), then the rest.
 * Within each action group, ordering is whatever Claude produced — usually
 * tracks the gate order in the playbook rule files.
 */
function buildPlaybookChecksSection(playbookChecks) {
  if (!Array.isArray(playbookChecks) || playbookChecks.length === 0) {
    return null;
  }

  const sortedChecks = [...playbookChecks].sort((a, b) => {
    if (a.action === 'reconcile_conflict' && b.action !== 'reconcile_conflict') return -1;
    if (b.action === 'reconcile_conflict' && a.action !== 'reconcile_conflict') return 1;
    return 0;
  });

  const lines = sortedChecks.slice(0, 10).map((check) => {
    const badge = ACTION_BADGES[check.action] || '•';
    const playbook = PLAYBOOK_LABELS[check.playbookId] || check.playbookId;
    const title = truncateText(check.title || 'Untitled check', 100);
    const detail = truncateText(check.detail || '', 280);
    return `${badge} *${title}* _(${playbook})_\n${detail}`;
  });

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Playbook checks:*\n${lines.join('\n\n')}`,
    },
  };
}

/**
 * Public entry point. Dispatches to a per-meeting-type renderer based on
 * intelligence.meetingType (set by the Claude extraction classifier).
 *
 * For now, every type renderer delegates to buildDefaultBlocks — no
 * observable behavior change. Per-type rendering (Highspot deck injection
 * for inmarket_overview, computed timeline for rfp_review, blockers/asks
 * highlight for internal) gets filled in incrementally as sales-lead
 * requirements are confirmed.
 */
function buildBlocks(meetingSummary, intelligence) {
  const type = intelligence?.meetingType || 'other';
  switch (type) {
    case 'inmarket_overview':
      return buildOverviewBlocks(meetingSummary, intelligence);
    case 'rfp_review':
      return buildRfpBlocks(meetingSummary, intelligence);
    case 'internal':
      return buildInternalBlocks(meetingSummary, intelligence);
    default:
      return buildDefaultBlocks(meetingSummary, intelligence);
  }
}

// Per-type renderers. Today each is a pass-through to the default renderer;
// they exist as named slots so per-type work lands here without touching
// the dispatcher.

/**
 * Inmarket Overview digest. First-touch meetings with new prospects.
 * Builds the standard digest but augments the follow-up email body with
 * the canonical Highspot deck link, and appends an AM Handoff section
 * with the specific items the AM needs to file the RFP intake.
 */
function buildOverviewBlocks(meetingSummary, intelligence) {
  const augmented = {
    ...intelligence,
    followUpEmail: {
      ...intelligence.followUpEmail,
      body: appendHighspotIfConfigured(intelligence.followUpEmail?.body || ''),
    },
  };

  const blocks = buildDefaultBlocks(meetingSummary, augmented);

  const handoff = intelligence.amHandoffItems;
  if (Array.isArray(handoff) && handoff.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(buildListSection('AM Handoff', handoff, 6));
  }

  return blocks;
}

function appendHighspotIfConfigured(body) {
  const url = (config.inmarketOverviewHighspotUrl || '').trim();
  if (!url) return body;
  const prefix = body && body.trim() ? `${body}\n\n` : '';
  return `${prefix}Here's the deck we walked through: ${url}`;
}

/**
 * RFP Review digest. Currently identical to the default renderer.
 *
 * The computed campaign timeline that was here previously was removed per
 * sales lead feedback. Claude still extracts `campaignLaunchDate` and it
 * persists into meetings.intelligence — adding the timeline back is just
 * a render change if needed.
 */
function buildRfpBlocks(meetingSummary, intelligence) {
  return buildDefaultBlocks(meetingSummary, intelligence);
}

/**
 * Internal meeting digest. Custom structure tailored to operational
 * meetings: blockers up top, then audience/materials asks, then a brief
 * summary. Skips the salesforce/follow-up-email sections that aren't
 * relevant when the meeting was internal-only.
 */
function buildInternalBlocks(meetingSummary, intelligence) {
  const attendees = Array.isArray(meetingSummary.attendees) ? meetingSummary.attendees : [];
  const blockers = intelligence.setupBlockers;
  const audienceRequests = intelligence.audienceRequests;
  const materialsNeeded = intelligence.materialsNeeded;
  const notes = intelligence.salesforceNotes || {};

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Internal meeting digest', emoji: true },
    },
    {
      type: 'section',
      fields: [
        buildField('Meeting', meetingSummary.title),
        buildField('Date', formatMeetingDate(meetingSummary.startTime)),
      ],
    },
  ];

  if (attendees.length) {
    const lines = attendees
      .slice(0, 8)
      .map((attendee) => `• ${truncateText(formatAttendee(attendee), 120)}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Attendees:*\n${lines}` },
    });
  }

  blocks.push({ type: 'divider' });

  // Blockers most important — render first even if empty (acts as audit signal).
  blocks.push(buildListSection('🚧 Setup blockers', blockers, 5));
  blocks.push(buildListSection('Audience requests', audienceRequests, 5));
  blocks.push(buildListSection('Pre-sales materials needed', materialsNeeded, 5));

  if (Array.isArray(notes.nextSteps) && notes.nextSteps.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(buildListSection('Next steps', notes.nextSteps, 5));
  }

  if (notes.notesSummary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary:*\n${truncateText(notes.notesSummary, MAX_SECTION_TEXT)}`,
      },
    });
  }

  if (blocks.length > MAX_BLOCKS) {
    return blocks.slice(0, MAX_BLOCKS - 1).concat({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Additional details removed to keep Slack mobile-friendly._',
      },
    });
  }

  return blocks;
}

/**
 * Default Block Kit renderer — pre-typing behavior, used for `other` and
 * (currently) every other meeting type. Reads from a normalized MeetingSummary
 * (adapter output) and the extracted intelligence (claude.js output).
 */
function buildDefaultBlocks(meetingSummary, intelligence) {
  // Note: intelligence.followUpEmail is still generated by Claude and persisted
  // to meetings.intelligence — we just don't render it per sales lead feedback.
  // Same for forecast/confidence. They're available in the DB for future use
  // (search, brag doc, etc.) without re-running Claude.
  const { salesforceNotes } = intelligence;
  const attendees = Array.isArray(meetingSummary.attendees) ? meetingSummary.attendees : [];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Meeting Digest', emoji: true },
    },
    {
      type: 'section',
      fields: [
        buildField('Meeting', meetingSummary.title),
        buildField('Account', salesforceNotes.accountName),
        buildField('Opportunity', salesforceNotes.opportunityName),
        buildField('Date', formatMeetingDate(meetingSummary.startTime)),
        buildField('Stage', salesforceNotes.dealStage, 140),
      ],
    },
  ];

  if (attendees.length) {
    const lines = attendees
      .slice(0, 8)
      .map((attendee) => `• ${truncateText(formatAttendee(attendee), 120)}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Contacts on call:*\n${lines}` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push(buildListSection('Next steps', salesforceNotes.nextSteps, 5));
  blocks.push({ type: 'divider' });

  blocks.push(buildListSection('Pain points', salesforceNotes.painPoints, 5));
  blocks.push(buildListSection('Decision makers', salesforceNotes.decisionMakers, 4));
  blocks.push(buildListSection('Key risks', salesforceNotes.risks, 4));

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Product fit highlights:*\n${truncateText(
        salesforceNotes.productFitHighlights || 'Not specified.',
        MAX_SECTION_TEXT
      )}`,
    },
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Notes summary:*\n${truncateText(
        salesforceNotes.notesSummary || 'Not specified.',
        MAX_SECTION_TEXT
      )}`,
    },
  });

  // Playbook checks (gIROAS / Sales Lift) — only render when Claude
  // detected one or more playbooks apply to this meeting. Placed at the
  // bottom so it doesn't push the standard digest content off-screen on
  // mobile when checks aren't relevant.
  const playbookSection = buildPlaybookChecksSection(intelligence.playbookChecks);
  if (playbookSection) {
    blocks.push({ type: 'divider' });
    blocks.push(playbookSection);
  }

  if (blocks.length > MAX_BLOCKS) {
    return blocks.slice(0, MAX_BLOCKS - 1).concat({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Additional details removed to keep Slack mobile-friendly._',
      },
    });
  }

  return blocks;
}

function isRateLimitedError(err) {
  if (!err) return false;
  return (
    err.code === 'slack_webapi_rate_limited' ||
    err.data?.error === 'ratelimited' ||
    err.statusCode === 429 ||
    err.data?.retry_after != null
  );
}

async function callSlackWithRetries(callName, fn) {
  let attempt = 0;
  let lastError;

  while (attempt < MAX_RETRIES) {
    attempt += 1;
    try {
      const result = await fn();
      logger.debug({ callName, attempt, result: result?.ok }, 'Slack API call attempt');
      return result;
    } catch (err) {
      lastError = err;
      const retryAfter = Number(
        err.data?.retry_after ??
          err.headers?.['retry-after'] ??
          err.headers?.['Retry-After'] ??
          0
      );
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      const shouldRetry = isRateLimitedError(err) && attempt < MAX_RETRIES;

      logger.warn(
        {
          callName,
          attempt,
          error: err.message,
          slackError: err.data?.error,
          statusCode: err.statusCode,
          retryAfter,
          shouldRetry,
        },
        'Slack API call failed'
      );

      if (!shouldRetry) break;

      await sleep(waitMs);
    }
  }

  const error = new Error(
    `Slack API failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'unknown'}`
  );
  error.original = lastError;
  throw error;
}

async function openDirectMessageChannel(userId) {
  const response = await callSlackWithRetries('conversations.open', () =>
    slackClient.conversations.open({ users: userId })
  );

  if (!response.ok || !response.channel?.id) {
    const err = new Error('Slack conversations.open did not return a valid channel');
    err.response = response;
    throw err;
  }

  return response.channel.id;
}

async function postMessage(channel, blocks, fallbackText) {
  const response = await callSlackWithRetries('chat.postMessage', () =>
    slackClient.chat.postMessage({
      channel,
      text: fallbackText,
      blocks,
      mrkdwn: true,
    })
  );

  if (!response.ok) {
    const err = new Error('Slack chat.postMessage returned a non-ok response');
    err.response = response;
    throw err;
  }

  return response;
}

/**
 * Post a meeting digest to Slack.
 *
 * @param {object} args
 * @param {object} args.meetingSummary - Normalized MeetingSummary from adaptZoomPayload.
 * @param {object} args.intelligence   - { followUpEmail, salesforceNotes } from extractMeetingIntelligence.
 * @param {object} args.target         - Where to post: { userId } (DM) or { channelId } (channel).
 * @returns {Promise<{ts: string, channel: string}>}
 */
async function deliverToSlack({ meetingSummary, intelligence, target } = {}) {
  if (!config.slackBotToken) {
    throw new Error('Missing Slack bot token (SLACK_BOT_TOKEN)');
  }
  if (!meetingSummary || typeof meetingSummary !== 'object') {
    throw new Error('deliverToSlack: meetingSummary is required (from adaptZoomPayload)');
  }
  if (!intelligence || !intelligence.followUpEmail || !intelligence.salesforceNotes) {
    throw new Error(
      'deliverToSlack: intelligence with { followUpEmail, salesforceNotes } is required (from extractMeetingIntelligence)'
    );
  }
  const { userId, channelId } = target || {};
  if (!userId && !channelId) {
    throw new Error('deliverToSlack: target.userId or target.channelId is required');
  }

  const destination = channelId || (await openDirectMessageChannel(userId));
  const blocks = buildBlocks(meetingSummary, intelligence);
  const fallbackText = `Meeting digest: ${
    meetingSummary.title || intelligence.salesforceNotes.accountName || 'sales meeting update'
  }`;

  const start = Date.now();
  logger.info(
    {
      destination,
      userId,
      channelId,
      zoomMeetingId: meetingSummary.zoomMeetingId,
    },
    'Sending meeting digest to Slack'
  );

  const result = await postMessage(destination, blocks, fallbackText);

  logger.info(
    {
      destination,
      ts: result.ts,
      durationMs: Date.now() - start,
      zoomMeetingId: meetingSummary.zoomMeetingId,
    },
    'Slack meeting digest sent successfully'
  );

  return { ts: result.ts, channel: destination };
}

module.exports = { deliverToSlack };
