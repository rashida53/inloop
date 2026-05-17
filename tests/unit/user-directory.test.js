const { installDbMock } = require('../mocks/db');

const dbHandle = installDbMock();

jest.mock('../../src/integrations/slack', () => {
  const usersLookupByEmail = jest.fn();
  return {
    slackClient: { users: { lookupByEmail: usersLookupByEmail } },
    __mocks: { usersLookupByEmail },
  };
});

const { __mocks } = require('../../src/integrations/slack');
const userDirectory = require('../../src/users');
const slackFixtures = require('../fixtures/slack');

describe('userDirectory.findByEmail', () => {
  beforeEach(() => {
    dbHandle.reset();
    __mocks.usersLookupByEmail.mockReset();
  });

  test('returns null immediately when no email is provided', async () => {
    const result = await userDirectory.findByEmail('');
    expect(result).toBeNull();
    expect(dbHandle.dbMock.query).not.toHaveBeenCalled();
    expect(__mocks.usersLookupByEmail).not.toHaveBeenCalled();
  });

  test('returns cached user from DB without calling Slack', async () => {
    dbHandle.mockQueryByName({
      users_find_by_email: {
        rows: [
          {
            email: 'alice@inmarket.com',
            full_name: 'Alice Chen',
            slack_id: 'U01ALICE',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
    });

    const user = await userDirectory.findByEmail('alice@inmarket.com');

    expect(user).toMatchObject({ email: 'alice@inmarket.com', slack_id: 'U01ALICE' });
    expect(__mocks.usersLookupByEmail).not.toHaveBeenCalled();
  });

  test('lowercases and trims the email before lookup', async () => {
    dbHandle.mockQueryByName({ users_find_by_email: { rows: [] } });
    __mocks.usersLookupByEmail.mockResolvedValueOnce(slackFixtures.usersLookupByEmailSuccess);
    dbHandle.mockQueryByName({
      users_upsert_from_slack_profile: {
        rows: [
          {
            email: 'alice@inmarket.com',
            full_name: 'Alice Chen',
            slack_id: 'U01ALICE',
          },
        ],
      },
    });

    await userDirectory.findByEmail('  Alice@InMarket.COM  ');

    const slackCallArg = __mocks.usersLookupByEmail.mock.calls[0][0];
    expect(slackCallArg).toEqual({ email: 'alice@inmarket.com' });
  });

  test('falls back to Slack when DB cache misses and caches the result', async () => {
    dbHandle.mockQueryByName({ users_find_by_email: { rows: [] } });
    __mocks.usersLookupByEmail.mockResolvedValueOnce(slackFixtures.usersLookupByEmailSuccess);
    dbHandle.mockQueryByName({
      users_upsert_from_slack_profile: {
        rows: [
          {
            email: 'alice@inmarket.com',
            full_name: 'Alice Chen',
            slack_id: 'U01ALICE',
          },
        ],
      },
    });

    const user = await userDirectory.findByEmail('alice@inmarket.com');

    expect(__mocks.usersLookupByEmail).toHaveBeenCalledWith({ email: 'alice@inmarket.com' });
    expect(user.slack_id).toBe('U01ALICE');

    // Verify both query names were called in the expected order
    expect(dbHandle.findQueryCalls('users_find_by_email')).toHaveLength(1);
    expect(dbHandle.findQueryCalls('users_upsert_from_slack_profile')).toHaveLength(1);
  });

  test('returns null on users_not_found WITHOUT polluting the users table', async () => {
    dbHandle.mockQueryByName({ users_find_by_email: { rows: [] } });
    __mocks.usersLookupByEmail.mockRejectedValueOnce(slackFixtures.usersLookupByEmailNotFoundError());

    const user = await userDirectory.findByEmail('external@somewhere.com');

    expect(user).toBeNull();
    // No upsert should have happened — external emails must not be cached
    expect(dbHandle.findQueryCalls('users_upsert_from_slack_profile')).toHaveLength(0);
  });

  test('rethrows other Slack errors (auth, rate-limit, network) so the orchestrator can mark failed', async () => {
    dbHandle.mockQueryByName({ users_find_by_email: { rows: [] } });
    const authError = new Error('invalid_auth');
    authError.data = { ok: false, error: 'invalid_auth' };
    __mocks.usersLookupByEmail.mockRejectedValueOnce(authError);

    await expect(userDirectory.findByEmail('whatever@x.com')).rejects.toThrow('invalid_auth');
  });
});
