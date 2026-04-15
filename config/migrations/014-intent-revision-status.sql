-- ============================================================
-- MIGRATION 014: Add 'needs_revision' status to intents
-- Enables discuss -> revise loop. [HUMAN] can ask questions about
-- an intent, then request revision. Keel updates the intent
-- and re-presents it for approval.
-- Date: 2026-02-24
-- ============================================================

-- Drop old constraint (survived table rename) and add new one with 'needs_revision'
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'intents') THEN
    ALTER TABLE intents DROP CONSTRAINT IF EXISTS proposals_status_check;
    ALTER TABLE intents DROP CONSTRAINT IF EXISTS intents_status_check;
    ALTER TABLE intents ADD CONSTRAINT intents_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'expired', 'needs_revision'));
  END IF;
END $$;
