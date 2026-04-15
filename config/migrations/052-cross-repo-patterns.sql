-- Migration 052: Cross-Repo Pattern Propagation
--
-- Learnings discovered in one repo auto-surface when working in another.
-- Seeds from CLAUDE.md debugging lessons + ongoing pattern capture.
-- Queried by repo-enter hooks, nightly cycle, and interactive sessions.

CREATE TABLE IF NOT EXISTS cross_repo_patterns (
  id              BIGSERIAL PRIMARY KEY,
  pattern_name    TEXT NOT NULL,                -- short name: "env-loading-mismatch", "silent-failure-class"
  description     TEXT NOT NULL,                -- what the pattern is and why it matters
  source_repo     TEXT NOT NULL,                -- where it was discovered: 'keel', '[repo-b]', '[client-product-c]', etc.
  applicable_repos TEXT[] NOT NULL DEFAULT '{}', -- which repos this applies to: '{[repo-b],[repo-c],[repo-d]}'
  category        TEXT NOT NULL DEFAULT 'debugging'
    CHECK (category IN ('debugging', 'architecture', 'testing', 'security', 'performance', 'build-discipline', 'ux')),
  severity        TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  fix_pattern     TEXT,                         -- how to fix or avoid: "Always do Object.assign(process.env, env) after loadEnv()"
  evidence        TEXT,                         -- where this was proven: "Session 47m: reject side had every gap the approve side had"
  discovered_at   TIMESTAMPTZ DEFAULT now(),
  last_surfaced   TIMESTAMPTZ,                  -- last time this was shown to a session
  times_surfaced  INTEGER DEFAULT 0,            -- how many times it's been shown
  resolved        BOOLEAN DEFAULT FALSE,        -- TRUE if fixed everywhere it applies
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_crp_source ON cross_repo_patterns(source_repo);
CREATE INDEX idx_crp_applicable ON cross_repo_patterns USING GIN(applicable_repos);
CREATE INDEX idx_crp_category ON cross_repo_patterns(category);
CREATE INDEX idx_crp_unresolved ON cross_repo_patterns(resolved) WHERE resolved = FALSE;

COMMENT ON TABLE cross_repo_patterns IS 'VGE: Cross-repo learning propagation. Patterns discovered in one repo auto-surface in applicable repos.';
