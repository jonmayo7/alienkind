-- Migration 032: terminal_state table
-- Replaces JSON files (mycelium.json, context-window-state.json, handoff-pending.md)
-- with per-terminal Supabase rows. Fixes multi-terminal clobbering.

CREATE TABLE IF NOT EXISTS terminal_state (
  terminal_id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'terminal',      -- 'terminal', 'daemon', 'operator'
  pid INTEGER,
  session_id TEXT,
  context_used_pct INTEGER DEFAULT 0,
  focus TEXT DEFAULT '',
  activity TEXT DEFAULT '',
  repo_context TEXT,
  execution_context TEXT,
  handoff_pending JSONB,                       -- chain handoff data, NULL if no pending handoff
  consciousness_state JSONB,                   -- consciousness snapshot for this terminal
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ts_type ON terminal_state(type);
CREATE INDEX IF NOT EXISTS idx_ts_updated ON terminal_state(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ts_handoff ON terminal_state(terminal_id) WHERE handoff_pending IS NOT NULL;

ALTER TABLE terminal_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON terminal_state FOR ALL USING (true) WITH CHECK (true);
