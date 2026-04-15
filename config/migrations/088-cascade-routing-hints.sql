-- Migration 088: Cascade routing hints for substrate routing optimization
-- Adds channel tracking to cascade_decisions and creates routing hints table
-- for the cascade decision mining pipeline.

-- 1. Add channel to cascade_decisions so we can mine per-channel patterns
ALTER TABLE cascade_decisions ADD COLUMN IF NOT EXISTS channel TEXT;
CREATE INDEX IF NOT EXISTS cascade_decisions_channel ON cascade_decisions(channel, created_at DESC);

-- 2. Routing hints derived from cascade decision mining
-- Written by cascade-decision-mining.ts, read by substrate-policy.ts
CREATE TABLE IF NOT EXISTS cascade_routing_hints (
  id BIGSERIAL PRIMARY KEY,
  hint_type TEXT NOT NULL,           -- 'skip_local', 'local_sufficient', 'confidence_calibration'
  channel TEXT,                       -- nullable (hint may be global)
  recommended_substrate TEXT,         -- what to route to instead
  confidence NUMERIC NOT NULL,        -- 0.0-1.0: how confident we are in this hint
  evidence JSONB NOT NULL DEFAULT '{}', -- supporting data (sample sizes, rates, etc.)
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL     -- hints decay — forces re-mining
);

CREATE INDEX IF NOT EXISTS cascade_routing_hints_active ON cascade_routing_hints(active, expires_at)
  WHERE active = true;
CREATE INDEX IF NOT EXISTS cascade_routing_hints_channel ON cascade_routing_hints(channel, hint_type)
  WHERE active = true;

COMMENT ON TABLE cascade_routing_hints IS 'Derived routing hints from cascade decision mining. Pre-filters substrate selection to skip unnecessary local round-trips or avoid unnecessary escalations.';
