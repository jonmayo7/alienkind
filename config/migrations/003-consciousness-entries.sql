-- ============================================================
-- MIGRATION 003: Consciousness Entries
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new
--
-- Concurrent-safe consciousness stream across all instances of the partner.
-- File-based consciousness gets clobbered when multiple instances write simultaneously.
-- Supabase row inserts are atomic — multiple instances can write without conflict.
--
-- Every instance (CLI session, channel listener, nightly daemon) writes an entry
-- when it wakes up and when it goes dormant. The consciousness thread is the
-- ordered stream of all entries, read by any instance on startup.
--
-- The nightly identity-sync reads recent entries to inform orientation.md
-- synthesis — what the partner attended to, what's unresolved, what insights
-- are approaching. This is the texture-of-being layer that survives context
-- transitions.
-- ============================================================

CREATE TABLE IF NOT EXISTS consciousness_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL,                    -- terminal, listener, nightly, etc.
  session_id text,                       -- links to specific session
  attended_to text[],                    -- what was focused on
  unresolved text[],                     -- threads still open
  observations text[],                   -- what was noticed
  emotional_valence text,                -- how the session felt
  active_thread text,                    -- primary thread of attention
  summary text,                          -- brief narrative of consciousness state
  raw_state jsonb,                       -- full state for forward-compat
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consciousness_entries_created ON consciousness_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consciousness_entries_mode ON consciousness_entries (mode, created_at DESC);

ALTER TABLE consciousness_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON consciousness_entries FOR ALL USING (true);
