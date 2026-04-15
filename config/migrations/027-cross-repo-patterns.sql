-- Migration 027: Cross-repo pattern store (CONOP pre-execution: mycelium extension)
-- Durable store for learnings that apply across repositories.
-- Source of truth for cross-repo knowledge propagation.

CREATE TABLE IF NOT EXISTS cross_repo_patterns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_repo text NOT NULL,                    -- repo where pattern was learned (e.g. 'keel', '[repo-b]')
  applicable_repos text[] NOT NULL DEFAULT '{}', -- repos where this applies ('*' = all)
  category text NOT NULL,                        -- 'debugging', 'architecture', 'build-discipline', 'testing', 'operations', 'model-strategy'
  pattern text NOT NULL,                         -- the learning itself
  evidence text,                                 -- supporting context or examples
  evidence_count int NOT NULL DEFAULT 1,         -- how many times confirmed
  status text NOT NULL DEFAULT 'active',         -- 'active', 'superseded', 'disproven'
  superseded_by bigint REFERENCES cross_repo_patterns(id), -- if superseded, points to replacement
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_repo
  ON cross_repo_patterns USING gin (applicable_repos);

CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_category
  ON cross_repo_patterns (category);

CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_status
  ON cross_repo_patterns (status) WHERE status = 'active';
