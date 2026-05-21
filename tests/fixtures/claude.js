/**
 * Sample responses from the Anthropic Messages API.
 * Shape matches what client.messages.create() returns when output_config.format
 * is set to a JSON schema — the response body comes back as a single text block
 * containing JSON conformant to the schema.
 */

const intelligenceJson = {
  meetingType: 'rfp_review',
  followUpEmail: {
    subject: 'Acme pilot — MSA + kickoff',
    body:
      'Hi Bob,\n\nGreat connecting today. As discussed:\n• Pilot at $50k for 90 days, scoped to analytics\n• MSA from us by Friday\n• Pilot kickoff confirmed by Monday after procurement review\n\nLet me know if anything changes.\n\nBest,\nAlice',
    recipients: ['bob@acme.com'],
    contextSummary: 'Acme is doing a 90-day pilot at $50k. Decision-making moves to procurement Monday.',
  },
  // Type-specific fields. The fixture's meetingType is "rfp_review", so the
  // RFP fields are populated and the inmarket_overview / internal fields
  // are empty arrays/strings — same shape Claude produces in production.
  customerProfile: { industry: '', companySize: '', stakeholders: [] },
  amHandoffItems: [],
  campaignLaunchDate: '2026-08-15',
  setupBlockers: [],
  audienceRequests: [],
  materialsNeeded: [],
  // No playbook triggers in this transcript fixture — Claude's expected
  // output is an empty array. Tests that exercise playbook rendering
  // override this field with synthetic checks.
  playbookChecks: [],
  salesforceNotes: {
    dealStage: 'Pilot Agreed',
    opportunityName: 'Acme — Analytics Pilot',
    accountName: 'Acme',
    closeDate: '',
    forecastCategory: 'Best Case',
    confidenceScore: 'Medium — pilot agreed, procurement gate remains',
    painPoints: [
      'Enterprise tier $80k/year was off-budget for FY26',
      'Procurement adds approval latency',
      'Needs ROI proof before full commitment',
    ],
    nextSteps: [
      'Alice to send MSA by Friday',
      'Bob to confirm pilot kickoff by Monday',
      'Schedule mid-pilot check at day 30',
    ],
    decisionMakers: ['Bob Customer (Acme, Director of Ops)'],
    risks: [
      'Procurement could delay signature',
      'If analytics module alone underperforms, full deal stalls',
    ],
    productFitHighlights:
      'Acme already collects the source data the analytics module needs; integration is low-effort.',
    notesSummary:
      'Pilot agreed at $50k for 90 days on the analytics module. MSA pending Friday; kickoff confirmation Monday after procurement review.',
  },
};

const messagesCreateSuccess = {
  id: 'msg_01ABCTEST',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [{ type: 'text', text: JSON.stringify(intelligenceJson) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 480,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const messagesCreateRefusal = {
  id: 'msg_01REFUSAL',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [],
  stop_reason: 'refusal',
  stop_details: {
    category: 'cyber',
    explanation: 'Refused for safety policy reasons.',
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};

const messagesCreateMaxTokens = {
  id: 'msg_01MAXTOKENS',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [{ type: 'text', text: '{"followUpEmail": {"subject": "Truncated' }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 1200, output_tokens: 4096 },
};

module.exports = {
  intelligenceJson,
  messagesCreateSuccess,
  messagesCreateRefusal,
  messagesCreateMaxTokens,
};
