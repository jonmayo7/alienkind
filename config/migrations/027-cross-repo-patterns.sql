-- Migration 027: Cross-Project Pattern Propagation
-- Learnings discovered in one project auto-surface when working in another.
-- A pattern captured in project A (e.g., "always Object.assign(process.env, env) after
-- loadEnv") surfaces in projects B, C, D when they match the pattern's applicable scope.
-- Queried by boot hooks, nightly cycle, and interactive sessions.

CREATE TABLE IF NOT EXISTS cross_repo_patterns (
  id               BIGSERIAL PRIMARY KEY,
  pattern_name     TEXT NOT NULL,                -- short name: "env-loading-mismatch", "silent-failure-class"
  description      TEXT NOT NULL,                -- what the pattern is and why it matters
  source_repo      TEXT NOT NULL,                -- project where discovered
  applicable_repos TEXT[] NOT NULL DEFAULT '{}', -- projects this applies to ('*' = all)
  category         TEXT NOT NULL DEFAULT 'debugging'
    CHECK (category IN ('debugging', 'architecture', 'build-discipline', 'testing', 'security', 'performance', 'operations', 'model-strategy', 'ux')),
  severity         TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  fix_pattern      TEXT,                         -- how to fix or avoid
  evidence         TEXT,                         -- supporting context or examples
  evidence_count   INT NOT NULL DEFAULT 1,       -- how many times confirmed
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'disproven')),
  superseded_by    BIGINT REFERENCES cross_repo_patterns(id),
  last_surfaced    TIMESTAMPTZ,                  -- last time shown to a session
  times_surfaced   INTEGER DEFAULT 0,
  resolved         BOOLEAN DEFAULT FALSE,        -- TRUE if fixed everywhere it applies
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_source
  ON cross_repo_patterns(source_repo);
CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_applicable
  ON cross_repo_patterns USING gin(applicable_repos);
CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_category
  ON cross_repo_patterns(category);
CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_status
  ON cross_repo_patterns(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_cross_repo_patterns_unresolved
  ON cross_repo_patterns(resolved) WHERE resolved = FALSE;

COMMENT ON TABLE cross_repo_patterns IS 'Cross-project learning propagation. Patterns discovered in one project auto-surface in applicable projects.';
