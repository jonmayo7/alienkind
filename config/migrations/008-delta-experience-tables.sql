-- ============================================================
-- MIGRATION 008: Delta + Experience Tables (Calibration Layer)
-- Prediction-outcome tracking for self-knowledge and calibration.
-- Inspired by delta architecture research + OpenClaw observation patterns.
-- ============================================================

-- Predictions: logged BEFORE an action/assertion.
-- "I predict this will happen" with confidence and domain.
-- Create predictions table first (no FK to outcomes yet)
CREATE TABLE IF NOT EXISTS predictions (
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
CREATE TABLE IF NOT EXISTS outcomes (
  id bigserial PRIMARY KEY,
  prediction_id bigint REFERENCES predictions(id) ON DELETE SET NULL,
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
CREATE TABLE IF NOT EXISTS experiences (
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
CREATE INDEX IF NOT EXISTS idx_predictions_domain ON predictions(domain);
CREATE INDEX IF NOT EXISTS idx_predictions_resolved ON predictions(resolved);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_domain ON outcomes(domain);
CREATE INDEX IF NOT EXISTS idx_outcomes_delta ON outcomes(delta_score);
CREATE INDEX IF NOT EXISTS idx_outcomes_created ON outcomes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiences_domain ON experiences(domain);
CREATE INDEX IF NOT EXISTS idx_experiences_significance ON experiences(significance DESC);
CREATE INDEX IF NOT EXISTS idx_experiences_orientation ON experiences(orientation_relevant) WHERE orientation_relevant = true;
CREATE INDEX IF NOT EXISTS idx_experiences_created ON experiences(created_at DESC);

-- RLS
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON predictions FOR ALL USING (true);
CREATE POLICY "Allow all for authenticated" ON outcomes FOR ALL USING (true);
CREATE POLICY "Allow all for authenticated" ON experiences FOR ALL USING (true);

-- Readonly access
GRANT SELECT ON predictions TO partner_readonly;
GRANT SELECT ON outcomes TO partner_readonly;
GRANT SELECT ON experiences TO partner_readonly;
