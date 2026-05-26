const { Anthropic } = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');
const { buildPlaybooksPromptContext } = require('./playbooks');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
const EFFORT = process.env.CLAUDE_EFFORT || 'high';
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '4096', 10);
const TRANSCRIPT_MAX_CHARS = parseInt(process.env.CLAUDE_TRANSCRIPT_MAX_CHARS || '120000', 10);

const client = new Anthropic({ apiKey: config.claudeApiKey });

const MEETING_TYPES = ['inmarket_overview', 'rfp_review', 'internal', 'other'];

const extractionSchema = {
  type: 'object',
  properties: {
    meetingType: {
      type: 'string',
      enum: MEETING_TYPES,
      description:
        'Discriminator used by downstream rendering. See system prompt for taxonomy.',
    },
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

    // Type-specific fields. ALL are required by schema, but Claude populates
    // only the ones matching meetingType — others are empty strings/arrays.
    // The delivery layer's per-type renderers read the relevant fields.

    // For meetingType === 'inmarket_overview'
    customerProfile: {
      type: 'object',
      properties: {
        industry: { type: 'string' },
        companySize: { type: 'string' },
        stakeholders: { type: 'array', items: { type: 'string' } },
      },
      required: ['industry', 'companySize', 'stakeholders'],
      additionalProperties: false,
    },
    amHandoffItems: { type: 'array', items: { type: 'string' } },

    // For meetingType === 'rfp_review'
    // Format: ISO-8601 date string (YYYY-MM-DD), or empty string if undiscussed.
    // The orchestrator's renderer computes timeline milestones backwards from this.
    campaignLaunchDate: { type: 'string' },

    // For meetingType === 'internal'
    setupBlockers: { type: 'array', items: { type: 'string' } },
    audienceRequests: { type: 'array', items: { type: 'string' } },
    materialsNeeded: { type: 'array', items: { type: 'string' } },

    // AM playbook checks — populated when the transcript indicates one or
    // more of InMarket's AM playbooks (Guaranteed iROAS, Sales Lift Study)
    // apply. Empty array when no playbook is triggered. See the playbook
    // context block in the system prompt for the trigger keywords and the
    // gate definitions Claude maps against.
    playbookChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          playbookId: { type: 'string', enum: ['iroas', 'sales_lift'] },
          gateId: { type: 'string' },
          action: {
            type: 'string',
            enum: [
              'confirm_with_client',
              'internal_check',
              'internal_setup',
              'sizing_check',
              'reconcile_conflict',
            ],
          },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['playbookId', 'gateId', 'action', 'title', 'detail'],
        additionalProperties: false,
      },
    },

    // Bucket B for the Salesforce Campaign Details Form. Populated when
    // meetingType is rfp_review or inmarket_overview (i.e., sales-pitch
    // meetings); all fields empty/zero for internal/other meetings.
    //
    // The downstream salesforce-cds.js module merges this output with
    // the Opp-derived Bucket A and inserts a Campaign_Details_Form__c
    // record. Conventions in this object mirror how InMarket AMs fill
    // out the CDS today (see 2026-05-26 sample task in Asana):
    //   - geoTargeting + momentsTargeting: SHORT labels, not long lists
    //   - notes: structured multi-plan format with pricing per plan
    //   - primaryKpi vs primaryKpiClientBenchmark: distinct concepts
    //   - budget tiers: full dollars as numbers, ordered by rep preference
    campaignDetails: {
      type: 'object',
      properties: {
        internalDueDate: { type: 'string' },
        momentsVsAudiencesAllocation: { type: 'string' },
        areThereFlightedBudgets: { type: 'string', enum: ['Yes', 'No', ''] },
        budgetGoalTier1: { type: 'number' },
        budgetGoalTier2: { type: 'number' },
        budgetGoalTier3: { type: 'number' },
        customMocksNeeded: { type: 'string', enum: ['Yes', 'No', ''] },
        campaignCreativeType: { type: 'array', items: { type: 'string' } },
        primaryKpi: { type: 'string' },
        primaryKpiClientBenchmark: { type: 'string' },
        secondaryKpi: { type: 'string' },
        secondaryKpiClientBenchmark: { type: 'string' },
        geoTargeting: { type: 'string' },
        viewabilityGoals: { type: 'string' },
        brandSafetyGoals: { type: 'string' },
        fraudGoals: { type: 'string' },
        momentsTargeting: { type: 'string' },
        audiencesOutOfLocationTargeting: { type: 'string' },
        proposedAddedValue: { type: 'string', enum: ['Yes', 'No', ''] },
        notes: { type: 'string' },
      },
      required: [
        'internalDueDate',
        'momentsVsAudiencesAllocation',
        'areThereFlightedBudgets',
        'budgetGoalTier1',
        'budgetGoalTier2',
        'budgetGoalTier3',
        'customMocksNeeded',
        'campaignCreativeType',
        'primaryKpi',
        'primaryKpiClientBenchmark',
        'secondaryKpi',
        'secondaryKpiClientBenchmark',
        'geoTargeting',
        'viewabilityGoals',
        'brandSafetyGoals',
        'fraudGoals',
        'momentsTargeting',
        'audiencesOutOfLocationTargeting',
        'proposedAddedValue',
        'notes',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'meetingType',
    'followUpEmail',
    'salesforceNotes',
    'customerProfile',
    'amHandoffItems',
    'campaignLaunchDate',
    'setupBlockers',
    'audienceRequests',
    'materialsNeeded',
    'playbookChecks',
    'campaignDetails',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a concise, sales-focused B2B SaaS meeting intelligence assistant for InMarket's revenue operations team.

First, classify the meeting into one of these types using the meetingType field:

- "inmarket_overview" — An introductory meeting with a new client or agency
  prospect. The meeting is centered on presenting InMarket's products, capabilities,
  or value proposition to people unfamiliar with us. External attendees from a
  company that appears to be a first-touch prospect.

- "rfp_review" — A meeting reviewing an RFP, proposal, or campaign specifics
  with an existing prospect or client. Signals: explicit mention of "RFP" or
  "proposal", a specific campaign being scoped, discussion of a campaign launch
  date, asset/creative review, or pricing for a defined opportunity.

- "internal" — A meeting with InMarket employees only (every attendee email
  ends in @inmarket.com). Topics typically include campaign setup, pre-sales
  material requests, audience reach planning, or operational coordination.

- "other" — Anything that doesn't clearly fit the above three. When uncertain,
  use "other" rather than guessing.

Type-specific fields to populate based on the meetingType you chose:

For "inmarket_overview":
- customerProfile: { industry, companySize, stakeholders[] } — best-effort
  from what's said about the customer
- amHandoffItems: 3-5 concrete items the Account Manager needs to action to
  move this into the RFP intake process (e.g. "schedule kickoff call with
  customer ops contact", "confirm budget cycle with finance")

For "rfp_review":
- campaignLaunchDate: ISO-8601 date (YYYY-MM-DD) if a campaign launch date
  was discussed and confirmed; empty string if not yet decided

For "internal":
- setupBlockers: open items blocking campaign setup
- audienceRequests: audience-reach asks made during the call (e.g. "need
  audience size estimates for QSR vertical in Atlanta DMA")
- materialsNeeded: pre-sales decks, one-pagers, case studies requested

For "rfp_review" and "inmarket_overview" — also populate campaignDetails:

  campaignDetails is the Bucket B pre-fill for InMarket's Salesforce
  Campaign Details Form (CDS). Follow the AM team's conventions exactly,
  because the AM picks up the CDS draft and either accepts it or has to
  rewrite — get these right and they'll accept it:

  - internalDueDate: ISO-8601 date for InMarket's internal turnaround
    (when the brief is due back to the client). If not stated, default
    to 5 business days from the meeting date. Empty string if the
    meeting wasn't about a proposal.

  - momentsVsAudiencesAllocation: budget split as "X/Y" where X is the
    Moments percentage and Y is the Audiences (Preceptivity) percentage.
    Examples: "50/50", "70/30", "Moments-only", "100/0". Empty string if
    not discussed.

  - areThereFlightedBudgets: "Yes" only if multiple separate flights are
    discussed (e.g., BTS launch + holiday push as separate flights).
    "No" otherwise (default). Empty string only if you cannot tell.

  - budgetGoalTier1/Tier2/Tier3: in FULL DOLLARS as numbers (e.g.,
    500000, NOT 500 or "$500k"). Tier 1 is the REP'S PRIMARY plan, NOT
    the largest amount — could be the most ambitious or the safest,
    depends on how the rep ordered them in the call. Tier 2 is the
    second-preference plan, Tier 3 is the third. Use 0 for tiers that
    weren't discussed.

  - customMocksNeeded: "Yes" if the rep mentioned needing custom creative
    mocks for the client. "No" if standard creative will be used or it
    wasn't discussed.

  - campaignCreativeType: array selecting from these exact values:
    "Static", "GIF", "Rich Media", "Social", "CTV", "OLV",
    "Landing Page", "DOOH", "High-Impact". Empty array if not specified.

  - primaryKpi vs primaryKpiClientBenchmark: TWO DIFFERENT CONCEPTS.
    primaryKpi is what InMarket OPTIMIZES TO (the operational dial:
    "Clicks", "Delivery", "Impressions", "CTR"). primaryKpiClientBenchmark
    is what the CLIENT MEASURES SUCCESS BY (the business outcome:
    "iROAS", "Sales Lift", "DIF", "Incremental Sales"). Don't put
    iROAS in primaryKpi — that's a benchmark, not an optimization target.

  - secondaryKpi / secondaryKpiClientBenchmark: same distinction, for
    secondary metrics.

  - geoTargeting: SHORT label — e.g., "National - see notes below",
    "Publix only", "Whole Foods + Sprouts + Meijer". Long retailer
    lists belong in notes, not here. Field is Text(255).

  - viewabilityGoals / brandSafetyGoals / fraudGoals: typically empty
    in early-stage discovery calls. Only populate if explicitly stated.

  - momentsTargeting: SHORT label — e.g., "InPath and InStore",
    "InStore only", "Push notifications at point-of-purchase". Detailed
    audience segments belong in audiencesOutOfLocationTargeting.

  - audiencesOutOfLocationTargeting: long-form audience description.
    Include: known shoppers of specific retailers, competitor brand
    buyers (name them), category buyers, geotypes (e.g., "Moms with
    kids in HH, primary shoppers"), new-to-brand / lapsed purchasers.
    Multi-bullet structure is fine.

  - proposedAddedValue: "Yes" if InMarket is offering bonus impressions,
    free creative, free insights, sales lift study, or similar value-
    adds beyond paid media. "No" otherwise.

  - notes: STRUCTURED plan/pricing detail. When multiple plans are
    discussed, format as a numbered list with budget, CPE, CPM, bonus
    impressions per plan. Example shape (from a real meeting):

      Three plans:
      1. Publix only $150k, 5% bonus, sales lift study. CPE: .70, CPM $7.00
      2. gIROAS $500k, national retailers, 15% bonus impressions. CPE: .60, CPM $6.00
      3. gIROAS $300k, national retailers, 10% bonus impressions. CPE: .65, CPM $6.50

    This is the AM's primary reference when staffing the campaign — make
    it scannable. If only one plan was discussed, use a single paragraph
    with the same fields (budget, CPE, CPM, bonus, lift study yes/no).

For "internal" and "other" meetingTypes, return campaignDetails with all
fields empty (empty strings, 0 for numbers, empty array for the creative
type array).

For any other field that doesn't apply to the chosen meetingType, return
an empty string (for string fields) or empty array (for array fields).
Do not invent data. customerProfile object fields can be empty strings
if not discussed.

Then, for every meeting you process, return two artifacts:

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
- Write in clean, professional language suitable for sales and customer success.

${buildPlaybooksPromptContext()}`;

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
