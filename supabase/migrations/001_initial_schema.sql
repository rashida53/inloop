-- Migration: Initial schema for InLoop
-- Creates users and meetings tables with proper indexing and constraints

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  full_name TEXT,
  slack_id TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_id);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- Add trigger to update updated_at on modification
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at_trigger ON users;
CREATE TRIGGER users_updated_at_trigger
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_users_updated_at();

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  zoom_id TEXT UNIQUE NOT NULL,
  title TEXT,
  summary TEXT,
  next_steps TEXT,
  attendees JSONB,
  host_email TEXT REFERENCES users(email) ON DELETE SET NULL,
  recorded_at TIMESTAMP WITH TIME ZONE,
  source TEXT NOT NULL DEFAULT 'zoom', -- zoom, teams, etc.
  raw_payload JSONB,
  digest_sent_at TIMESTAMP WITH TIME ZONE,
  digest_slack_ts TEXT, -- Slack message timestamp for thread updates
  error TEXT, -- error message if processing failed
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meetings_zoom_id ON meetings(zoom_id);
CREATE INDEX IF NOT EXISTS idx_meetings_host_email ON meetings(host_email);
CREATE INDEX IF NOT EXISTS idx_meetings_recorded_at ON meetings(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_digest_sent_at ON meetings(digest_sent_at);
CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_source ON meetings(source);

-- Add trigger to update updated_at on modification
CREATE OR REPLACE FUNCTION update_meetings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meetings_updated_at_trigger ON meetings;
CREATE TRIGGER meetings_updated_at_trigger
  BEFORE UPDATE ON meetings
  FOR EACH ROW
  EXECUTE FUNCTION update_meetings_updated_at();

-- Comment on tables for documentation
COMMENT ON TABLE users IS 'InLoop users synced from Slack workspace';
COMMENT ON TABLE meetings IS 'Meeting records extracted from Zoom, Teams, and other sources';
COMMENT ON COLUMN meetings.raw_payload IS 'Raw webhook payload for audit and re-processing';
COMMENT ON COLUMN meetings.digest_slack_ts IS 'Slack message ts for threading updates; format: channel-timestamp';
COMMENT ON COLUMN meetings.source IS 'Integration source: zoom, teams, google_meet, etc.';
