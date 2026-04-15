-- 041: Add approval_required column to intents table.
-- Enables two-tier intent execution:
--   approval_required = true  → [HUMAN] must approve via Telegram (existing behavior)
--   approval_required = false → Keel auto-executes, notifies [HUMAN] after
--
-- Criteria for Keel-approved (false):
--   Memory/documentation changes, internal code fixes, infrastructure improvements,
--   learning-ledger updates, pattern tracking, non-soul identity work.
--
-- Criteria for [HUMAN]-required (true):
--   Soul file changes, external-facing actions, credentials/secrets, other repos,
--   destructive actions, CLAUDE.md changes.

ALTER TABLE intents ADD COLUMN IF NOT EXISTS approval_required boolean DEFAULT true;

-- Backfill: mark all existing intents as requiring [HUMAN]'s approval (safe default)
UPDATE intents SET approval_required = true WHERE approval_required IS NULL;

-- Add index for daemon query: find Keel-approved intents ready for auto-execution
CREATE INDEX IF NOT EXISTS idx_intents_keel_approved
  ON intents (status, approval_required)
  WHERE status = 'pending' AND approval_required = false;
