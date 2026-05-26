const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const config = require('../config');
const sfTokens = require('../db/salesforce-tokens');

/**
 * Salesforce Connected App OAuth installation flow with PKCE.
 *
 * Required because InMarket's Connected App has "Require Proof Key for
 * Code Exchange (PKCE) Extension" enabled — a security setting that
 * blocks plain authorization-code flows. Without a code_challenge in
 * the authorize request and a matching code_verifier in the token
 * exchange, Salesforce returns:
 *   error=invalid_request&error_description=missing required code challenge
 *
 * Two routes:
 *   GET /oauth/salesforce-start
 *     - Generates a verifier+challenge pair
 *     - Stores the verifier server-side keyed by a random state
 *     - 302 redirects to Salesforce's authorize endpoint with the challenge
 *
 *   GET /oauth/salesforce-callback
 *     - Reads state from the query string
 *     - Looks up the verifier from the cache
 *     - Exchanges code+verifier for access_token + refresh_token + instance_url
 *     - Persists tokens to salesforce_org_tokens
 *
 * Sandbox routing: append ?sandbox=true to /oauth/salesforce-start to
 * install against test.salesforce.com instead of login.salesforce.com.
 * The chosen login_url is stored alongside the verifier so the callback
 * doesn't need to re-derive it.
 */

// In-memory PKCE state cache. Each /oauth/salesforce-start call stores
// { verifier, loginUrl, expiresAt } here keyed by a random state token.
// The callback retrieves and deletes the entry on completion.
//
// 10-minute TTL is generous — the round trip through Salesforce login
// usually takes seconds. Self-cleaning on each insert/read.
//
// In-memory works for a single-instance dev server. Multi-instance
// deployments would need Redis-backed storage so any instance can
// complete an OAuth flow initiated on a different instance.
const pkceStateCache = new Map();
const PKCE_STATE_TTL_MS = 10 * 60 * 1000;

function pruneExpiredPkceStates() {
  const now = Date.now();
  for (const [key, value] of pkceStateCache) {
    if (value.expiresAt < now) pkceStateCache.delete(key);
  }
}

function generatePkceVerifier() {
  // RFC 7636 requires 43-128 URL-safe characters. 32 random bytes
  // base64url-encode to exactly 43 chars — the minimum.
  return crypto.randomBytes(32).toString('base64url');
}

function pkceChallengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Initiate a PKCE-enabled OAuth install flow.
 *
 * Hit this URL in a browser:
 *   /oauth/salesforce-start            → installs against production
 *   /oauth/salesforce-start?sandbox=true → installs against test.salesforce.com
 *
 * Server generates a verifier, stores it, and 302-redirects to
 * Salesforce with the matching challenge. The user logs in there,
 * approves the consent screen, and Salesforce redirects back to
 * /oauth/salesforce-callback with the authorization code + state.
 */
router.get('/salesforce-start', (req, res) => {
  if (!config.salesforceClientId || !config.salesforceOauthRedirectUri) {
    logger.error(
      'SALESFORCE_CLIENT_ID / SALESFORCE_OAUTH_REDIRECT_URI not configured — cannot initiate OAuth flow'
    );
    return res
      .status(500)
      .type('html')
      .send(
        renderError(
          'server_misconfiguration',
          'Salesforce OAuth env vars are not set.'
        )
      );
  }

  const isSandbox = req.query.sandbox === 'true' || req.query.sandbox === '1';
  const loginUrl = isSandbox
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  const verifier = generatePkceVerifier();
  const challenge = pkceChallengeFor(verifier);
  const state = crypto.randomBytes(16).toString('base64url');

  pruneExpiredPkceStates();
  pkceStateCache.set(state, {
    verifier,
    loginUrl,
    expiresAt: Date.now() + PKCE_STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.salesforceClientId,
    redirect_uri: config.salesforceOauthRedirectUri,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${loginUrl}/services/oauth2/authorize?${params.toString()}`;

  logger.info(
    {
      statePrefix: state.substring(0, 8) + '...',
      loginUrl,
      isSandbox,
    },
    'Salesforce OAuth install initiated — redirecting to Salesforce authorize endpoint'
  );

  res.redirect(authorizeUrl);
});

router.get('/salesforce-callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    logger.error(
      { error, errorDescription, state },
      'Salesforce OAuth installation failed — admin denied or Salesforce-side error'
    );
    return res
      .status(400)
      .type('html')
      .send(renderError(String(error), errorDescription ? String(errorDescription) : null));
  }

  if (!code) {
    logger.warn(
      { query: req.query },
      'Salesforce OAuth callback hit with no `code` query param'
    );
    return res
      .status(400)
      .type('html')
      .send(renderError('missing_code', 'No OAuth authorization code was provided.'));
  }

  if (!state) {
    logger.warn(
      { query: req.query },
      'Salesforce OAuth callback hit with no `state` query param — install was not initiated via /oauth/salesforce-start'
    );
    return res
      .status(400)
      .type('html')
      .send(
        renderError(
          'missing_state',
          'No state parameter. Start the install at /oauth/salesforce-start instead of constructing the URL manually.'
        )
      );
  }

  // Retrieve and remove the cached verifier — single-use, even if the
  // exchange ultimately fails (forces the user to restart the flow,
  // which is the right semantic for a failed install).
  const cached = pkceStateCache.get(String(state));
  pkceStateCache.delete(String(state));
  if (!cached) {
    logger.warn(
      { statePrefix: String(state).substring(0, 8) + '...' },
      'Salesforce OAuth callback state not found in cache — expired or fabricated'
    );
    return res
      .status(400)
      .type('html')
      .send(
        renderError(
          'unknown_state',
          'OAuth state expired or unknown. Restart the install at /oauth/salesforce-start.'
        )
      );
  }
  const { verifier, loginUrl } = cached;

  if (!config.salesforceClientId || !config.salesforceClientSecret) {
    logger.error(
      'SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET not configured — cannot exchange OAuth code'
    );
    return res
      .status(500)
      .type('html')
      .send(renderError('server_misconfiguration', 'Salesforce OAuth client credentials are not configured.'));
  }

  try {
    const tokens = await exchangeCodeForTokens(String(code), loginUrl, verifier);
    const orgId = await fetchOrgIdFromToken(tokens.access_token, tokens.id);

    await sfTokens.upsert(orgId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      instance_url: tokens.instance_url,
      token_type: tokens.token_type,
      scope: tokens.scope,
      identity_url: tokens.id,
      login_url: loginUrl,
      expires_at: new Date(Date.now() + (tokens.expires_in || 7200) * 1000),
    });

    logger.info(
      {
        orgId,
        instanceUrl: tokens.instance_url,
        scope: tokens.scope,
        expiresInSeconds: tokens.expires_in,
        loginUrl,
        codePrefix: String(code).substring(0, 8),
      },
      'Salesforce OAuth tokens persisted — Connected App installed on org'
    );

    return res.status(200).type('html').send(renderSuccess(orgId, tokens.instance_url));
  } catch (err) {
    logger.error(
      { err, codePrefix: String(code).substring(0, 8) },
      'Salesforce OAuth token exchange or org lookup failed'
    );
    return res
      .status(500)
      .type('html')
      .send(renderError('exchange_failed', err.message || 'Token exchange failed.'));
  }
});

/**
 * Exchange an authorization code for access + refresh tokens.
 * Includes the PKCE `code_verifier` so Salesforce can hash it and
 * confirm it matches the code_challenge sent during /authorize.
 * https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 */
async function exchangeCodeForTokens(code, loginUrl, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.salesforceClientId,
    client_secret: config.salesforceClientSecret,
    code,
    code_verifier: codeVerifier,
  });
  if (config.salesforceOauthRedirectUri) {
    body.set('redirect_uri', config.salesforceOauthRedirectUri);
  }

  const url = `${loginUrl}/services/oauth2/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce token exchange failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Resolve the installing org's 18-char organization_id.
 *
 * The token-exchange response includes an `id` URL pointing at the
 * Identity API for the authenticated user. Hitting it returns the
 * user's organization_id (among other identity fields).
 */
async function fetchOrgIdFromToken(accessToken, identityUrl) {
  if (!identityUrl) {
    throw new Error('Token response missing `id` (identity URL) — cannot resolve org');
  }
  const response = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce identity lookup failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  const identity = await response.json();
  if (!identity.organization_id) {
    throw new Error('Salesforce identity response missing organization_id');
  }
  return identity.organization_id;
}

function renderSuccess(orgId, instanceUrl) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>InLoop — Salesforce Installation Complete</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #1f2328; }
      .icon { font-size: 56px; margin-bottom: 16px; }
      h1 { font-size: 24px; margin: 0 0 8px 0; color: #1a7f37; }
      p { color: #57606a; line-height: 1.5; }
      code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="icon">&#9989;</div>
    <h1>Salesforce connected</h1>
    <p>InLoop is now authorized to write Campaign Details records into Salesforce on behalf of org <code>${orgId}</code>.</p>
    <p>Instance: <code>${instanceUrl}</code></p>
    <p>You can close this tab.</p>
  </body>
</html>`;
}

function renderError(code, description) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>InLoop — Salesforce Installation Error</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #1f2328; }
      .icon { font-size: 56px; margin-bottom: 16px; }
      h1 { font-size: 24px; margin: 0 0 8px 0; color: #cf222e; }
      p { color: #57606a; line-height: 1.5; }
      code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <div class="icon">&#10060;</div>
    <h1>Salesforce installation error</h1>
    <p><code>${code}</code></p>
    ${description ? `<p>${description}</p>` : ''}
    <p>Please check the application logs for details.</p>
  </body>
</html>`;
}

module.exports = router;
