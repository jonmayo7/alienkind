-- Migration 051: VGE Infrastructure — system_events + pipeline_traces + facts
--
-- Three tables that wire disconnected AIREs into a Verifiable Growth Ecosystem:
--   1. system_events — append-only event store. Every AIRE emits events.
--   2. pipeline_traces — observability. Every pipeline run proves what it did.
--   3. facts + fact_edges — knowledge graph with provenance and staleness cascade.
--
-- Together these replace the pattern where deep_process_outputs is the only
-- shared table and no AIRE validates another AIRE's output.

-- ═══════════════════════════════════════
-- SYSTEM EVENTS — the nervous system
-- ═══════════════════════════════════════
-- Append-only. Every AIRE emits events. Downstream AIREs subscribe.
-- Supabase Realtime (LISTEN/NOTIFY) gives push-based propagation for free.

CREATE TABLE IF NOT EXISTS system_events (
  sequence_number BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT NOT NULL,          -- e.g. 'incorporation.completed', 'ground-truth.drift', 'pulse.detection'
  source_system   TEXT NOT NULL,          -- e.g. 'incorporation-runner', 'ground-truth-check', 'operational-pulse'
  payload         JSONB NOT NULL DEFAULT '{}',
  metadata        JSONB NOT NULL DEFAULT '{}',  -- session_id, duration_ms, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_se_event_type ON system_events(event_type);
CREATE INDEX idx_se_source ON system_events(source_system);
CREATE INDEX idx_se_occurred ON system_events(occurred_at DESC);
CREATE INDEX idx_se_type_recent ON system_events(event_type, occurred_at DESC);

COMMENT ON TABLE system_events IS 'VGE: Append-only event store. Every AIRE emits events here. Downstream AIREs subscribe by event_type.';

-- ═══════════════════════════════════════
-- PIPELINE TRACES — observability
-- ═══════════════════════════════════════
-- Every pipeline run writes: what went in, what came out, whether it was valid.

CREATE TABLE IF NOT EXISTS pipeline_traces (
  id                BIGSERIAL PRIMARY KEY,
  trace_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_trace_id   UUID,                   -- for nested pipeline calls
  pipeline_name     TEXT NOT NULL,           -- e.g. 'incorporation-runner', 'nightly-immune', 'content-pipeline'
  input_summary     TEXT,                    -- what was fed in (abbreviated)
  output_summary    TEXT,                    -- what was produced (abbreviated)
  status            TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'error', 'skipped')),
  duration_ms       INTEGER,
  validation_results JSONB DEFAULT '{}',     -- post-run verification evidence
  findings_count    INTEGER DEFAULT 0,       -- how many actionable items produced
  metadata          JSONB DEFAULT '{}',      -- model_used, token_count, etc.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_pt_pipeline ON pipeline_traces(pipeline_name);
CREATE INDEX idx_pt_status ON pipeline_traces(status);
CREATE INDEX idx_pt_created ON pipeline_traces(created_at DESC);
CREATE INDEX idx_pt_trace ON pipeline_traces(trace_id);

COMMENT ON TABLE pipeline_traces IS 'VGE: Observability for every pipeline run. Proves what happened with validation evidence.';

-- ═══════════════════════════════════════
-- FACTS + FACT EDGES — knowledge graph
-- ═══════════════════════════════════════
-- Every derived claim carries a citation chain back to its source.
-- Content hashes detect when sources change.
-- Recursive CTEs trace the stale chain downstream.

CREATE TABLE IF NOT EXISTS facts (
  id              BIGSERIAL PRIMARY KEY,
  fact_type       TEXT NOT NULL             -- 'claim', 'config', 'metric', 'decision', 'count'
    CHECK (fact_type IN ('claim', 'config', 'metric', 'decision', 'count')),
  content         TEXT NOT NULL,            -- the actual fact (human-readable)
  value           TEXT,                     -- machine-readable value (number, date, etc.)
  source_file     TEXT,                     -- file where this fact originated
  source_system   TEXT,                     -- 'nightly-cycle', 'incorporation', 'ground-truth', 'manual'
  source_event_id BIGINT REFERENCES system_events(sequence_number),
  content_hash    TEXT,                     -- SHA-256 of source content at extraction time
  stale           BOOLEAN DEFAULT FALSE,    -- marked stale when source changes
  valid_from      TIMESTAMPTZ DEFAULT now(),
  valid_until     TIMESTAMPTZ,              -- NULL = still valid
  confidence      FLOAT DEFAULT 1.0
    CHECK (confidence >= 0 AND confidence <= 1),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact_edges (
  id              BIGSERIAL PRIMARY KEY,
  source_fact_id  BIGINT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  target_fact_id  BIGINT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  relationship    TEXT NOT NULL             -- 'derived_from', 'contradicts', 'supersedes', 'cites'
    CHECK (relationship IN ('derived_from', 'contradicts', 'supersedes', 'cites')),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_fact_id, target_fact_id, relationship)
);

CREATE INDEX idx_facts_type ON facts(fact_type);
CREATE INDEX idx_facts_source ON facts(source_system);
CREATE INDEX idx_facts_stale ON facts(stale) WHERE stale = TRUE;
CREATE INDEX idx_facts_valid ON facts(valid_until) WHERE valid_until IS NULL;
CREATE INDEX idx_fe_source ON fact_edges(source_fact_id);
CREATE INDEX idx_fe_target ON fact_edges(target_fact_id);
CREATE INDEX idx_fe_relationship ON fact_edges(relationship);

COMMENT ON TABLE facts IS 'VGE: Knowledge graph — every derived claim with provenance, content hashes, and staleness tracking.';
COMMENT ON TABLE fact_edges IS 'VGE: Relationships between facts — derived_from, contradicts, supersedes, cites. Enables staleness cascade via recursive CTEs.';

-- ═══════════════════════════════════════
-- PIPELINE FITNESS — AIRE health metrics
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_fitness (
  id                  BIGSERIAL PRIMARY KEY,
  pipeline            TEXT NOT NULL,         -- e.g. 'trading-analysis', 'content-pipeline', 'self-assessment'
  metric_name         TEXT NOT NULL,         -- e.g. 'signal_accuracy', 'engagement_delta', 'correction_rate'
  metric_value        FLOAT NOT NULL,
  measurement_context JSONB DEFAULT '{}',    -- domain, window_days, sample_size, etc.
  measured_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pf_pipeline ON pipeline_fitness(pipeline);
CREATE INDEX idx_pf_metric ON pipeline_fitness(metric_name);
CREATE INDEX idx_pf_measured ON pipeline_fitness(measured_at DESC);

COMMENT ON TABLE pipeline_fitness IS 'VGE: Fitness scores per AIRE per run. Tracks whether AIREs actually improve things.';
