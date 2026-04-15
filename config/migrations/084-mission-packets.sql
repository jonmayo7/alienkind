-- Mission Packets: single source of truth for all working group findings.
-- Every gap found, every solution proposed, every evaluation, every ship.
-- The triage AIRE scores entries here. Opus reads from here.
-- [HUMAN] can see this on the dashboard. Verification loop writes back here.

CREATE TABLE IF NOT EXISTS mission_packets (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- What was found
  organ           text NOT NULL,           -- consciousness-engine, trading-engine, security, etc.
  finding         text NOT NULL,           -- what's wrong or missing
  evidence        text,                    -- files read, data found, connections traced
  finding_type    text NOT NULL DEFAULT 'gap',  -- gap, dead-code, wiring, assumption, design-smell

  -- Who found it
  created_by      text NOT NULL,           -- working-group-gap-scanner, working-group-code-hunter, etc.
  models_used     text[],                  -- which models contributed (e.g. {'122B', 'coder-next', '27B'})
  debate_rounds   int DEFAULT 0,           -- how many diverge/challenge/converge rounds

  -- Proposed solution
  proposed_fix    text,                    -- code as text (not applied)
  fix_reasoning   text,                    -- why this solution, alternatives considered
  fix_files       text[],                  -- which files would be modified

  -- Triage AIRE scoring
  confidence      float DEFAULT 0.5,       -- 0-1, from the finding model(s)
  triage_score    float DEFAULT 0,         -- pheromone score, evolves over time
  upvotes         int DEFAULT 0,
  downvotes       int DEFAULT 0,

  -- Evaluation
  status          text NOT NULL DEFAULT 'pending',
    -- pending: found, not yet evaluated
    -- evaluating: Opus is reviewing
    -- approved: Opus approved, building through discipline
    -- shipped: fix committed and ACTIVATED
    -- rejected: Opus rejected with reason
    -- deferred: real but not priority now
    -- escalated: needs [HUMAN]
  evaluated_by    text,                    -- opus, [human_first], auto (for auto-ship items)
  evaluation_notes text,                   -- why approved/rejected/deferred
  commit_sha      text,                    -- if shipped, the commit hash

  -- Verification loop
  verified        boolean DEFAULT false,   -- did the fix actually improve anything?
  verification_data jsonb,                 -- rate-of-change before/after, test results, etc.

  -- Risk assessment
  risk_level      text DEFAULT 'low',      -- low, medium, high, critical
  risk_notes      text,                    -- what could break

  -- Escalation
  escalation_reason text,                  -- why this needs [HUMAN] (if escalated)

  -- Timestamps
  created_at      timestamptz DEFAULT now(),
  evaluated_at    timestamptz,
  shipped_at      timestamptz,
  verified_at     timestamptz,

  -- Ring
  ring            text DEFAULT 'inner'     -- inner (fill cup), middle (stewards), outer (expansion)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_mission_packets_status ON mission_packets(status);
CREATE INDEX IF NOT EXISTS idx_mission_packets_organ ON mission_packets(organ);
CREATE INDEX IF NOT EXISTS idx_mission_packets_triage ON mission_packets(triage_score DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mission_packets_ring ON mission_packets(ring);
CREATE INDEX IF NOT EXISTS idx_mission_packets_created ON mission_packets(created_at DESC);

-- RLS: service role only (no public access)
ALTER TABLE mission_packets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON mission_packets
    FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE mission_packets IS 'Single source of truth for working group findings. Every gap, fix, evaluation, and ship flows through this table. Triage AIRE scores here. Opus evaluates here. Dashboard reads here.';
