-- Migration 059: Model signature column
-- Every response carries which model generated it.
-- Baseline: your primary model (e.g., claude-opus-4-7). Emergency tier: whatever alternate providers you configure.
-- The difference between substrates becomes visible in the data over time.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-opus-4-7';
ALTER TABLE consciousness_entries ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-opus-4-7';

CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations(model);
CREATE INDEX IF NOT EXISTS idx_consciousness_model ON consciousness_entries(model);

COMMENT ON COLUMN conversations.model IS 'Which model generated this response. Baseline: your primary model. Emergency tier: whatever alternate providers you configure.';
