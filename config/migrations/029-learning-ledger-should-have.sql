-- ============================================================
-- MIGRATION 029: Learning Ledger — should_have synthesis (AAR 7.1)
-- Adds counterfactual directive and Keel's triggering response.
-- Enables: correction → what I should have done → soul promotion.
-- Date: 2026-03-05
-- ============================================================

-- What Keel said that triggered the correction
ALTER TABLE learning_ledger ADD COLUMN IF NOT EXISTS keel_response text;

-- Behavioral directive: what Keel SHOULD have done instead
ALTER TABLE learning_ledger ADD COLUMN IF NOT EXISTS should_have text;

-- Track whether synthesis has been attempted (prevent re-processing)
ALTER TABLE learning_ledger ADD COLUMN IF NOT EXISTS should_have_generated_at timestamptz;
