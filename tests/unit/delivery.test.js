// Mock the shared Slack client before requiring the module under test.
jest.mock('../../src/integrations/slack', () => {
  const conversationsOpen = jest.fn();
  const chatPostMessage = jest.fn();
  const usersLookupByEmail = jest.fn();
  return {
    slackClient: {
      conversations: { open: conversationsOpen },
      chat: { postMessage: chatPostMessage },
      users: { lookupByEmail: usersLookupByEmail },
    },
    __mocks: { conversationsOpen, chatPostMessage, usersLookupByEmail },
  };
});

const { __mocks } = require('../../src/integrations/slack');
const { deliverToSlack } = require('../../src/delivery');
const slackFixtures = require('../fixtures/slack');
const claudeFixtures = require('../fixtures/claude');
const zoomFixtures = require('../fixtures/zoom');
const { adaptZoomPayload } = require('../../src/adapters/zoom-adapter');

function buildArgs(target = { userId: 'U01ALICE' }) {
  const event = zoomFixtures.meetingSummaryCompleted();
  return {
    meetingSummary: adaptZoomPayload(event.object, event.event_id),
    intelligence: claudeFixtures.intelligenceJson,
    target,
  };
}

describe('deliverToSlack', () => {
  beforeEach(() => {
    Object.values(__mocks).forEach((m) => m.mockReset());
  });

  test('opens a DM channel and posts the digest for a userId target', async () => {
    __mocks.conversationsOpen.mockResolvedValueOnce(slackFixtures.conversationsOpenSuccess);
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const result = await deliverToSlack(buildArgs({ userId: 'U01ALICE' }));

    expect(__mocks.conversationsOpen).toHaveBeenCalledWith({ users: 'U01ALICE' });
    expect(__mocks.chatPostMessage).toHaveBeenCalledTimes(1);
    const postArgs = __mocks.chatPostMessage.mock.calls[0][0];
    expect(postArgs.channel).toBe('D01ALICEDM');
    expect(Array.isArray(postArgs.blocks)).toBe(true);
    expect(postArgs.blocks.length).toBeGreaterThan(0);
    expect(typeof postArgs.text).toBe('string');

    expect(result).toEqual({ ts: '1715800000.001100', channel: 'D01ALICEDM' });
  });

  test('posts directly to a channel without opening a DM when channelId is given', async () => {
    __mocks.chatPostMessage.mockResolvedValueOnce({
      ...slackFixtures.chatPostMessageSuccess,
      channel: 'C01TEAMCH',
    });

    const result = await deliverToSlack(buildArgs({ channelId: 'C01TEAMCH' }));

    expect(__mocks.conversationsOpen).not.toHaveBeenCalled();
    expect(__mocks.chatPostMessage).toHaveBeenCalledTimes(1);
    expect(__mocks.chatPostMessage.mock.calls[0][0].channel).toBe('C01TEAMCH');
    expect(result.channel).toBe('C01TEAMCH');
  });

  test('throws when neither userId nor channelId is provided in target', async () => {
    await expect(deliverToSlack(buildArgs({}))).rejects.toThrow(/userId or target.channelId/);
  });

  test('throws when meetingSummary or intelligence is missing', async () => {
    const validArgs = buildArgs();
    await expect(deliverToSlack({ ...validArgs, meetingSummary: null })).rejects.toThrow(/meetingSummary/);
    await expect(deliverToSlack({ ...validArgs, intelligence: null })).rejects.toThrow(/intelligence/);
  });

  test('retries on rate-limit and ultimately succeeds', async () => {
    __mocks.chatPostMessage
      .mockRejectedValueOnce(slackFixtures.chatPostMessageRateLimitedError(0))
      .mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const result = await deliverToSlack(buildArgs({ channelId: 'C01TEAMCH' }));

    expect(__mocks.chatPostMessage).toHaveBeenCalledTimes(2);
    expect(result.ts).toBe('1715800000.001100');
  });

  test('renders a Decision makers section in the blocks (regression — previously dropped)', async () => {
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    await deliverToSlack(buildArgs({ channelId: 'C01TEAMCH' }));

    const postArgs = __mocks.chatPostMessage.mock.calls[0][0];
    const allText = JSON.stringify(postArgs.blocks);
    expect(allText).toMatch(/Decision makers/);
  });

  test('omits the AM checklist when intelligence.playbookChecks is empty', async () => {
    // Default fixture has playbookChecks: [] — verify no section is rendered.
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);
    await deliverToSlack(buildArgs({ channelId: 'C01TEAMCH' }));

    const allText = JSON.stringify(__mocks.chatPostMessage.mock.calls[0][0].blocks);
    expect(allText).not.toMatch(/\*AM checklist:\*/);
  });

  test('renders an AM checklist section when intelligence has gIROAS gates', async () => {
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const args = buildArgs({ channelId: 'C01TEAMCH' });
    args.intelligence = {
      ...args.intelligence,
      playbookChecks: [
        {
          playbookId: 'iroas',
          gateId: 'moments_cap',
          action: 'reconcile_conflict',
          title: 'Moments allocation conflict',
          detail:
            'Client requested Moments-only but gIROAS playbook caps Moments at 30%. Reconcile with Michael Perez before next call.',
        },
        {
          playbookId: 'iroas',
          gateId: 'core_kpi',
          action: 'confirm_with_client',
          title: 'iROAS as core KPI',
          detail: 'Confirm with client that iROAS is the core KPI (CTR not optimized).',
        },
      ],
    };

    await deliverToSlack(args);

    const allText = JSON.stringify(__mocks.chatPostMessage.mock.calls[0][0].blocks);
    expect(allText).toMatch(/AM checklist/);
    expect(allText).toMatch(/Moments allocation conflict/);
    expect(allText).toMatch(/iROAS as core KPI/);
    // No emoji badges anywhere
    expect(allText).not.toMatch(/🚨|⚠️|📊|📐|⚙️/);
    // No bracket tags either (removed per user feedback as redundant
    // with the action verb already in the title)
    expect(allText).not.toMatch(/\[CONFLICT\]|\[CONFIRM\]|\[VERIFY\]|\[SIZING\]|\[SETUP\]/);
    // Source playbook labels removed per user feedback ("noise")
    expect(allText).not.toMatch(/Guaranteed iROAS/);
    expect(allText).not.toMatch(/Sales Lift Study/);
  });

  test('sorts reconcile_conflict checks before other actions', async () => {
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const args = buildArgs({ channelId: 'C01TEAMCH' });
    args.intelligence = {
      ...args.intelligence,
      playbookChecks: [
        // Intentionally place the conflict last in the input array — the
        // renderer should bubble it to the top.
        {
          playbookId: 'iroas',
          gateId: 'core_kpi',
          action: 'confirm_with_client',
          title: 'Confirm iROAS KPI',
          detail: 'Detail one',
        },
        {
          playbookId: 'iroas',
          gateId: 'moments_cap',
          action: 'reconcile_conflict',
          title: 'Moments conflict',
          detail: 'Detail two',
        },
      ],
    };

    await deliverToSlack(args);

    const blocks = __mocks.chatPostMessage.mock.calls[0][0].blocks;
    const headerIdx = blocks.findIndex(
      (b) => b.type === 'section' && b.text?.text === '*AM checklist:*'
    );
    expect(headerIdx).toBeGreaterThan(-1);

    const checkBlocks = blocks.slice(headerIdx + 1);
    const conflictBlockIdx = checkBlocks.findIndex((b) =>
      b.text?.text?.includes('Moments conflict')
    );
    const confirmBlockIdx = checkBlocks.findIndex((b) =>
      b.text?.text?.includes('Confirm iROAS KPI')
    );
    expect(conflictBlockIdx).toBeGreaterThan(-1);
    expect(confirmBlockIdx).toBeGreaterThan(conflictBlockIdx);
  });

  test('renders each AM checklist check as its own section block (Slack 3000-char cap)', async () => {
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);

    const args = buildArgs({ channelId: 'C01TEAMCH' });
    args.intelligence = {
      ...args.intelligence,
      playbookChecks: Array.from({ length: 8 }, (_, i) => ({
        playbookId: 'iroas',
        gateId: `gate_${i}`,
        action: 'internal_setup',
        title: `Check ${i}`,
        detail: 'x'.repeat(400),
      })),
    };

    await deliverToSlack(args);

    const blocks = __mocks.chatPostMessage.mock.calls[0][0].blocks;
    const headerIdx = blocks.findIndex(
      (b) => b.type === 'section' && b.text?.text === '*AM checklist:*'
    );
    expect(headerIdx).toBeGreaterThan(-1);

    const checkBlocks = blocks
      .slice(headerIdx + 1)
      .filter((b) => b.type === 'section' && /\*Check \d/.test(b.text?.text || ''));
    expect(checkBlocks).toHaveLength(8);

    for (const b of [blocks[headerIdx], ...checkBlocks]) {
      expect(b.text.text.length).toBeLessThan(3000);
    }
  });
});
