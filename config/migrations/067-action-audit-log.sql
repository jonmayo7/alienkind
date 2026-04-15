-- Migration 067: Create action_audit_log table for action evaluator decisions.
-- Mirrors AuditEntry interface in scripts/lib/action-evaluator.ts.
-- File-based log (logs/action-decisions.jsonl) remains as fallback.

CREATE TABLE IF NOT EXISTS action_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_type TEXT NOT NULL,
  target TEXT NOT NULL,
  tier TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  source_hook TEXT NOT NULL,
  terminal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for nightly analysis queries (by date, decision type)
CREATE INDEX IF NOT EXISTS idx_action_audit_log_timestamp ON action_audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_action_audit_log_decision ON action_audit_log (decision);

-- RLS: service role only (internal audit data)
ALTER TABLE action_audit_log ENABLE ROW LEVEL SECURITY;
