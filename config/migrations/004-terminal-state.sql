-- Migration 004: terminal_state table — multi-instance awareness substrate.
--
-- Each running Claude Code session writes a row keyed by terminal_id.
-- On every UserPromptSubmit, every session reads the other rows so it
-- knows what its peers are doing. Rows older than 30 minutes are
-- considered stale and pruned at the next SessionStart.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS terminal_state (
  terminal_id      TEXT PRIMARY KEY,
  type             TEXT NOT NULL DEFAULT 'terminal',  -- 'terminal', 'daemon', 'listener'
  pid              INTEGER,
  session_id       TEXT,
  focus            TEXT DEFAULT '',                   -- what the user just asked
  activity         TEXT DEFAULT '',                   -- what the partner is doing about it
  repo_context     TEXT,                              -- repo basename if inside a git tree
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  registered_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminal_state_type    ON terminal_state(type);
CREATE INDEX IF NOT EXISTS idx_terminal_state_updated ON terminal_state(updated_at DESC);

ALTER TABLE terminal_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'terminal_state'
      AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON terminal_state
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END$$;
