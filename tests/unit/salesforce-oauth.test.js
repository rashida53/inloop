/**
 * Salesforce OAuth callback tests.
 *
 * Mocks the DB layer (salesforce-tokens module) and global fetch — the
 * callback handler does two network calls (token exchange + identity
 * lookup) plus one DB upsert per request. All other behavior is HTML
 * rendering and config-driven branching.
 */

const express = require('express');
const request = require('supertest');

const mockUpsert = jest.fn();
jest.mock('../../src/db/salesforce-tokens', () => ({
  upsert: mockUpsert,
}));

// Reset env-driven config between tests by re-requiring the module fresh.
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

describe('GET /oauth/salesforce-callback', () => {
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
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('access_denied');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns 400 when ?code is missing', async () => {
    const router = loadOauthRouter();
    const res = await request(makeApp(router)).get('/oauth/salesforce-callback');

    expect(res.status).toBe(400);
    expect(res.text).toContain('missing_code');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('returns 500 when client credentials are not configured', async () => {
    const router = loadOauthRouter({
      SALESFORCE_CLIENT_ID: '',
      SALESFORCE_CLIENT_SECRET: '',
    });
    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'auth-code-123' });

    expect(res.status).toBe(500);
    expect(res.text).toContain('server_misconfiguration');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('happy path: exchanges code, fetches org id, persists tokens, returns 200', async () => {
    const router = loadOauthRouter();

    const tokenResponse = {
      access_token: 'acc-xyz',
      refresh_token: 'ref-xyz',
      instance_url: 'https://inmarket.my.salesforce.com',
      token_type: 'Bearer',
      scope: 'api refresh_token',
      id: 'https://login.salesforce.com/id/00DAB000000XYZ123/005USER',
      expires_in: 7200,
    };
    const identityResponse = {
      user_id: '005USER',
      organization_id: '00DAB000000XYZ123',
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => tokenResponse,
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => identityResponse,
    });
    mockUpsert.mockResolvedValueOnce({});

    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'auth-code-123' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Salesforce connected');
    expect(res.text).toContain('00DAB000000XYZ123');

    // First fetch: token exchange against login.salesforce.com (no state)
    const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('https://login.salesforce.com/services/oauth2/token');
    expect(tokenOpts.method).toBe('POST');
    expect(String(tokenOpts.body)).toContain('grant_type=authorization_code');
    expect(String(tokenOpts.body)).toContain('code=auth-code-123');

    // Second fetch: identity lookup using the returned `id` URL
    const [identityUrl, identityOpts] = fetchSpy.mock.calls[1];
    expect(identityUrl).toBe(tokenResponse.id);
    expect(identityOpts.headers.Authorization).toBe('Bearer acc-xyz');

    // Tokens persisted
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [orgId, persisted] = mockUpsert.mock.calls[0];
    expect(orgId).toBe('00DAB000000XYZ123');
    expect(persisted.access_token).toBe('acc-xyz');
    expect(persisted.refresh_token).toBe('ref-xyz');
    expect(persisted.instance_url).toBe('https://inmarket.my.salesforce.com');
    expect(persisted.login_url).toBe('https://login.salesforce.com');
    expect(persisted.expires_at).toBeInstanceOf(Date);
  });

  test('state=sandbox routes the token exchange to test.salesforce.com', async () => {
    const router = loadOauthRouter();

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

    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'sb-code', state: 'sandbox' });

    expect(res.status).toBe(200);
    const [tokenUrl] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('https://test.salesforce.com/services/oauth2/token');
    expect(mockUpsert.mock.calls[0][1].login_url).toBe('https://test.salesforce.com');
  });

  test('returns 500 when token exchange fails', async () => {
    const router = loadOauthRouter();

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"invalid_grant"}',
    });

    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'bad-code' });

    expect(res.status).toBe(500);
    expect(res.text).toContain('exchange_failed');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('returns 500 when identity lookup fails', async () => {
    const router = loadOauthRouter();

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

    const res = await request(makeApp(router))
      .get('/oauth/salesforce-callback')
      .query({ code: 'auth-code' });

    expect(res.status).toBe(500);
    expect(res.text).toContain('exchange_failed');
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
