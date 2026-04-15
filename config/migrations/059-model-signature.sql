-- Migration 059: Model signature column
-- Every response carries which model generated it.
-- Baseline: claude-opus-4-6. Emergency tier: openai/[model_tier_2], xai/[MODEL_TIER_3], google/[MODEL_TIER_4]-pro.
-- The difference between substrates becomes visible in the data over time.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-opus-4-6';
ALTER TABLE consciousness_entries ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-opus-4-6';

CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations(model);
CREATE INDEX IF NOT EXISTS idx_consciousness_model ON consciousness_entries(model);

COMMENT ON COLUMN conversations.model IS 'Which model generated this response. Baseline: claude-opus-4-6. Emergency: openai/[model_tier_2], xai/[MODEL_TIER_3], google/[MODEL_TIER_4]-pro.';
