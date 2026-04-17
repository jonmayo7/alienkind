-- Migration 034: Deep Process Outputs — parallel analysis + incorporation primitive
-- Any scheduled deep analysis job writes structured findings here.
-- A downstream incorporation runner reads and acts on them sequentially.
-- Generic pattern: parallel scanners produce findings in isolation, then a single
-- serialized step incorporates them so changes don't collide.

CREATE TABLE deep_process_outputs (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,               -- your domain taxonomy (examples: 'security', 'content', 'infrastructure')
  process_name TEXT NOT NULL,         -- specific job that produced this (e.g. 'log-scanner', 'self-assessment')
  findings JSONB NOT NULL,            -- structured output from the deep process
  summary TEXT,                       -- one-paragraph human-readable summary
  priority INTEGER DEFAULT 5          -- 1-10, how important for incorporation
    CHECK (priority BETWEEN 1 AND 10),
  incorporated BOOLEAN DEFAULT FALSE,
  incorporated_at TIMESTAMPTZ,
  incorporation_notes TEXT,           -- what changed as a result of incorporating this
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dpo_domain ON deep_process_outputs(domain);
CREATE INDEX idx_dpo_incorporated ON deep_process_outputs(incorporated);
CREATE INDEX idx_dpo_created ON deep_process_outputs(created_at DESC);
CREATE INDEX idx_dpo_domain_unincorporated ON deep_process_outputs(domain) WHERE incorporated = FALSE;

COMMENT ON TABLE deep_process_outputs IS 'Growth Engine Layer 1: parallel deep process findings. Layer 2 reads these for sequential incorporation.';
