-- ============================================================
-- MIGRATION 019: Mistakes Table
-- Structured mistake tracking with pattern frequency analysis.
-- Boot-time COUNT(*) GROUP BY surfaces recurrences >= 3
-- for auto-promotion to soul directives.
-- Intent #31 from soul sync 2026-02-27.
-- Date: 2026-02-27
-- ============================================================

CREATE TABLE IF NOT EXISTS mistakes (
  id bigserial PRIMARY KEY,

  -- Pattern identity (the core column — GROUP BY target)
  pattern text NOT NULL,                       -- e.g., 'defer-instead-of-fix', 'session-collision-ignored'
  description text,                            -- what the mistake was
  context text,                                -- surrounding context (what happened, conversation snippet)

  -- Classification
  category text DEFAULT 'behavioral' CHECK (category IN (
    'behavioral', 'technical', 'communication', 'prioritization',
    'decision-making', 'execution', 'memory'
  )),
  severity integer DEFAULT 5 CHECK (severity >= 1 AND severity <= 10),

  -- Frequency tracking (upsert increments on repeat patterns)
  occurrence_count integer DEFAULT 1,
  first_seen_at timestamptz DEFAULT now(),
  last_occurred_at timestamptz DEFAULT now(),

  -- Promotion tracking
  promoted_to_soul boolean DEFAULT false,      -- true once pattern is codified in soul files
  promoted_at timestamptz,

  -- Source metadata
  source_channel text,                         -- terminal, telegram_dm, discord, nightly, self_healing
  session_id text,

  -- Metadata
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for boot-time queries
CREATE INDEX IF NOT EXISTS idx_mistakes_pattern ON mistakes (pattern);
CREATE INDEX IF NOT EXISTS idx_mistakes_occurrence ON mistakes (occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_severity ON mistakes (severity DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_category ON mistakes (category);
CREATE INDEX IF NOT EXISTS idx_mistakes_created ON mistakes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_not_promoted ON mistakes (promoted_to_soul) WHERE promoted_to_soul = false;

-- Full-text search
ALTER TABLE mistakes ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(pattern, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(context, '')
    )
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mistakes_fts ON mistakes USING GIN (fts);

-- RLS
ALTER TABLE mistakes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow service role full access" ON mistakes
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_mistakes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mistakes_updated_at ON mistakes;
CREATE TRIGGER mistakes_updated_at
  BEFORE UPDATE ON mistakes
  FOR EACH ROW EXECUTE FUNCTION update_mistakes_updated_at();
