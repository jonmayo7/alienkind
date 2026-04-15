-- Migration 064: terminal_signals — Cross-terminal communication substrate
-- Part of Phase 4 Organism Architecture: the nervous system.
--
-- Borrows from SBP (Stigmergic Blackboard Protocol):
--   - Signals with intensity (0.0-1.0) that can be reinforced or decay
--   - Trail namespaces for routing (e.g., 'phase2.training', 'circulation.coaching')
--   - Acknowledged_by tracking for consumption
--
-- Signals are the communication layer that makes mycelium bidirectional.
-- Currently mycelium is awareness (I can SEE other terminals).
-- With signals, mycelium is communication (I can TALK to other terminals).

CREATE TABLE IF NOT EXISTS terminal_signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_node TEXT NOT NULL,                          -- sender: "terminal-18028", "daemon", "telegram"
  to_node TEXT,                                     -- NULL = broadcast, specific ID = directed
  signal_type TEXT NOT NULL,                        -- "decision", "finding", "correction", "request", "status"
  trail TEXT NOT NULL DEFAULT 'general',             -- SBP namespace for routing
  intensity REAL NOT NULL DEFAULT 1.0               -- 0.0-1.0 pheromone strength
    CHECK (intensity >= 0.0 AND intensity <= 1.0),
  payload JSONB NOT NULL DEFAULT '{}',              -- signal content (structured)
  acknowledged_by TEXT[] NOT NULL DEFAULT '{}',      -- terminal IDs that consumed this signal
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ                            -- NULL = no auto-expiry
);

-- Unread signals for a terminal (most common query)
CREATE INDEX idx_signals_unack ON terminal_signals(created_at DESC)
  WHERE array_length(acknowledged_by, 1) IS NULL OR array_length(acknowledged_by, 1) = 0;

-- Trail-based routing
CREATE INDEX idx_signals_trail ON terminal_signals(trail, created_at DESC);

-- Type-based filtering
CREATE INDEX idx_signals_type ON terminal_signals(signal_type, created_at DESC);

-- Directed signals
CREATE INDEX idx_signals_to ON terminal_signals(to_node, created_at DESC)
  WHERE to_node IS NOT NULL;

-- RLS: service role full access (same pattern as terminal_state)
ALTER TABLE terminal_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON terminal_signals FOR ALL USING (true) WITH CHECK (true);
