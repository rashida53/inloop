const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const config = require('../config');
const sfTokens = require('../db/salesforce-tokens');

/**
 * Salesforce Connected App OAuth installation callback.
 *
 * Salesforce redirects here after the admin clicks "Allow" on the OAuth
 * consent screen. We exchange the authorization code for an access_token
 * + refresh_token + instance_url, look up the installing org's ID via
 * /services/oauth2/userinfo, and persist the tokens so the backend can
 * call Salesforce REST API on behalf of the org (today: write
 * Campaign_Details_Form__c records, SOQL-query Opportunity/Account).
 *
 * Registered at GET /oauth/salesforce-callback.
 *
 * Sandbox vs production: the user-agent reaches us via whichever login
 * URL the admin originally visited (login.salesforce.com for prod,
 * test.salesforce.com for sandbox). We capture that via a `state`
 * parameter the auth-URL generator sets, falling back to production.
 */
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

  if (!config.salesforceClientId || !config.salesforceClientSecret) {
    logger.error(
      'SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET not configured — cannot exchange OAuth code'
    );
    return res
      .status(500)
      .type('html')
      .send(renderError('server_misconfiguration', 'Salesforce OAuth client credentials are not configured.'));
  }

  // Choose login URL: production by default, sandbox if state=sandbox.
  // The /oauth/salesforce-start helper sets state=sandbox when the admin
  // clicks the sandbox install link.
  const loginUrl =
    state === 'sandbox'
      ? 'https://test.salesforce.com'
      : 'https://login.salesforce.com';

  try {
    const tokens = await exchangeCodeForTokens(String(code), loginUrl);
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
 * https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 */
async function exchangeCodeForTokens(code, loginUrl) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.salesforceClientId,
    client_secret: config.salesforceClientSecret,
    code,
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
