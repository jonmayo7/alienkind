-- Migration 082: Cascade Decisions
-- Logs every confidence-based cascade routing decision for evaluation.
-- Writers: runtime.ts cascade routing
-- Readers: nightly-analysis (evaluate cascade quality), substrate-policy (tune thresholds),
--          morning brief (surface escalation patterns)

CREATE TABLE IF NOT EXISTS cascade_decisions (
  id BIGSERIAL PRIMARY KEY,
  steps JSONB NOT NULL,
  final_substrate TEXT NOT NULL,
  total_steps INTEGER NOT NULL,
  escalated BOOLEAN NOT NULL,
  total_latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cascade_decisions_created ON cascade_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS cascade_decisions_escalated ON cascade_decisions(escalated, created_at DESC);

COMMENT ON TABLE cascade_decisions IS 'Confidence cascade routing log. Feeds AIRE evaluation of when local models handle tasks vs when they correctly escalate.';
