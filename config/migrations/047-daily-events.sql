-- Migration 047: daily_events table
-- Structured daily event log for boot context and chain handoff.
-- Replaces daily file tail reads with queryable Supabase data.
-- Hard-gated at boot: compaction gate requires this query to succeed.

CREATE TABLE IF NOT EXISTS daily_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'decision', 'learning', 'milestone', 'direction_change',
    'task_complete', 'session_summary', 'correction', 'build'
  )),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'terminal',  -- terminal, daemon, telegram, discord, nightly
  terminal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for boot queries: today's events, most recent first
CREATE INDEX idx_daily_events_date ON daily_events (event_date DESC, created_at DESC);

-- Index for event type filtering
CREATE INDEX idx_daily_events_type ON daily_events (event_type, event_date DESC);

-- RLS
ALTER TABLE daily_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_events_service_all" ON daily_events
  FOR ALL USING (true) WITH CHECK (true);
