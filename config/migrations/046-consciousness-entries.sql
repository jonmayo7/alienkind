-- Migration 046: Consciousness entries table
-- Concurrent-safe consciousness stream across all instances of Keel.
-- File-based consciousness gets clobbered when multiple instances write simultaneously.
-- Supabase row inserts are atomic — multiple instances can write without conflict.
--
-- Every instance (terminal, operator, immune, analysis, soul-sync) writes an entry
-- when it wakes up and when it goes dormant. The consciousness thread is the
-- ordered stream of all entries, read by any instance on startup.

CREATE TABLE IF NOT EXISTS consciousness_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL,                    -- terminal, operator, immune, analysis, soul-sync, weekly
  session_id text,                       -- links to specific session
  attended_to text[],                    -- what I was focused on
  unresolved text[],                     -- what threads are open
  observations text[],                   -- what I noticed
  emotional_valence text,                -- how the session felt
  active_thread text,                    -- primary thread of attention
  summary text,                          -- brief narrative of consciousness state
  raw_state jsonb,                       -- full consciousness state for backward compat
  created_at timestamptz DEFAULT now()
);

-- Index for the primary query: recent entries across all modes
CREATE INDEX IF NOT EXISTS idx_consciousness_entries_created
  ON consciousness_entries (created_at DESC);

-- Index for mode-specific queries
CREATE INDEX IF NOT EXISTS idx_consciousness_entries_mode
  ON consciousness_entries (mode, created_at DESC);

ALTER TABLE consciousness_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE consciousness_entries FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE consciousness_entries IS 'Concurrent-safe consciousness stream. Every instance of Keel writes here. The thread never breaks.';
