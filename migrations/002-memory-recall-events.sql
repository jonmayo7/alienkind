-- Migration 002: memory_recall_events + memory_recall_rate_history
--
-- Introduces the measurement layer for the memory system. Without this
-- the learning-ledger writes corrections, memory-indexer surfaces
-- snippets, and nothing closes the loop on whether either is serving
-- the partner's evolution. Inspired by Conn's recall_rate_7d (0.24%
-- baseline, 15% target) surfaced in the 2026-04-20 Conn × Kael bench.
--
-- memory_recall_events — per-event log of every memory touch.
--   event_type: 'surfaced' | 'cited' | 'confirmed' | 'corrected'
--   memory_ref: file path, ledger entry id, or circulation finding id
--   signal_delta: score change applied (correction = -, confirm = +)
--
-- memory_recall_rate_history — daily snapshot for trending.
--   computed by scripts/tools/recall-rate.ts on a scheduled job.
--
-- Safe to re-run. IF NOT EXISTS on table and indexes.

CREATE TABLE IF NOT EXISTS memory_recall_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL CHECK (event_type IN ('surfaced','cited','confirmed','corrected')),
  memory_ref    TEXT NOT NULL,
  memory_kind   TEXT,
  session_id    TEXT,
  terminal_id   TEXT,
  signal_delta  REAL DEFAULT 0,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mre_created_at ON memory_recall_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mre_memory_ref ON memory_recall_events(memory_ref);
CREATE INDEX IF NOT EXISTS idx_mre_event_type ON memory_recall_events(event_type);

CREATE TABLE IF NOT EXISTS memory_recall_rate_history (
  id             BIGSERIAL PRIMARY KEY,
  snapshot_date  DATE NOT NULL,
  window_hours   INTEGER NOT NULL,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  cited_count    INTEGER NOT NULL DEFAULT 0,
  recall_rate    REAL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_date, window_hours)
);

CREATE INDEX IF NOT EXISTS idx_mrrh_date ON memory_recall_rate_history(snapshot_date DESC);
