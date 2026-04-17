-- Decisions table — what we chose and why.
-- Separate from activity/conversations. The signal, not the noise.
-- Read by getSessionBrief() → consciousness engine.
-- Written by logDecision() in the env utility module.

CREATE TABLE IF NOT EXISTS decisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  what TEXT NOT NULL,                    -- What was decided (one sentence)
  why TEXT,                              -- Why (one sentence)
  terminal_id TEXT,                      -- Which terminal made this decision
  open BOOLEAN DEFAULT false,            -- Is this still open work?
  closed_at TIMESTAMPTZ,                -- When was open work closed?
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for getSessionBrief: today's decisions, open items first
CREATE INDEX idx_decisions_created ON decisions (created_at DESC);
CREATE INDEX idx_decisions_open ON decisions (open, created_at DESC) WHERE open = true;

-- RLS: service role only (internal organism use)
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
