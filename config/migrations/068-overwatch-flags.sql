-- Overwatch flags — independent audit of action evaluator decisions
-- Three flag types: tier_mismatch, decision_mismatch, anomaly
CREATE TABLE IF NOT EXISTS overwatch_flags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_tier TEXT,
  overwatch_tier TEXT,
  action_type TEXT NOT NULL,
  target TEXT,
  decision TEXT,
  reasoning TEXT,
  disagreement_type TEXT NOT NULL CHECK (disagreement_type IN ('tier_mismatch', 'decision_mismatch', 'anomaly')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  source_hook TEXT,
  original_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for time-range queries (nightly analysis, agreement rate)
CREATE INDEX IF NOT EXISTS idx_overwatch_flags_created ON overwatch_flags (created_at DESC);
-- Index for disagreement type filtering
CREATE INDEX IF NOT EXISTS idx_overwatch_flags_type ON overwatch_flags (disagreement_type);
