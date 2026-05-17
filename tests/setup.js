// Runs before any module is required. Setting NODE_ENV=test here makes
// src/utils/logger.js pick the 'silent' level so test output stays clean.
process.env.NODE_ENV = 'test';

// Provide deterministic values for modules that read these at import time.
// The mocks intercept all real network/db calls, so these are just placeholders
// to keep config validation from complaining.
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-claude-key';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test-slack-token';
process.env.ZOOM_VERIFICATION_TOKEN = process.env.ZOOM_VERIFICATION_TOKEN || 'test-zoom-token';
