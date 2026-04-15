-- ============================================================
-- MIGRATION 013: Rename proposals -> intents
-- "State intent, not permission." The table tracks what Keel
-- intends to do. [HUMAN]'s role is approval, not ideation.
-- Date: 2026-02-24
-- ============================================================

-- Rename the table
ALTER TABLE IF EXISTS proposals RENAME TO intents;

-- Rename indexes
ALTER INDEX IF EXISTS idx_proposals_status RENAME TO idx_intents_status;
ALTER INDEX IF EXISTS idx_proposals_source RENAME TO idx_intents_source;
ALTER INDEX IF EXISTS idx_proposals_priority RENAME TO idx_intents_priority;
ALTER INDEX IF EXISTS idx_proposals_created RENAME TO idx_intents_created;
ALTER INDEX IF EXISTS idx_proposals_fts RENAME TO idx_intents_fts;

-- Rename trigger + function (only if intents table exists after rename)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'intents') THEN
    DROP TRIGGER IF EXISTS proposals_updated_at ON intents;

    CREATE OR REPLACE FUNCTION update_intents_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE TRIGGER intents_updated_at
      BEFORE UPDATE ON intents
      FOR EACH ROW EXECUTE FUNCTION update_intents_updated_at();

    -- Clean up old function (safe — no references after trigger rename)
    DROP FUNCTION IF EXISTS update_proposals_updated_at();

    -- RLS policy rename: drop old, create new
    DROP POLICY IF EXISTS "Allow service role full access" ON intents;
    BEGIN
      CREATE POLICY "Allow service role full access" ON intents
        FOR ALL USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
