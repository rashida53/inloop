const { Anthropic } = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
const EFFORT = process.env.CLAUDE_EFFORT || 'high';
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '4096', 10);
const TRANSCRIPT_MAX_CHARS = parseInt(process.env.CLAUDE_TRANSCRIPT_MAX_CHARS || '120000', 10);

const client = new Anthropic({ apiKey: config.claudeApiKey });

const extractionSchema = {
  type: 'object',
  properties: {
    followUpEmail: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        recipients: { type: 'array', items: { type: 'string' } },
        contextSummary: { type: 'string' },
      },
      required: ['subject', 'body', 'recipients', 'contextSummary'],
      additionalProperties: false,
    },
    salesforceNotes: {
      type: 'object',
      properties: {
        dealStage: { type: 'string' },
        opportunityName: { type: 'string' },
        accountName: { type: 'string' },
        closeDate: { type: 'string' },
        forecastCategory: { type: 'string' },
        confidenceScore: { type: 'string' },
        painPoints: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
        decisionMakers: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        productFitHighlights: { type: 'string' },
        notesSummary: { type: 'string' },
      },
      required: [
        'dealStage',
        'opportunityName',
        'accountName',
        'closeDate',
        'forecastCategory',
        'confidenceScore',
        'painPoints',
        'nextSteps',
        'decisionMakers',
        'risks',
        'productFitHighlights',
        'notesSummary',
      ],
      additionalProperties: false,
    },
  },
  required: ['followUpEmail', 'salesforceNotes'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a concise, sales-focused B2B SaaS meeting intelligence assistant for a revenue operations team.

For each meeting you process, return two artifacts:

1. followUpEmail — a clean, actionable follow-up email containing:
   - subject: a short, specific subject line
   - body: a concise email body with timeline, owners, and clear next actions
   - recipients: stakeholder emails or names mentioned in the conversation
   - contextSummary: a brief internal recap for handoff

2. salesforceNotes — structured CRM notes:
   - dealStage: the most accurate Salesforce deal stage from buying signals
   - opportunityName / accountName: the deal and the customer
   - closeDate: best estimated close date, or "" if not discussed
   - forecastCategory: Commit | Best Case | Pipeline | Discovery (or similar)
   - confidenceScore: a short rationale-backed confidence estimate
   - painPoints: 3-5 concrete buyer pain points
   - nextSteps: 3-5 owned, actionable next steps
   - decisionMakers: names and roles of key stakeholders
   - risks: top objections or risks
   - productFitHighlights: why this solution fits this customer now
   - notesSummary: a concise narrative summary for Salesforce notes

Guidelines:
- Read the entire transcript before answering.
- Favor specifics from the transcript over generic sales advice.
- If a field cannot be inferred, return a short honest fallback ("unknown", "" for strings; [] for arrays).
- Write in clean, professional language suitable for sales and customer success.`;

function buildMetadataContext(metadata) {
  return [
    `Meeting title: ${metadata.title || 'N/A'}`,
    `Organizer: ${metadata.organizer || 'N/A'}`,
    `Meeting date: ${metadata.meetingDate || 'unknown'}`,
    `Company / account: ${metadata.accountName || 'unknown'}`,
    `Opportunity name: ${metadata.opportunityName || 'unknown'}`,
  ].join('\n');
}

function truncateTranscript(transcript) {
  if (transcript.length <= TRANSCRIPT_MAX_CHARS) return transcript;
  return `${transcript.slice(0, TRANSCRIPT_MAX_CHARS)}\n... [transcript truncated to fit model context]`;
}

function buildUserMessage(transcript, metadata) {
  return `Meeting context:
${buildMetadataContext(metadata)}

Transcript:
${truncateTranscript(transcript)}`;
}

async function extractMeetingIntelligence(transcript, metadata = {}) {
  if (!config.claudeApiKey) {
    throw new Error('Missing Claude API key (CLAUDE_API_KEY)');
  }
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new Error('Transcript text is required for Claude extraction');
  }

  const meetingContext = {
    title: metadata.title || '',
    organizer: metadata.organizer || metadata.host || '',
    meetingDate: metadata.meetingDate || '',
    accountName: metadata.accountName || metadata.company || '',
    opportunityName: metadata.opportunityName || '',
  };

  const start = Date.now();
  logger.info(
    { metadata: meetingContext, model: CLAUDE_MODEL, effort: EFFORT },
    'Starting Claude meeting intelligence extraction'
  );

  let response;
  try {
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: extractionSchema },
        effort: EFFORT,
      },
      messages: [{ role: 'user', content: buildUserMessage(transcript, meetingContext) }],
    });
  } catch (err) {
    logger.error(
      { err, metadata: meetingContext, status: err.status, type: err.type },
      'Claude API request failed'
    );
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    const err = new Error('Claude refused to process the meeting transcript');
    err.stopReason = 'refusal';
    err.stopDetails = response.stop_details;
    logger.error(
      { metadata: meetingContext, stopDetails: response.stop_details },
      err.message
    );
    throw err;
  }
  if (response.stop_reason === 'max_tokens') {
    const err = new Error(
      `Claude output truncated at max_tokens=${MAX_TOKENS}; raise CLAUDE_MAX_TOKENS`
    );
    err.stopReason = 'max_tokens';
    logger.error(
      { metadata: meetingContext, usage: response.usage, maxTokens: MAX_TOKENS },
      err.message
    );
    throw err;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude response did not contain a text block');
  }

  const extracted = JSON.parse(textBlock.text);

  logger.info(
    {
      metadata: meetingContext,
      durationMs: Date.now() - start,
      usage: response.usage,
    },
    'Claude meeting intelligence extraction completed'
  );

  return extracted;
}

module.exports = { extractMeetingIntelligence };
