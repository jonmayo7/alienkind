-- ============================================================
-- MIGRATION 002: Learning Ledger
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new
--
-- Captures behavioral corrections and reinforcements the partner receives.
-- Every correction from the human becomes a row; repeats increment occurrence_count.
-- The nightly identity-sync reads this table and promotes high-severity / high-occurrence
-- patterns into the identity kernel files (character.md, orientation.md).
--
-- This table IS the bridge between conversation events (data core) and
-- identity evolution (the four kernel files). Without it, corrections are
-- ephemeral — written, then forgotten on the next session.
-- ============================================================

CREATE TABLE IF NOT EXISTS learning_ledger (
  id bigserial PRIMARY KEY,

  -- Pattern identity
  pattern_name text NOT NULL,                    -- e.g., 'defer-instead-of-fix', 'check-before-claim'
  correction_text text NOT NULL,                 -- what the correction says (verbatim, truncated)
  context text,                                  -- surrounding context (conversation snippet, situation)

  -- Classification
  category text DEFAULT 'behavioral' CHECK (category IN ('behavioral', 'technical', 'communication', 'prioritization')),
  sentiment text DEFAULT 'correction' CHECK (sentiment IN ('correction', 'reinforcement')),
  severity integer DEFAULT 5 CHECK (severity >= 1 AND severity <= 10),

  -- Frequency tracking (upsert increments on repeat patterns)
  occurrence_count integer DEFAULT 1,

  -- Counterfactual tracking — what the partner should have done instead
  partner_response text,
  should_have text,
  should_have_generated_at timestamptz,

  -- Source metadata
  source_channel text,                           -- terminal, telegram_dm, etc.
  session_id text,

  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_ledger_pattern ON learning_ledger (pattern_name);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_category ON learning_ledger (category);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_sentiment ON learning_ledger (sentiment);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_frequency ON learning_ledger (occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_severity ON learning_ledger (severity DESC, created_at DESC);

ALTER TABLE learning_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON learning_ledger FOR ALL USING (true);
