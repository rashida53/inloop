-- Migration: Idempotency keys table for reliable webhook handling
-- Ensures webhooks are processed exactly-once even with retries and multiple workers

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing', -- processing, done, failed
  response JSONB,
  owner_id TEXT, -- worker/process ID that claimed this key
  error_message TEXT,
  attempt_count INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_status ON idempotency_keys(status);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at DESC);

-- Cleanup job for expired keys (can be run by a background worker)
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_keys()
RETURNS TABLE(deleted_count INT) AS $$
DECLARE
  count INT;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < NOW();
  GET DIAGNOSTICS count = ROW_COUNT;
  RETURN QUERY SELECT count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE idempotency_keys IS 'Stores webhook idempotency information for exactly-once processing semantics';
COMMENT ON COLUMN idempotency_keys.key IS 'Unique idempotency key from client, often webhook event ID or correlation ID';
COMMENT ON COLUMN idempotency_keys.request_hash IS 'Hash of request payload for duplicate detection';
COMMENT ON COLUMN idempotency_keys.status IS 'Current state: processing (in-flight), done (successful), failed (retry allowed)';
COMMENT ON COLUMN idempotency_keys.response IS 'Cached response to return for duplicate requests';
COMMENT ON COLUMN idempotency_keys.owner_id IS 'Identifier of worker/process that claimed this key';
COMMENT ON COLUMN idempotency_keys.expires_at IS 'When to garbage-collect this record';
