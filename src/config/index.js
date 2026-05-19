const port = process.env.PORT || 3000;
const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Parse a comma-separated emails env var into a normalized Set.
 * Trims, lowercases, drops empties. Used by both ALLOWED_HOST_EMAILS
 * (the MVP cohort gate) and DIGEST_SHADOW_RECIPIENTS (the testing CC).
 */
function parseEmailSet(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

module.exports = {
  port: Number(port),
  nodeEnv,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  zoomVerificationToken: process.env.ZOOM_VERIFICATION_TOKEN || '',
  idempotencyTTLSeconds: parseInt(process.env.IDEMPOTENCY_TTL || '300', 10),
  // MVP cohort gate: only meetings whose host is in this set get processed.
  // Empty Set => no gate (process all meetings). See processMeeting in server.js.
  allowedHostEmails: parseEmailSet(process.env.ALLOWED_HOST_EMAILS),
  // Testing CC: every successfully-processed meeting also DMs each of these
  // recipients with the same digest. Skipped if the recipient IS the host
  // (to avoid double-DM). Shadow delivery failures are logged but don't
  // fail the pipeline. Empty Set => no shadow delivery.
  digestShadowRecipients: parseEmailSet(process.env.DIGEST_SHADOW_RECIPIENTS),

  // InMarket Overview meetings (first-touch prospect intros) get a Highspot
  // deck link injected into the follow-up email body. Configure with the
  // canonical pitch-deck URL. If empty, the renderer omits the deck link.
  inmarketOverviewHighspotUrl: process.env.INMARKET_OVERVIEW_HIGHSPOT_URL || '',

  // RFP Review meetings render a backwards-computed timeline from the
  // campaign launch date Claude extracted. Each milestone is
  // { name, daysBeforeLaunch }. These defaults are placeholders until the
  // sales lead confirms InMarket's actual pre-launch SLAs; tune via the
  // RFP_TIMELINE_MILESTONES env var (JSON array, same shape).
  rfpTimelineMilestones: parseRfpTimeline(process.env.RFP_TIMELINE_MILESTONES),
};

function parseRfpTimeline(raw) {
  const defaults = [
    { name: 'Creative kickoff', daysBeforeLaunch: 21 },
    { name: 'Copy approval', daysBeforeLaunch: 14 },
    { name: 'Asset delivery', daysBeforeLaunch: 7 },
    { name: 'QA / final review', daysBeforeLaunch: 3 },
    { name: 'Campaign launch', daysBeforeLaunch: 0 },
  ];
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    return parsed.filter(
      (m) => m && typeof m.name === 'string' && typeof m.daysBeforeLaunch === 'number'
    );
  } catch {
    return defaults;
  }
}
