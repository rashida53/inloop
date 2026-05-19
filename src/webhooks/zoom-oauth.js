const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * Zoom OAuth installation callback.
 *
 * For account-level General Apps, Zoom redirects here after the admin
 * clicks "Allow" on the consent screen. The redirect carries an OAuth
 * `code` we can exchange for tokens — but for pure webhook delivery
 * (our use case today) we don't actually need the tokens. Zoom marks
 * the app as installed for the account simply by reaching this URL
 * with a valid code; subsequent meeting.summary_completed webhooks
 * start flowing.
 *
 * Future: if we ever need to call Zoom's API back (e.g., fetch raw
 * transcripts via recording.transcript_completed), exchange the code
 * here using ZOOM_CLIENT_ID + ZOOM_CLIENT_SECRET and persist the
 * access/refresh tokens.
 *
 * Registered at GET /oauth/callback.
 */
router.get('/callback', (req, res) => {
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

  // We never store the code or call /oauth/token because we only need
  // webhook delivery, not Zoom API access. The successful arrival of
  // this request is itself the install confirmation.
  logger.info(
    {
      state: state || null,
      codePrefix: String(code).substring(0, 8),
    },
    'Zoom OAuth callback received — app installed on account'
  );

  return res.status(200).type('html').send(renderSuccess());
});

function renderSuccess() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>InLoop — Installation Complete</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        max-width: 480px;
        margin: 80px auto;
        padding: 0 24px;
        text-align: center;
        color: #1f2328;
      }
      .icon { font-size: 56px; margin-bottom: 16px; }
      h1 { font-size: 24px; margin: 0 0 8px 0; color: #1a7f37; }
      p { color: #57606a; line-height: 1.5; }
      code {
        background: #f6f8fa;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="icon">&#9989;</div>
    <h1>InLoop installed</h1>
    <p>
      The InLoop meeting intelligence app is now installed on your Zoom account.
      <code>meeting.summary_completed</code> events will flow to InLoop from
      this point on.
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
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        max-width: 480px;
        margin: 80px auto;
        padding: 0 24px;
        text-align: center;
        color: #1f2328;
      }
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
