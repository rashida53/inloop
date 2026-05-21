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
    expect(typeof postArgs.text).toBe('string'); // fallback text required

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

  test('omits the Playbook checks section when intelligence.playbookChecks is empty', async () => {
    // Default fixture has playbookChecks: [] — verify no section is rendered.
    __mocks.chatPostMessage.mockResolvedValueOnce(slackFixtures.chatPostMessageSuccess);
    await deliverToSlack(buildArgs({ channelId: 'C01TEAMCH' }));

    const allText = JSON.stringify(__mocks.chatPostMessage.mock.calls[0][0].blocks);
    expect(allText).not.toMatch(/Playbook checks/);
  });

  test('renders a Playbook checks section when intelligence has gIROAS gates', async () => {
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
            'Client requested Moments-only but gIROAS playbook caps Moments at 30% of budget. Reconcile with Michael Perez before next call.',
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
    expect(allText).toMatch(/Playbook checks/);
    expect(allText).toMatch(/Moments allocation conflict/);
    expect(allText).toMatch(/iROAS as core KPI/);
    // Conflict gets the alarm badge
    expect(allText).toMatch(/🚨/);
    // Confirm-with-client gets the warning badge
    expect(allText).toMatch(/⚠️/);
    // Playbook label appears alongside each check (helps the AM know which
    // rulebook a given check came from)
    expect(allText).toMatch(/Guaranteed iROAS/);
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
    const playbookBlock = blocks.find(
      (b) => b.type === 'section' && b.text?.text?.startsWith('*Playbook checks:*')
    );
    expect(playbookBlock).toBeDefined();
    const conflictIdx = playbookBlock.text.text.indexOf('Moments conflict');
    const confirmIdx = playbookBlock.text.text.indexOf('Confirm iROAS KPI');
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(conflictIdx);
  });
});
