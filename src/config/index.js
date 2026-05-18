const port = process.env.PORT || 3000;
const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Parse ALLOWED_HOST_EMAILS into a normalized Set.
 * Format: comma-separated emails, e.g. "alice@x.com, bob@y.com".
 * Empty/unset = no gate (process every meeting).
 */
function parseAllowedHostEmails(raw) {
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
  allowedHostEmails: parseAllowedHostEmails(process.env.ALLOWED_HOST_EMAILS),
};
