const logger = require('../utils/logger');
const config = require('../config');
const sfTokens = require('../db/salesforce-tokens');

// Salesforce REST API version. v60.0 is Spring '24 (broadly supported).
// Update when InMarket's org bumps API access.
const API_VERSION = 'v60.0';

// Refresh the access token if it expires in less than this many seconds.
// 5 minutes of headroom — enough to cover any in-flight request without
// paying a refresh on every single call.
const REFRESH_AHEAD_SECONDS = 300;

/**
 * Return a valid (non-expired) access token + instance_url for the given
 * Salesforce org. Transparently refreshes if the stored access_token is
 * expired or about to expire.
 *
 * Salesforce, unlike Zoom, does NOT rotate refresh tokens on every
 * refresh by default — the refresh_token is long-lived (org-configurable,
 * default ~90 days of inactivity). We still upsert the whole row in case
 * the org enables rotation.
 *
 * @param {string} [orgId] - Salesforce org ID; omitted means "most
 *   recently installed org" (single-org MVP convenience).
 * @returns {Promise<{access_token: string, instance_url: string}>}
 * @throws if no install exists for this org, or refresh fails
 */
async function ensureValidAccessToken(orgId = null) {
  const row = orgId
    ? await sfTokens.findByOrgId(orgId)
    : await sfTokens.findCurrent();

  if (!row) {
    throw new Error(
      orgId
        ? `No Salesforce OAuth tokens stored for org ${orgId} — has an admin installed the Connected App?`
        : 'No Salesforce OAuth tokens stored — has an admin installed the Connected App?'
    );
  }

  const expiresAt = new Date(row.expires_at);
  const secondsUntilExpiry = (expiresAt.getTime() - Date.now()) / 1000;
  if (secondsUntilExpiry > REFRESH_AHEAD_SECONDS) {
    return { access_token: row.access_token, instance_url: row.instance_url };
  }

  logger.info(
    { orgId: row.org_id, secondsUntilExpiry },
    'Salesforce access token near expiry — refreshing'
  );
  const refreshed = await refreshTokens(row.refresh_token, row.login_url);

  // Refresh response may or may not include a new refresh_token (rotation
  // setting is org-configurable). Fall back to the existing one when the
  // response omits it.
  await sfTokens.upsert(row.org_id, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || row.refresh_token,
    instance_url: refreshed.instance_url || row.instance_url,
    token_type: refreshed.token_type,
    scope: refreshed.scope,
    identity_url: refreshed.id || row.identity_url,
    login_url: row.login_url,
    // Salesforce refresh responses don't always include expires_in.
    // When missing, assume the org's typical session_security_level
    // (default 2 hours). Conservative TTL → more refreshes, no functional
    // impact.
    expires_at: new Date(Date.now() + (refreshed.expires_in || 7200) * 1000),
  });

  return {
    access_token: refreshed.access_token,
    instance_url: refreshed.instance_url || row.instance_url,
  };
}

/**
 * Exchange a refresh token for a new access token.
 * https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_refresh_token_flow.htm
 */
async function refreshTokens(refreshToken, loginUrl) {
  if (!config.salesforceClientId || !config.salesforceClientSecret) {
    throw new Error('SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.salesforceClientId,
    client_secret: config.salesforceClientSecret,
    refresh_token: refreshToken,
  });

  const url = `${loginUrl || 'https://login.salesforce.com'}/services/oauth2/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce token refresh failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Create a new sObject record via REST API.
 *
 * @param {string} objectName - e.g. "Campaign_Details_Form__c"
 * @param {object} fields - field name → value map
 * @param {string} [orgId] - optional org ID; defaults to current install
 * @returns {Promise<{id: string, success: boolean, errors: array}>}
 */
async function createRecord(objectName, fields, orgId = null) {
  const { access_token, instance_url } = await ensureValidAccessToken(orgId);
  const url = `${instance_url}/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce createRecord(${objectName}) failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Update fields on an existing sObject record. Salesforce returns 204
 * No Content on success; this function resolves to true.
 *
 * @param {string} objectName
 * @param {string} recordId - 15- or 18-char Salesforce ID
 * @param {object} fields - partial field map
 * @param {string} [orgId]
 * @returns {Promise<boolean>}
 */
async function updateRecord(objectName, recordId, fields, orgId = null) {
  const { access_token, instance_url } = await ensureValidAccessToken(orgId);
  const url = `${instance_url}/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce updateRecord(${objectName}/${recordId}) failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return true;
}

/**
 * Fetch an sObject record by ID.
 *
 * @param {string} objectName
 * @param {string} recordId
 * @param {string[]} [fields] - optional fields to project; default all
 * @param {string} [orgId]
 */
async function getRecord(objectName, recordId, fields = null, orgId = null) {
  const { access_token, instance_url } = await ensureValidAccessToken(orgId);
  const params = fields && fields.length > 0 ? `?fields=${fields.join(',')}` : '';
  const url = `${instance_url}/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}${params}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce getRecord(${objectName}/${recordId}) failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Run a SOQL query. Used for Opportunity/Account fuzzy matching.
 *
 * @param {string} soql - e.g. "SELECT Id, Name FROM Opportunity WHERE Name LIKE '%Taylor%'"
 * @param {string} [orgId]
 * @returns {Promise<{totalSize: number, done: boolean, records: object[]}>}
 */
async function queryRecords(soql, orgId = null) {
  const { access_token, instance_url } = await ensureValidAccessToken(orgId);
  const url = `${instance_url}/services/data/${API_VERSION}/query/?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce SOQL query failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

/**
 * Describe an sObject — returns field metadata including picklist values.
 * Used to validate that our extracted picklist values (Brand Vertical,
 * Primary KPI, etc.) match what Salesforce accepts before writing.
 *
 * Result is large — consider caching at call sites.
 *
 * @param {string} objectName
 * @param {string} [orgId]
 */
async function describeObject(objectName, orgId = null) {
  const { access_token, instance_url } = await ensureValidAccessToken(orgId);
  const url = `${instance_url}/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/describe/`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Salesforce describeObject(${objectName}) failed: ${response.status} ${response.statusText} — ${text}`
    );
  }
  return await response.json();
}

module.exports = {
  ensureValidAccessToken,
  createRecord,
  updateRecord,
  getRecord,
  queryRecords,
  describeObject,
  // Exported for tests
  API_VERSION,
};
