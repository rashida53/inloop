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

/**
 * Parse the DIGEST_HOST_CC_MAP env var into a Map<hostEmail, Set<ccEmail>>.
 * Both keys and values are normalized (trim + lowercase). Invalid JSON,
 * non-object values, or non-array CC lists are treated as empty (logged
 * silently — config errors shouldn't crash the process at boot).
 *
 * Expected shape:
 *   {
 *     "host1@inmarket.com": ["cc1@inmarket.com", "cc2@inmarket.com"],
 *     "host2@inmarket.com": ["cc3@inmarket.com"]
 *   }
 */
function parseHostCcMap(raw) {
  const out = new Map();
  if (!raw) return out;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [host, ccList] of Object.entries(parsed)) {
    if (!host || typeof host !== 'string' || !Array.isArray(ccList)) continue;
    const hostKey = host.trim().toLowerCase();
    if (!hostKey) continue;
    const ccSet = new Set(
      ccList
        .filter((e) => typeof e === 'string')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    );
    if (ccSet.size > 0) out.set(hostKey, ccSet);
  }
  return out;
}

module.exports = {
  port: Number(port),
  nodeEnv,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  zoomVerificationToken: process.env.ZOOM_VERIFICATION_TOKEN || '',
  // Zoom General App OAuth credentials, used to exchange the install code
  // for access + refresh tokens (so we can call Zoom REST API to fetch
  // recording transcripts). Find these on the Zoom Marketplace app page
  // under "App Credentials" → Client ID / Client Secret.
  zoomClientId: process.env.ZOOM_CLIENT_ID || '',
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  // Max age in seconds for the x-zm-request-timestamp anti-replay check.
  // Default 300 (5 min) per Zoom's signing recommendations. For local dev
  // it's useful to bump this much higher (e.g. 86400 = 24h) so ngrok
  // Replay of older captured webhooks doesn't trip the replay guard.
  zoomWebhookMaxAgeSeconds: parseInt(process.env.ZOOM_WEBHOOK_MAX_AGE_SECONDS || '300', 10),
  // Must match exactly what's listed in the app's OAuth Redirect URL +
  // Allow Lists. Used both when exchanging the install code and (in the
  // background) when refreshing access tokens.
  zoomOauthRedirectUri: process.env.ZOOM_OAUTH_REDIRECT_URI || '',
  idempotencyTTLSeconds: parseInt(process.env.IDEMPOTENCY_TTL || '300', 10),
  // MVP cohort gate: only meetings whose host is in this set get processed.
  // Empty Set => no gate (process all meetings). See processMeeting in server.js.
  allowedHostEmails: parseEmailSet(process.env.ALLOWED_HOST_EMAILS),
  // Testing CC: every successfully-processed meeting also DMs each of these
  // recipients with the same digest. Skipped if the recipient IS the host
  // (to avoid double-DM). Shadow delivery failures are logged but don't
  // fail the pipeline. Empty Set => no shadow delivery.
  digestShadowRecipients: parseEmailSet(process.env.DIGEST_SHADOW_RECIPIENTS),

  // Per-host CC routing. When a meeting is processed for host X, every
  // address listed under X's entry also receives the digest as a Slack DM.
  // Mirrors the shadow-recipient flow (best-effort, idempotency-free,
  // failures logged). Independent of DIGEST_SHADOW_RECIPIENTS — both fire
  // for the same meeting, but the orchestrator de-dupes so no one gets
  // double-DM'd. Empty map => no CC routing.
  digestHostCcMap: parseHostCcMap(process.env.DIGEST_HOST_CC_MAP),

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
