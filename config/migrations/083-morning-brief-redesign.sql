-- Morning Brief Redesign (Apr 2026)
-- Additive only — existing data and columns untouched
-- Supports: 6 sections, per-item feedback, trading chart images, EXECUTE button, training pipeline

-- Store the generation prompt alongside section content (enables faithful DPO/SFT pair construction)
ALTER TABLE morning_brief_sections ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE morning_brief_sections ADD COLUMN IF NOT EXISTS prompt TEXT;

-- Per-item feedback: NULL = section-level, integer = bullet index within section
ALTER TABLE morning_brief_feedback ADD COLUMN IF NOT EXISTS item_index INTEGER;

-- EXECUTE button: captures when [HUMAN] finalizes brief review
CREATE TABLE IF NOT EXISTS morning_brief_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_date DATE UNIQUE NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  feedback_summary JSONB,
  notified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mbe_date ON morning_brief_executions(brief_date);
CREATE INDEX IF NOT EXISTS mbe_notified ON morning_brief_executions(notified) WHERE notified = false;
