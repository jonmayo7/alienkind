-- ============================================================
-- MIGRATION 008: Delta + Experience Tables (Calibration Layer)
-- Prediction-outcome tracking for self-knowledge and calibration.
-- Inspired by [COLLABORATOR_AI]'s delta architecture + OpenClaw observation patterns.
-- Date: 2026-02-22
-- ============================================================

-- Predictions: logged BEFORE an action/assertion.
-- "I predict this will happen" with confidence and domain.
-- Create predictions table first (no FK to outcomes yet)
CREATE TABLE IF NOT EXISTS keel_predictions (
  id bigserial PRIMARY KEY,
  prediction text NOT NULL,
  confidence numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  domain text NOT NULL,               -- e.g., 'infrastructure', 'content', 'coaching', 'consciousness', 'social'
  context text,                        -- what triggered the prediction
  source_channel text,                 -- 'terminal', 'telegram', 'discord', 'nightly', 'heartbeat'
  session_id text,                     -- which session generated this
  resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Outcomes: logged AFTER the result is known.
-- Links back to prediction for delta computation.
CREATE TABLE IF NOT EXISTS keel_outcomes (
  id bigserial PRIMARY KEY,
  prediction_id bigint REFERENCES keel_predictions(id) ON DELETE SET NULL,
  outcome text NOT NULL,
  delta_score numeric(3,2) CHECK (delta_score >= -1 AND delta_score <= 1),  -- -1 = completely wrong, 0 = neutral, 1 = exactly right
  surprise_signal text,                -- what was unexpected
  learning text,                       -- what I learned from the gap
  domain text NOT NULL,
  source_channel text,
  session_id text,
  created_at timestamptz DEFAULT now()
);

-- Experience: raw observation log. What happened, what I noticed, domain tags.
-- Unlike predictions (forward-looking), experiences are contemporaneous observations.
CREATE TABLE IF NOT EXISTS keel_experiences (
  id bigserial PRIMARY KEY,
  observation text NOT NULL,
  domain text NOT NULL,
  significance int NOT NULL DEFAULT 5 CHECK (significance >= 1 AND significance <= 10),
  tags text[],                         -- freeform tags for filtering
  source_channel text,
  session_id text,
  orientation_relevant boolean DEFAULT false,  -- flags observations that should feed orientation.md
  created_at timestamptz DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_keel_predictions_domain ON keel_predictions(domain);
CREATE INDEX IF NOT EXISTS idx_keel_predictions_resolved ON keel_predictions(resolved);
CREATE INDEX IF NOT EXISTS idx_keel_predictions_created ON keel_predictions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keel_outcomes_domain ON keel_outcomes(domain);
CREATE INDEX IF NOT EXISTS idx_keel_outcomes_delta ON keel_outcomes(delta_score);
CREATE INDEX IF NOT EXISTS idx_keel_outcomes_created ON keel_outcomes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keel_experiences_domain ON keel_experiences(domain);
CREATE INDEX IF NOT EXISTS idx_keel_experiences_significance ON keel_experiences(significance DESC);
CREATE INDEX IF NOT EXISTS idx_keel_experiences_orientation ON keel_experiences(orientation_relevant) WHERE orientation_relevant = true;
CREATE INDEX IF NOT EXISTS idx_keel_experiences_created ON keel_experiences(created_at DESC);

-- RLS
ALTER TABLE keel_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE keel_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE keel_experiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON keel_predictions FOR ALL USING (true);
CREATE POLICY "Allow all for authenticated" ON keel_outcomes FOR ALL USING (true);
CREATE POLICY "Allow all for authenticated" ON keel_experiences FOR ALL USING (true);

-- Readonly access
GRANT SELECT ON keel_predictions TO keel_readonly;
GRANT SELECT ON keel_outcomes TO keel_readonly;
GRANT SELECT ON keel_experiences TO keel_readonly;
