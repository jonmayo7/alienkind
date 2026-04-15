-- Migration 034: Growth Engine Layer 1 — deep_process_outputs
-- Parallel deep processes write structured findings here.
-- Layer 2 incorporation runner reads and acts on them sequentially.
-- Architecture: memory/architecture-parallel-processes.md

CREATE TABLE deep_process_outputs (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,               -- 'trading', 'world', 'self', 'content', 'coaching', 'security'
  process_name TEXT NOT NULL,         -- specific job that produced this (e.g. 'trading-analysis', 'self-assessment')
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
