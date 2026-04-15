-- ============================================================
-- MIGRATION 012: Proposals Table
-- Autonomous preparation with human approval gate.
-- Any source (failure detection, Discord analysis, nightly
-- insight) can generate a proposal. [HUMAN] reviews via Telegram,
-- approves/rejects, and approved proposals execute.
-- Date: 2026-02-24
-- ============================================================

CREATE TABLE IF NOT EXISTS proposals (
  id bigserial PRIMARY KEY,

  -- Source identification
  source text NOT NULL,                           -- 'self_healing', 'discord_analysis', 'nightly_insight', 'content_pipeline', 'manual'
  source_context jsonb DEFAULT '{}'::jsonb,       -- { job_name, error_message, discord_channel, conversation_id, etc. }

  -- What happened
  trigger_summary text NOT NULL,                  -- "Content pipeline failed at Miner stage: missing systemPrompt"
  diagnosis text,                                 -- Root cause analysis
  evidence jsonb DEFAULT '[]'::jsonb,             -- [{ type: 'log', content: '...' }, { type: 'file', path: '...', relevant_lines: '...' }]

  -- What I want to do
  proposed_action text NOT NULL,                  -- "Add lightweight systemPrompt to Researcher/Miner/Architect stages"
  proposed_diff text,                             -- Actual code changes (unified diff format or description)
  files_affected text[] DEFAULT '{}',             -- ['scripts/content-pipeline.js', 'scripts/lib/constants.js']
  risk_assessment text,                           -- "Low risk — additive change, no existing behavior modified"
  tests_status text,                              -- 'not_run', 'passing', 'failing', 'not_applicable'
  tests_detail text,                              -- "55/55 content pipeline tests passing with change applied"

  -- Approval workflow
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'expired')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  human_feedback text,                              -- Freeform feedback on approval/rejection
  approved_at timestamptz,
  executed_at timestamptz,
  execution_result text,                          -- What happened when the approved proposal was executed

  -- Expiry
  expires_at timestamptz,                         -- Auto-expire if not reviewed (e.g., 24h for non-urgent)

  -- Telegram delivery tracking
  telegram_message_id bigint,                     -- Message ID of the proposal notification sent to [HUMAN]
  telegram_delivered_at timestamptz,

  -- Metadata
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);
CREATE INDEX IF NOT EXISTS idx_proposals_source ON proposals (source);
CREATE INDEX IF NOT EXISTS idx_proposals_priority ON proposals (priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals (created_at DESC);

-- Full-text search on trigger + action
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    coalesce(trigger_summary, '') || ' ' ||
    coalesce(proposed_action, '') || ' ' ||
    coalesce(diagnosis, '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_proposals_fts ON proposals USING GIN (fts);

-- RLS
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow service role full access" ON proposals
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_proposals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS proposals_updated_at ON proposals;
CREATE TRIGGER proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_proposals_updated_at();
