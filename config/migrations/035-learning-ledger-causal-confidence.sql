-- Migration 035: Add causal_confidence to learning_ledger
-- Enables revision trajectories instead of overwrites.
-- 0 = no confidence in causal attribution, 1 = certain.
-- When a correction's root cause is ambiguous, low confidence
-- signals "this might get revised as I learn more."

ALTER TABLE learning_ledger
ADD COLUMN IF NOT EXISTS causal_confidence REAL DEFAULT NULL;

COMMENT ON COLUMN learning_ledger.causal_confidence IS 'Confidence in causal attribution (0-1). NULL = not assessed.';
