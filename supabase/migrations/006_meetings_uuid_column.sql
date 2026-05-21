-- Migration 006: per-occurrence uuid as the natural key for meetings.
--
-- Background: Zoom assigns ONE persistent `id` per meeting series (e.g.
-- 84740555455 for the daily standup), but a FRESH `uuid` for every
-- individual occurrence (today's standup, yesterday's standup, etc.).
-- The original schema (001_initial_schema.sql) used `zoom_id` (the
-- persistent series id) as the UNIQUE key, which has two consequences
-- for recurring meetings:
--
--   1. Today's standup overwrites yesterday's row via upsertFromWebhook's
--      ON CONFLICT (zoom_id) DO UPDATE — data loss.
--   2. The orchestrator's digest_sent_at duplicate guard reads the
--      overwritten row and skips delivery because yesterday's
--      digest_sent_at is still set — today's digest is dropped.
--
-- Fix: key on uuid (per-occurrence) instead of zoom_id (per-series).
-- Each occurrence gets its own row. zoom_id is kept as a non-unique
-- column for analytics ("show me all occurrences of standup XYZ").

-- 1. Add uuid column (nullable initially so the backfill can populate it).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS uuid TEXT;

-- 2. Backfill from the stored raw_payload for existing rows. Zoom puts
--    the per-occurrence uuid at payload.object.uuid in the webhook event.
--    Rows that came in before the adapter started storing this field, or
--    have a malformed raw_payload, fall back to a synthetic uuid built
--    from zoom_id + a marker so they remain unique.
UPDATE meetings
SET uuid = COALESCE(
  raw_payload->'payload'->'object'->>'uuid',
  zoom_id || '_legacy_' || id::text
)
WHERE uuid IS NULL;

-- 3. Make uuid required going forward.
ALTER TABLE meetings ALTER COLUMN uuid SET NOT NULL;

-- 4. Swap the UNIQUE constraint from zoom_id to uuid. The constraint
--    name `meetings_zoom_id_key` is the Postgres default for a column
--    declared `UNIQUE` directly in CREATE TABLE; IF EXISTS makes this
--    idempotent in case the constraint was already renamed.
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_zoom_id_key;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_uuid_key UNIQUE (uuid);

-- 5. Indexes: uuid is now the lookup column for the duplicate guard.
--    Keep idx_meetings_zoom_id for analytics queries that find all
--    occurrences of a series.
CREATE INDEX IF NOT EXISTS idx_meetings_uuid ON meetings(uuid);

COMMENT ON COLUMN meetings.uuid IS
  'Per-occurrence Zoom UUID (payload.object.uuid). Unique. Use this for upserts and duplicate guards.';
COMMENT ON COLUMN meetings.zoom_id IS
  'Persistent Zoom meeting series ID (payload.object.id). Same across all occurrences of a recurring meeting. Use for analytics, not for dedup.';
