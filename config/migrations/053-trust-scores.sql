-- Migration 053: Trust Scores — historical record of composite trust measurements
--
-- The trust-provenance module (scripts/lib/trust-provenance.ts) computes a
-- composite trust score from three layers: Decision Provenance, Judgment
-- Calibration, and Trust Boundary Enforcement. This table stores each
-- computation so we can track trust trajectory over time, detect drift,
-- and surface trends to human review.
--
-- Writes come from `recordTrustScore()` in trust-provenance.ts.
-- Reads come from nightly-cycle and interactive sessions.
--
-- RLS: ENABLE + FORCE, no permissive policies. service_role bypasses
-- natively (same pattern as migration 040).

CREATE TABLE IF NOT EXISTS trust_scores (
  id                          BIGSERIAL PRIMARY KEY,
  score                       FLOAT NOT NULL,                -- overall composite 0-100
  grade                       TEXT NOT NULL,                  -- 'Exceptional', 'Strong', 'Good', 'Developing', 'Baseline', 'Concerning', 'Critical'
  decision_provenance_score   FLOAT NOT NULL,                -- layer 1 component 0-100
  judgment_calibration_score  FLOAT NOT NULL,                -- layer 2 component 0-100
  trust_boundary_score        FLOAT NOT NULL,                -- layer 3 component 0-100
  component_details           JSONB NOT NULL DEFAULT '{}',   -- full TrustScoreBreakdown (weights, components)
  deductions                  JSONB NOT NULL DEFAULT '[]',   -- string[] of score deductions
  boosts                      JSONB NOT NULL DEFAULT '[]',   -- string[] of score boosts
  period_days                 INTEGER NOT NULL,               -- lookback window used for computation
  computed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ts_computed_at ON trust_scores(computed_at DESC);
CREATE INDEX idx_ts_grade ON trust_scores(grade);

-- RLS: locked down, service_role only (bypasses natively)
ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_scores FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE trust_scores IS 'Trust Provenance: Historical trust score records. Computed by trust-provenance.ts recordTrustScore(). Tracks trust trajectory over time.';
