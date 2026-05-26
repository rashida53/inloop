/**
 * Salesforce OAuth callback tests with PKCE.
 *
 * The flow is now two-step:
 *   1. GET /oauth/salesforce-start generates verifier+challenge, stores
 *      verifier server-side keyed by random state, redirects to Salesforce
 *   2. GET /oauth/salesforce-callback looks up verifier by state and
 *      includes code_verifier in the token exchange
 *
 * Most callback tests use a helper that calls /salesforce-start first
 * to populate the cache, then extracts state from the redirect URL to
 * use in the callback request. This exercises the cache integration
 * without exposing internals.
 */

const express = require('express');
const request = require('supertest');
const { URL } = require('url');

const mockUpsert = jest.fn();
jest.mock('../../src/db/salesforce-tokens', () => ({
  upsert: mockUpsert,
}));

function loadOauthRouter(env = {}) {
  jest.resetModules();
  const original = { ...process.env };
  Object.assign(process.env, {
    SALESFORCE_CLIENT_ID: 'test-client-id',
    SALESFORCE_CLIENT_SECRET: 'test-client-secret',
    SALESFORCE_OAUTH_REDIRECT_URI: 'https://example.com/oauth/salesforce-callback',
    ...env,
  });
  try {
    return require('../../src/webhooks/salesforce-oauth');
  } finally {
    process.env = original;
  }
}

function makeApp(router) {
  const app = express();
  app.use('/oauth', router);
  return app;
}

/**
 * Initiate the OAuth flow via /salesforce-start (which populates the
 * PKCE cache), follow the 302 redirect, and return the state value the
 * server registered. Callers use this to make a valid callback request.
 */
async function startFlow(app, sandbox = false) {
  const startRes = await request(app)
    .get('/oauth/salesforce-start')
    .query(sandbox ? { sandbox: 'true' } : {});
  expect(startRes.status).toBe(302);
  const location = new URL(startRes.headers.location);
  return {
    state: location.searchParams.get('state'),
    codeChallenge: location.searchParams.get('code_challenge'),
    codeChallengeMethod: location.searchParams.get('code_challenge_method'),
    authorizeHost: location.origin,
    authorizeUrl: startRes.headers.location,
  };
}

describe('GET /oauth/salesforce-start (PKCE init)', () => {
  test('returns 302 redirect to login.salesforce.com by default', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router)).get('/oauth/salesforce-start');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/login\.salesforce\.com\/services\/oauth2\/authorize\?/);
  });

  test('returns 302 redirect to test.salesforce.com when ?sandbox=true', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router))
      .get('/oauth/salesforce-start')
      .query({ sandbox: 'true' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/test\.salesforce\.com\/services\/oauth2\/authorize\?/);
  });

  test('authorize URL includes PKCE challenge and S256 method', async () => {
    const router = loadOauthRouter();
    const { codeChallenge, codeChallengeMethod, state } = await startFlow(makeApp(router));

    // SHA-256 base64url is 43 chars (no padding)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallengeMethod).toBe('S256');
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeGreaterThan(10);
  });

  test('authorize URL includes client_id, redirect_uri, response_type', async () => {
    const router = loadOauthRouter();
    const { authorizeUrl } = await startFlow(makeApp(router));
    const url = new URL(authorizeUrl);

    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/oauth/salesforce-callback');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  test('returns 500 when client credentials are not configured', async () => {
    const router = loadOauthRouter({ SALESFORCE_CLIENT_ID: '' });
    const res = await request(makeApp(router)).get('/oauth/salesforce-start');

    expect(res.status).toBe(500);
    expect(res.text).toContain('server_misconfiguration');
  });

  test('each call generates a fresh state and challenge', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const first = await startFlow(app);
    const second = await startFlow(app);

    expect(first.state).not.toBe(second.state);
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
  });
});

describe('GET /oauth/salesforce-callback (PKCE complete)', () => {
  let fetchSpy;

  beforeEach(() => {
    mockUpsert.mockReset();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('returns 400 + HTML when ?error is present', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ error: 'access_denied', error_description: 'User denied' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('access_denied');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 400 when ?code is missing', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router)).get('/oauth/salesforce-callback');
    expect(res.status).toBe(400);
    expect(res.text).toContain('missing_code');
  });

  test('returns 400 when ?state is missing', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('missing_state');
  });

  test('returns 400 when ?state is not in the cache (expired or fabricated)', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'abc', state: 'totally-fake-state-token' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('unknown_state');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('happy path: state in cache → token exchange includes code_verifier → tokens persist', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state, codeChallenge } = await startFlow(app);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'acc-xyz',
        refresh_token: 'ref-xyz',
        instance_url: 'https://inmarket.my.salesforce.com',
        token_type: 'Bearer',
        scope: 'api refresh_token',
        id: 'https://login.salesforce.com/id/00DAB000000XYZ123/005USER',
        expires_in: 7200,
      }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        organization_id: '00DAB000000XYZ123',
      }),
    });
    mockUpsert.mockResolvedValueOnce({});

    const res = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'auth-code-123', state });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Salesforce connected');

    // The token exchange POST body must include code_verifier — verify
    // that, plus that its sha256-base64url matches the code_challenge
    // the server originally sent to Salesforce.
    const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('https://login.salesforce.com/services/oauth2/token');
    const body = String(tokenOpts.body);
    expect(body).toMatch(/grant_type=authorization_code/);
    expect(body).toMatch(/code=auth-code-123/);
    expect(body).toMatch(/code_verifier=[A-Za-z0-9_-]+/);

    // Verify the verifier matches the challenge sent earlier
    const verifierMatch = body.match(/code_verifier=([^&]+)/);
    expect(verifierMatch).not.toBeNull();
    const sentVerifier = decodeURIComponent(verifierMatch[1]);
    const crypto = require('crypto');
    const expectedChallenge = crypto.createHash('sha256').update(sentVerifier).digest('base64url');
    expect(expectedChallenge).toBe(codeChallenge);

    // Tokens persisted
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [orgId, persisted] = mockUpsert.mock.calls[0];
    expect(orgId).toBe('00DAB000000XYZ123');
    expect(persisted.login_url).toBe('https://login.salesforce.com');
  });

  test('sandbox state routes the token exchange to test.salesforce.com', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state } = await startFlow(app, true);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'acc',
        refresh_token: 'ref',
        instance_url: 'https://inmarket--sb.sandbox.my.salesforce.com',
        id: 'https://test.salesforce.com/id/00DSB000000SAND/005USER',
        expires_in: 7200,
      }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organization_id: '00DSB000000SAND' }),
    });
    mockUpsert.mockResolvedValueOnce({});

    const res = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'sb-code', state });

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://test.salesforce.com/services/oauth2/token');
    expect(mockUpsert.mock.calls[0][1].login_url).toBe('https://test.salesforce.com');
  });

  test('state is single-use: reusing the same state after success returns 400', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state } = await startFlow(app);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'a',
        refresh_token: 'r',
        instance_url: 'https://x.salesforce.com',
        id: 'https://login.salesforce.com/id/00DAB/005USER',
        expires_in: 7200,
      }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organization_id: '00DAB' }),
    });
    mockUpsert.mockResolvedValueOnce({});

    const firstRes = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'first-code', state });
    expect(firstRes.status).toBe(200);

    const secondRes = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'second-code', state });
    expect(secondRes.status).toBe(400);
    expect(secondRes.text).toContain('unknown_state');
  });

  test('state is also single-use after a failed exchange', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state } = await startFlow(app);

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'invalid_grant',
    });

    const firstRes = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'bad-code', state });
    expect(firstRes.status).toBe(500);

    // State should still be consumed — second attempt fails.
    const secondRes = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'retry-code', state });
    expect(secondRes.status).toBe(400);
    expect(secondRes.text).toContain('unknown_state');
  });

  test('returns 500 when token exchange fails', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state } = await startFlow(app);

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"invalid_grant"}',
    });

    const res = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'bad-code', state });

    expect(res.status).toBe(500);
    expect(res.text).toContain('exchange_failed');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('returns 500 when identity lookup fails', async () => {
    const router = loadOauthRouter();
    const app = makeApp(router);
    const { state } = await startFlow(app);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'acc',
        refresh_token: 'ref',
        instance_url: 'https://x.salesforce.com',
        id: 'https://login.salesforce.com/id/00DAB/005USER',
        expires_in: 7200,
      }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid token',
    });

    const res = await request(app)
      .get('/oauth/salesforce-callback')
      .query({ code: 'auth-code', state });

    expect(res.status).toBe(500);
    expect(res.text).toContain('exchange_failed');
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
