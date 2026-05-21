-- Migration 005: Salesforce OAuth tokens, one row per installing Salesforce org.
--
-- The Salesforce Connected App OAuth install flow (GET /oauth/salesforce-callback)
-- delivers a short-lived authorization code. We exchange that code for an
-- access_token + refresh_token via POST {login_url}/services/oauth2/token
-- and persist them here so the backend can call Salesforce REST API on
-- behalf of the installing org.
--
-- Use case today: write Campaign_Details_Form__c records from meeting
-- transcripts and SOQL-query existing Opportunity/Account records to
-- match transcripts to the right opp. Future: write Tasks/Events,
-- update Opportunity stages, etc.
--
-- Multi-tenancy: each Salesforce org has its own instance_url (e.g.
-- "https://inmarket.my.salesforce.com"). API calls go to that URL, not
-- a global Salesforce API endpoint — so we persist instance_url alongside
-- the tokens.
--
-- Refresh behavior: unlike Zoom, Salesforce refresh tokens do NOT rotate
-- on each refresh by default. A refresh returns a new access_token while
-- the refresh_token stays valid for its full lifetime (configurable by
-- the org admin, default ~90 days of inactivity). We still upsert the
-- whole row on refresh — defensive, in case the org enables rotation.

CREATE TABLE IF NOT EXISTS salesforce_org_tokens (
  org_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  token_type TEXT,
  scope TEXT,
  -- Salesforce identity URL (returned in token exchange response). Useful
  -- for re-querying user/org details without a separate API call.
  identity_url TEXT,
  -- Salesforce login URL used for this org: typically
  -- https://login.salesforce.com (production) or
  -- https://test.salesforce.com (sandbox). Captured at install time so
  -- subsequent refreshes hit the correct host.
  login_url TEXT NOT NULL DEFAULT 'https://login.salesforce.com',
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_salesforce_org_tokens_expires_at
  ON salesforce_org_tokens(expires_at);

CREATE OR REPLACE FUNCTION update_salesforce_org_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS salesforce_org_tokens_updated_at_trigger ON salesforce_org_tokens;
CREATE TRIGGER salesforce_org_tokens_updated_at_trigger
  BEFORE UPDATE ON salesforce_org_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_salesforce_org_tokens_updated_at();

COMMENT ON TABLE salesforce_org_tokens IS
  'OAuth access + refresh tokens per Salesforce org, populated by /oauth/salesforce-callback after install.';
COMMENT ON COLUMN salesforce_org_tokens.org_id IS
  'Salesforce 18-char organization ID (from /services/oauth2/userinfo after token exchange).';
COMMENT ON COLUMN salesforce_org_tokens.instance_url IS
  'Org-specific REST API base URL — every API call uses {instance_url}/services/data/...';
COMMENT ON COLUMN salesforce_org_tokens.login_url IS
  'OAuth login host (login.salesforce.com for prod, test.salesforce.com for sandbox).';
COMMENT ON COLUMN salesforce_org_tokens.expires_at IS
  'When the access_token expires. Refresh before this to avoid 401s on API calls.';
