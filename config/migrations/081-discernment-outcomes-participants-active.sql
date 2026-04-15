-- Migration 081: Add participants_active to discernment_outcomes
-- The discernment engine writes participants_active (regime.participantsActive)
-- on every outcome record, but the column was missing from the original 065 schema.
-- Error: "Could not find the 'participants_active' column of 'discernment_outcomes' in the schema cache"

ALTER TABLE discernment_outcomes
  ADD COLUMN IF NOT EXISTS participants_active INTEGER;

COMMENT ON COLUMN discernment_outcomes.participants_active IS 'Number of active participants at decision time (from regime detection)';
