-- Circulation table — the organism's bloodstream.
-- Stigmergic blackboard: organs deposit findings, other organs withdraw them.
-- Pheromone scoring with exponential decay, reinforcement counting, quorum sensing.
--
-- Design sources:
--   - organism-architecture.md ([HUMAN]/Keel 2026-03-24)
--   - Markspace protocol (trust-weighted decay, reinforcement, guard layer)
--   - Pressure-field experiment (temporal decay essential, 4x improvement over messaging)
--   - Stigmergy-MCP (exponential decay formula)
--   - Insight Swarm (vector similarity for cross-organ discovery)

CREATE TABLE IF NOT EXISTS circulation (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Source
  source_organ TEXT NOT NULL,             -- which organ/job deposited this (e.g., 'trading-aire', 'intent-audit', 'nightly-analysis')
  source_terminal TEXT,                    -- terminal ID if deposited by an interactive session

  -- Finding
  finding TEXT NOT NULL,                   -- what was observed
  finding_type TEXT NOT NULL DEFAULT 'observation',  -- pattern | anomaly | insight | metric | signal | gap | correction
  domain TEXT NOT NULL DEFAULT 'infrastructure',     -- trading | content | coaching | infrastructure | security | product | self
  confidence FLOAT DEFAULT 0.5,           -- 0-1, how certain the depositor is

  -- Pheromone scoring
  initial_intensity FLOAT DEFAULT 1.0,    -- starting intensity
  reinforcement_count INT DEFAULT 1,      -- incremented when multiple organs confirm same finding
  reinforced_by JSONB DEFAULT '[]',       -- array of organ names that reinforced this

  -- Decay
  decay_hours FLOAT NOT NULL DEFAULT 24,  -- exponential decay half-life in hours
  -- effective_intensity = initial_intensity * reinforcement_count * exp(-elapsed_hours / decay_hours)
  -- computed at read time, not stored

  -- Quorum
  quorum_threshold INT DEFAULT 1,         -- minimum reinforcement_count before this triggers action
  quorum_reached BOOLEAN DEFAULT false,   -- set true when reinforcement_count >= quorum_threshold
  quorum_reached_at TIMESTAMPTZ,          -- when quorum was first crossed

  -- Consumption
  consumed_by JSONB DEFAULT '[]',         -- array of {organ, consumed_at} — who has read this
  actions_taken JSONB DEFAULT '[]',       -- array of {action, result, taken_at} — what resulted

  -- Action classification
  action_tier TEXT,                        -- T1 (auto-fix) | T2 (fix + inform) | T3 (surface for [HUMAN])
  action_status TEXT DEFAULT 'pending',    -- pending | actioned | dismissed | expired

  -- Semantic discovery (vector embedding for cross-organ finding)
  -- Uses same embedding model as memory_chunks (Qwen3-Embedding 8B, 4096 dims)
  -- Populated asynchronously by the circulation pump
  embedding vector(4096),

  -- Metadata
  related_files JSONB DEFAULT '[]',       -- files affected by this finding
  metadata JSONB DEFAULT '{}',            -- arbitrary structured data from the depositor

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for domain-filtered reads (the primary query pattern)
CREATE INDEX IF NOT EXISTS idx_circulation_domain ON circulation(domain, created_at DESC);

-- Index for finding type queries
CREATE INDEX IF NOT EXISTS idx_circulation_type ON circulation(finding_type, created_at DESC);

-- Index for quorum detection
CREATE INDEX IF NOT EXISTS idx_circulation_quorum ON circulation(quorum_reached, action_status) WHERE quorum_reached = true AND action_status = 'pending';

-- Index for active findings (not expired — computed in queries via decay formula)
CREATE INDEX IF NOT EXISTS idx_circulation_active ON circulation(created_at DESC);

-- Index for reinforcement dedup (find existing findings to reinforce instead of duplicate)
CREATE INDEX IF NOT EXISTS idx_circulation_source_finding ON circulation(source_organ, finding_type);

-- Semantic search index (HNSW for vector similarity)
-- Note: Supabase has a 2000-dim cap on HNSW indexes. Use IVFFlat for 4096-dim vectors.
-- CREATE INDEX IF NOT EXISTS idx_circulation_embedding ON circulation USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
-- Deferred: populate embeddings first, then create index with sufficient data.

-- RLS
ALTER TABLE circulation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON circulation FOR ALL USING (true) WITH CHECK (true);

-- Default decay hours by finding type (reference — enforced in code, not in DB)
-- pattern: 48h | anomaly: 12h | insight: 72h | metric: 4h | signal: 4h | gap: 168h (7d) | correction: 336h (14d)
