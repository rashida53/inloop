/**
 * Sample Slack Web API responses and error shapes.
 * Real shape: { ok: true, ... } on success; failures throw with err.data.error.
 */

const aliceUser = {
  id: 'U01ALICE',
  name: 'alice',
  real_name: 'Alice Chen',
  profile: {
    email: 'alice@inmarket.com',
    real_name: 'Alice Chen',
    display_name: 'Alice C',
  },
};

const usersLookupByEmailSuccess = {
  ok: true,
  user: aliceUser,
};

function usersLookupByEmailNotFoundError() {
  const err = new Error('An API error occurred: users_not_found');
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: 'users_not_found' };
  return err;
}

const conversationsOpenSuccess = {
  ok: true,
  channel: { id: 'D01ALICEDM' },
};

const chatPostMessageSuccess = {
  ok: true,
  channel: 'D01ALICEDM',
  ts: '1715800000.001100',
  message: { ts: '1715800000.001100', type: 'message' },
};

function chatPostMessageRateLimitedError(retryAfter = 1) {
  const err = new Error('A Web API call returned a rate-limited error');
  err.code = 'slack_webapi_rate_limited';
  err.statusCode = 429;
  err.data = { ok: false, error: 'ratelimited', retry_after: retryAfter };
  err.headers = { 'retry-after': String(retryAfter) };
  return err;
}

module.exports = {
  aliceUser,
  usersLookupByEmailSuccess,
  usersLookupByEmailNotFoundError,
  conversationsOpenSuccess,
  chatPostMessageSuccess,
  chatPostMessageRateLimitedError,
};
