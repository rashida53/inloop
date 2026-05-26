// Mock the Anthropic SDK before requiring the module under test.
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({ messages: { create } }));
  // Expose the create fn on the constructor so tests can grab it.
  Anthropic.__create = create;
  return { Anthropic };
});

const { Anthropic } = require('@anthropic-ai/sdk');
const claudeFixtures = require('../fixtures/claude');

const { extractMeetingIntelligence } = require('../../src/extraction/claude');

const transcript = 'Bob asked about pricing tiers. Alice proposed a 90-day pilot at $50k.';
const metadata = {
  title: 'Acme Q2 SaaS evaluation',
  organizer: 'alice@inmarket.com',
  meetingDate: '2026-05-15T14:00:00Z',
  accountName: 'Acme',
  opportunityName: 'Acme — Analytics Pilot',
};

describe('extractMeetingIntelligence', () => {
  beforeEach(() => {
    Anthropic.__create.mockReset();
  });

  test('returns parsed { followUpEmail, salesforceNotes } on success', async () => {
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);

    const result = await extractMeetingIntelligence(transcript, metadata);

    expect(result).toEqual(claudeFixtures.intelligenceJson);
    expect(Anthropic.__create).toHaveBeenCalledTimes(1);
    const call = Anthropic.__create.mock.calls[0][0];
    expect(call.model).toMatch(/^claude-opus-4-7/);
    expect(call.output_config.format.type).toBe('json_schema');
    expect(call.output_config.format.schema).toBeDefined();
    expect(call.output_config.effort).toBeDefined();
  });

  test('throws a "refusal" error when stop_reason is refusal', async () => {
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateRefusal);

    await expect(extractMeetingIntelligence(transcript, metadata)).rejects.toMatchObject({
      stopReason: 'refusal',
      message: expect.stringMatching(/refused/i),
    });
  });

  test('throws a "max_tokens" error when stop_reason is max_tokens', async () => {
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateMaxTokens);

    await expect(extractMeetingIntelligence(transcript, metadata)).rejects.toMatchObject({
      stopReason: 'max_tokens',
      message: expect.stringMatching(/truncated/i),
    });
  });

  test('rethrows transport errors from the Anthropic SDK', async () => {
    const sdkError = new Error('network down');
    sdkError.status = 503;
    Anthropic.__create.mockRejectedValueOnce(sdkError);

    await expect(extractMeetingIntelligence(transcript, metadata)).rejects.toThrow('network down');
  });

  test('rejects when transcript is empty or whitespace', async () => {
    await expect(extractMeetingIntelligence('', metadata)).rejects.toThrow(/required/i);
    await expect(extractMeetingIntelligence('   \n  ', metadata)).rejects.toThrow(/required/i);
  });

  test('schema requires campaignDetails with all 20 CDS Bucket B fields', async () => {
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    await extractMeetingIntelligence(transcript, metadata);

    const schema = Anthropic.__create.mock.calls[0][0].output_config.format.schema;
    expect(schema.required).toContain('campaignDetails');

    const cd = schema.properties.campaignDetails;
    expect(cd.type).toBe('object');
    // Spot-check the AM-convention-distinguishing fields are present
    expect(cd.required).toEqual(
      expect.arrayContaining([
        'primaryKpi',
        'primaryKpiClientBenchmark',
        'secondaryKpi',
        'secondaryKpiClientBenchmark',
        'budgetGoalTier1',
        'budgetGoalTier2',
        'budgetGoalTier3',
        'momentsVsAudiencesAllocation',
        'geoTargeting',
        'momentsTargeting',
        'audiencesOutOfLocationTargeting',
        'notes',
      ])
    );
    // 20 fields total
    expect(cd.required.length).toBe(20);
    // Numbers for budget tiers (full dollars, not "$500k" strings)
    expect(cd.properties.budgetGoalTier1.type).toBe('number');
    // Multi-picklist as array
    expect(cd.properties.campaignCreativeType.type).toBe('array');
    // Yes/No enums for the three picklists
    expect(cd.properties.areThereFlightedBudgets.enum).toEqual(['Yes', 'No', '']);
    expect(cd.properties.customMocksNeeded.enum).toEqual(['Yes', 'No', '']);
    expect(cd.properties.proposedAddedValue.enum).toEqual(['Yes', 'No', '']);
  });

  test('system prompt includes the AM conventions for Bucket B', async () => {
    Anthropic.__create.mockResolvedValueOnce(claudeFixtures.messagesCreateSuccess);
    await extractMeetingIntelligence(transcript, metadata);

    const systemPrompt = Anthropic.__create.mock.calls[0][0].system[0].text;

    // Distinct concept: KPI vs Client Benchmark
    expect(systemPrompt).toMatch(/primaryKpi vs primaryKpiClientBenchmark/i);
    expect(systemPrompt).toMatch(/optimi[sz]es to/i);
    expect(systemPrompt).toMatch(/client measures success/i);

    // Short labels for Geo and Moments
    expect(systemPrompt).toMatch(/SHORT label/);

    // Budget tiers in full dollars, ordered by rep preference
    expect(systemPrompt).toMatch(/FULL DOLLARS/);
    expect(systemPrompt).toMatch(/REP'S PRIMARY plan/);

    // Notes structured format
    expect(systemPrompt).toMatch(/Three plans/);
    expect(systemPrompt).toMatch(/CPE.*CPM/);
  });
});
