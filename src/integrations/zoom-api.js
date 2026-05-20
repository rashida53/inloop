const logger = require('../utils/logger');
const config = require('../config');
const zoomTokens = require('../db/zoom-tokens');

const ZOOM_OAUTH_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

// Refresh the access token if it expires in less than this many seconds.
// 5 minutes of headroom — enough to cover any reasonable in-flight request
// without paying a refresh on every single call.
const REFRESH_AHEAD_SECONDS = 300;

/**
 * Return a valid (non-expired) access token for the given Zoom account.
 * Transparently refreshes if the stored token is expired or about to
 * expire. Persists the rotated tokens (Zoom rotates both access and
 * refresh tokens on every refresh).
 *
 * @param {string} accountId - Zoom account ID
 * @returns {Promise<string>} - A valid access token
 * @throws if no install exists for this account, or refresh fails
 */
async function ensureValidAccessToken(accountId) {
  const row = await zoomTokens.findByAccountId(accountId);
  if (!row) {
    throw new Error(
      `No Zoom OAuth tokens stored for account ${accountId} — has an admin installed the app?`
    );
  }

  const expiresAt = new Date(row.expires_at);
  const secondsUntilExpiry = (expiresAt.getTime() - Date.now()) / 1000;
  if (secondsUntilExpiry > REFRESH_AHEAD_SECONDS) {
    return row.access_token;
  }

  logger.info(
    { accountId, secondsUntilExpiry },
    'Zoom access token near expiry — refreshing'
  );
  const refreshed = await refreshTokens(row.refresh_token);

  await zoomTokens.upsert(accountId, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    token_type: refreshed.token_type,
    scope: refreshed.scope,
    expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000),
  });

  return refreshed.access_token;
}

/**
 * Exchange a refresh token for a new access + refresh token pair.
 * Zoom rotates refresh tokens — the old refresh_token is invalidated
 * once this call succeeds.
 */
async function refreshTokens(refreshToken) {
  if (!config.zoomClientId || !config.zoomClientSecret) {
    throw new Error('ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not configured');
  }
  const credentials = Buffer.from(
    `${config.zoomClientId}:${config.zoomClientSecret}`
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

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
      `Zoom token refresh failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Fetch the recording metadata for a Zoom meeting, including the
 * download URLs for each recording file (audio, video, transcript).
 *
 * @param {string} meetingIdOrUuid - Zoom meeting numeric ID or UUID
 * @param {string} accountId - Zoom account that owns the meeting
 * @returns {Promise<object>} - Full /recordings response
 */
async function getMeetingRecordings(meetingIdOrUuid, accountId) {
  const accessToken = await ensureValidAccessToken(accountId);
  const url = `${ZOOM_API_BASE}/meetings/${encodeURIComponent(meetingIdOrUuid)}/recordings`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Zoom getMeetingRecordings(${meetingIdOrUuid}) failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Download the body of a recording file (VTT, MP4, M4A) given its
 * download_url.
 *
 * Zoom recording download URLs use a different auth scheme than the
 * /v2 REST API: they expect the token via `?access_token=` query
 * parameter, NOT an Authorization Bearer header.
 *
 * Two valid token sources:
 *   1. `download_token` from the webhook event payload — short-lived
 *      JWT scoped specifically to the files in that event. Preferred
 *      when available because no scope check is performed.
 *   2. OAuth access token — broader-scoped, requires
 *      `cloud_recording:read:recording:admin` on the install.
 *
 * @param {string} downloadUrl - The download_url from a recording_files entry
 * @param {string} accountId - Zoom account that owns the recording
 * @param {string} [downloadToken] - Optional download_token from the webhook event
 * @returns {Promise<string>} - The file body as text (for VTT)
 */
async function downloadRecordingFile(downloadUrl, accountId, downloadToken = null) {
  const authToken =
    downloadToken && downloadToken.length > 0
      ? downloadToken
      : await ensureValidAccessToken(accountId);

  // Zoom recording downloads expect the token as a query param, not a header.
  const url = new URL(downloadUrl);
  url.searchParams.set('access_token', authToken);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Zoom downloadRecordingFile failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.text();
}

module.exports = {
  ensureValidAccessToken,
  getMeetingRecordings,
  downloadRecordingFile,
};
