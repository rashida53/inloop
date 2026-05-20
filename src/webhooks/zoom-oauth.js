const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const config = require('../config');
const zoomTokens = require('../db/zoom-tokens');

const ZOOM_OAUTH_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/**
 * Zoom OAuth installation callback for the General App.
 *
 * Zoom redirects here after the admin clicks "Allow" on the OAuth consent
 * screen. We exchange the authorization code for an access_token +
 * refresh_token, look up the installing account's ID via /v2/users/me,
 * and persist the tokens so the backend can call Zoom REST API on behalf
 * of the account (today: to fetch recording transcripts).
 *
 * Registered at GET /oauth/callback.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    logger.error(
      { error, errorDescription, state },
      'Zoom OAuth installation failed — admin denied or Zoom-side error'
    );
    return res
      .status(400)
      .type('html')
      .send(renderError(String(error), errorDescription ? String(errorDescription) : null));
  }

  if (!code) {
    logger.warn({ query: req.query }, 'Zoom OAuth callback hit with no `code` query param');
    return res
      .status(400)
      .type('html')
      .send(renderError('missing_code', 'No OAuth authorization code was provided.'));
  }

  if (!config.zoomClientId || !config.zoomClientSecret) {
    logger.error(
      'ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not configured — cannot exchange OAuth code'
    );
    return res
      .status(500)
      .type('html')
      .send(renderError('server_misconfiguration', 'Zoom OAuth client credentials are not configured.'));
  }

  try {
    const tokens = await exchangeCodeForTokens(String(code));
    const accountId = await fetchAccountIdFromToken(tokens.access_token);

    await zoomTokens.upsert(accountId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      scope: tokens.scope,
      expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
    });

    logger.info(
      {
        accountId,
        scope: tokens.scope,
        expiresInSeconds: tokens.expires_in,
        codePrefix: String(code).substring(0, 8),
      },
      'Zoom OAuth tokens persisted — app installed on account'
    );

    return res.status(200).type('html').send(renderSuccess());
  } catch (err) {
    logger.error(
      { err, codePrefix: String(code).substring(0, 8) },
      'Zoom OAuth token exchange or account lookup failed'
    );
    return res
      .status(500)
      .type('html')
      .send(renderError('exchange_failed', err.message || 'Token exchange failed.'));
  }
});

/**
 * Exchange an authorization code for access + refresh tokens.
 * https://developers.zoom.us/docs/integrations/oauth/#step-2
 */
async function exchangeCodeForTokens(code) {
  const credentials = Buffer.from(
    `${config.zoomClientId}:${config.zoomClientSecret}`
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
  });
  if (config.zoomOauthRedirectUri) {
    body.set('redirect_uri', config.zoomOauthRedirectUri);
  }

  const response = await fetch(ZOOM_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Zoom token exchange failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Fetch the installing account's account_id by calling /v2/users/me with
 * the freshly minted access token. The account_id is the primary key we
 * use for the token row.
 */
async function fetchAccountIdFromToken(accessToken) {
  const response = await fetch(`${ZOOM_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Zoom /users/me failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  const user = await response.json();
  if (!user.account_id) {
    throw new Error('Zoom /users/me response missing account_id');
  }
  return user.account_id;
}

function renderSuccess() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>InLoop — Installation Complete</title>
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
    <h1>InLoop installed</h1>
    <p>
      The InLoop meeting intelligence app is now installed on your Zoom account.
      Tokens have been provisioned, and <code>recording.transcript_completed</code>
      events will flow to InLoop from this point on.
    </p>
    <p>You can close this tab.</p>
  </body>
</html>`;
}

function renderError(code, description) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>InLoop — Installation Error</title>
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
    <h1>Installation error</h1>
    <p><code>${code}</code></p>
    ${description ? `<p>${description}</p>` : ''}
    <p>Please check the application logs for details.</p>
  </body>
</html>`;
}

module.exports = router;
