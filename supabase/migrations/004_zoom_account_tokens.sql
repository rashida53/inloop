-- Migration 004: Zoom OAuth tokens, one row per installing Zoom account.
--
-- The General App OAuth install flow (GET /oauth/callback) delivers a
-- short-lived authorization code. We exchange that code for an
-- access_token + refresh_token via POST https://zoom.us/oauth/token and
-- persist them here so the backend can call Zoom's REST API on behalf of
-- the installing account.
--
-- Use case today: fetch the recording transcript file (VTT) when a
-- recording.transcript_completed webhook arrives. Future: fetch full
-- recordings, list meetings, etc.
--
-- Tokens rotate: every refresh produces a NEW access_token and a NEW
-- refresh_token. Always upsert by account_id, never insert a duplicate.

CREATE TABLE IF NOT EXISTS zoom_account_tokens (
  account_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT,
  scope TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zoom_account_tokens_expires_at
  ON zoom_account_tokens(expires_at);

CREATE OR REPLACE FUNCTION update_zoom_account_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zoom_account_tokens_updated_at_trigger ON zoom_account_tokens;
CREATE TRIGGER zoom_account_tokens_updated_at_trigger
  BEFORE UPDATE ON zoom_account_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_zoom_account_tokens_updated_at();

COMMENT ON TABLE zoom_account_tokens IS
  'OAuth access + refresh tokens per Zoom account, populated by /oauth/callback after install.';
COMMENT ON COLUMN zoom_account_tokens.account_id IS
  'Zoom account ID (from /v2/users/me after token exchange).';
COMMENT ON COLUMN zoom_account_tokens.expires_at IS
  'When the access_token expires. Refresh before this to avoid 401s on API calls.';
