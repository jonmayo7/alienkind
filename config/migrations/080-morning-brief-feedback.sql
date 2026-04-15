-- Migration 080: Morning Brief Sections + Feedback
-- Supports the private morning brief blog with per-section quality feedback.
-- Writers: morning-brief.ts (sections), blog API route (feedback)
-- Readers: blog page (renders sections), substrate-policy.ts (routing weights),
--          morning-brief.ts (self-improvement prompt), nightly-analysis (quality trends),
--          keel-arena-score (substrate quality assessment)

-- Each morning brief section stored individually for per-section feedback
CREATE TABLE IF NOT EXISTS morning_brief_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_date DATE NOT NULL,
  section_name TEXT NOT NULL,         -- 'what_i_learned', 'hit_list', 'the_world', 'the_surprise'
  content TEXT NOT NULL,
  substrate TEXT,                     -- which model wrote this section (opus, [model_tier_2], studio2-heavy, etc.)
  model TEXT,                         -- concrete model name
  audio_url TEXT,                     -- URL to audio narration for this section
  latency_ms INTEGER,                -- how long the section took to generate
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mbs_date ON morning_brief_sections(brief_date DESC);
CREATE INDEX IF NOT EXISTS mbs_section ON morning_brief_sections(brief_date, section_name);

-- [HUMAN]'s per-section feedback from the private blog
CREATE TABLE IF NOT EXISTS morning_brief_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES morning_brief_sections(id),
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  notes TEXT,                         -- optional free-text from [HUMAN]
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mbf_section ON morning_brief_feedback(section_id);
CREATE INDEX IF NOT EXISTS mbf_created ON morning_brief_feedback(created_at DESC);

COMMENT ON TABLE morning_brief_sections IS 'Per-section morning brief content with substrate attribution. Feeds private blog + arena quality loop.';
COMMENT ON TABLE morning_brief_feedback IS '[HUMAN]''s per-section quality feedback. Binary vote + notes. Feeds substrate policy routing and brief self-improvement.';
