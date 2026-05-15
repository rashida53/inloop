const port = process.env.PORT || 3000;
const nodeEnv = process.env.NODE_ENV || 'development';

module.exports = {
  port: Number(port),
  nodeEnv,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  zoomVerificationToken: process.env.ZOOM_VERIFICATION_TOKEN || '',
  idempotencyTTLSeconds: parseInt(process.env.IDEMPOTENCY_TTL || '300', 10),
};
