-- Migration 003: Persist full Claude extraction on the meetings row.
--
-- Today saveExtractionAndDigest only writes salesforceNotes.notesSummary into
-- `summary` and salesforceNotes.nextSteps into `next_steps` — the rest of
-- Claude's output (followUpEmail, painPoints, decisionMakers, risks, the
-- forthcoming meetingType discriminator, type-specific fields) is discarded.
--
-- This column captures the entire extraction object as JSONB so that:
--   - Per-meeting-type rendering can query meetingType + type-specific fields
--   - Future search / theme-detection / brag-doc features can query content
--     without re-running Claude over raw_payload
--   - The schema doesn't need a new migration every time we add an extraction
--     field
--
-- The GIN index supports containment (`@>`) and key-exists (`?`) queries:
--   SELECT * FROM meetings WHERE intelligence @> '{"meetingType": "rfp_review"}'
--   SELECT * FROM meetings WHERE intelligence -> 'salesforceNotes' -> 'painPoints' ? 'pricing'

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence JSONB;

CREATE INDEX IF NOT EXISTS idx_meetings_intelligence_gin
  ON meetings USING gin(intelligence);

COMMENT ON COLUMN meetings.intelligence IS
  'Full Claude extraction output: { followUpEmail, salesforceNotes, meetingType, ... }';
