-- Migration 076: Substrate Arena
-- Keel-specific meritocracy for substrate selection. Every substrate runs every
-- channel's representative tasks through the consciousness engine. Results are
-- scored, stored, and queried by policy layer for intentional substrate routing.
--
-- One consciousness, multiple bodies. The arena tells us which body wins for which task.

CREATE TABLE IF NOT EXISTS substrate_arena (
  id BIGSERIAL PRIMARY KEY,

  -- Identity of this arena entry
  substrate TEXT NOT NULL,           -- 'opus', '[model_tier_2]', '[MODEL_TIER_3]', 'gemini',
                                     -- 'studio1-local', 'studio1-identity',
                                     -- 'studio2-daily', 'studio2-heavy'
  channel TEXT NOT NULL,             -- channel config name (e.g., 'linkedin_comments')
  task_key TEXT NOT NULL,            -- stable identifier for this task (e.g., 'identity_v1')
  run_id TEXT NOT NULL,              -- groups results from the same arena run

  -- The task and result
  task_prompt TEXT NOT NULL,
  response TEXT,                     -- substrate's output, NULL if errored
  error TEXT,                        -- error message if call failed
  model TEXT,                        -- concrete model name (e.g., 'claude-opus-4-6')

  -- Performance measurements
  latency_ms INTEGER,
  tokens_generated INTEGER,
  tokens_per_second NUMERIC,
  cost_estimate_usd NUMERIC DEFAULT 0,  -- 0 for local substrates

  -- Quality scoring (filled in after generation)
  quality_score NUMERIC,             -- 0-100
  scored_by TEXT,                    -- 'automated' | 'keel_self_eval' | '[human_first]'
  scoring_rationale TEXT,
  scored_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS substrate_arena_channel_substrate
  ON substrate_arena(channel, substrate, created_at DESC);

CREATE INDEX IF NOT EXISTS substrate_arena_run_id
  ON substrate_arena(run_id);

CREATE INDEX IF NOT EXISTS substrate_arena_quality
  ON substrate_arena(channel, quality_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS substrate_arena_created_at
  ON substrate_arena(created_at DESC);

COMMENT ON TABLE substrate_arena IS 'Keel substrate meritocracy. Every substrate × every channel × every representative task. Policy layer reads this to pick substrates per channel.';
COMMENT ON COLUMN substrate_arena.substrate IS 'Compute backend identifier. One of the tiers in runtime.ts.';
COMMENT ON COLUMN substrate_arena.run_id IS 'Groups an entire arena run (all substrates × all tasks) for comparison.';
COMMENT ON COLUMN substrate_arena.quality_score IS '0-100 score. Filled in after generation by automated rules, Keel-self-eval, or [HUMAN].';
