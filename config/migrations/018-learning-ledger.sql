-- ============================================================
-- MIGRATION 018: Learning Ledger
-- Captures behavioral corrections and reinforcements.
-- Enables pattern frequency tracking and upsert on repeats.
-- Phase 2: auto-detect corrections from conversation patterns.
-- Date: 2026-02-26
-- ============================================================

CREATE TABLE IF NOT EXISTS learning_ledger (
  id bigserial PRIMARY KEY,

  -- Pattern identity
  pattern_name text NOT NULL,                    -- e.g., 'defer-instead-of-fix', 'check-before-claim'
  correction_text text NOT NULL,                 -- what the correction or reinforcement says
  context text,                                  -- surrounding context (conversation snippet, situation)

  -- Classification
  category text DEFAULT 'behavioral' CHECK (category IN ('behavioral', 'technical', 'communication', 'prioritization')),
  sentiment text DEFAULT 'correction' CHECK (sentiment IN ('correction', 'reinforcement')),
  severity integer DEFAULT 5 CHECK (severity >= 1 AND severity <= 10),

  -- Frequency tracking (upsert increments on repeat patterns)
  occurrence_count integer DEFAULT 1,

  -- Source metadata
  source_channel text,                           -- terminal, telegram_dm, discord, partner_collab, nightly, etc.
  session_id text,

  -- Metadata
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_learning_ledger_pattern ON learning_ledger (pattern_name);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_category ON learning_ledger (category);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_sentiment ON learning_ledger (sentiment);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_frequency ON learning_ledger (occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_learning_ledger_created ON learning_ledger (created_at DESC);

-- Full-text search on pattern_name + correction_text + context
ALTER TABLE learning_ledger ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(pattern_name, '') || ' ' ||
      coalesce(correction_text, '') || ' ' ||
      coalesce(context, '')
    )
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_learning_ledger_fts ON learning_ledger USING GIN (fts);

-- RLS
ALTER TABLE learning_ledger ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow service role full access" ON learning_ledger
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_learning_ledger_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_ledger_updated_at ON learning_ledger;
CREATE TRIGGER learning_ledger_updated_at
  BEFORE UPDATE ON learning_ledger
  FOR EACH ROW EXECUTE FUNCTION update_learning_ledger_updated_at();
