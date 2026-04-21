// @alienkind-core
/**
 * memory-recall.ts — close the write-to-read loop on the memory layer.
 *
 * Records every touch of a memory artifact (surfaced / cited / confirmed /
 * corrected) and computes rolling recall rates. Without this the memory
 * system writes corrections, surfaces snippets, and there's no
 * measurement of whether any of it is serving the partner. The rate is
 * the forcing function for evolution — you can't improve what you don't
 * measure.
 *
 * Inspired by Conn's recall_rate_7d (0.24% baseline → 15% target) named
 * as a thesis-critical gap in the 2026-04-20 Conn × Kael bench.
 *
 * Storage: Supabase `memory_recall_events` + `memory_recall_rate_history`
 * (migration 002). Without Supabase configured every operation
 * gracefully no-ops and the capability reports itself unavailable via
 * portable.ts.
 *
 * Writers: memory-indexer.ts + memory-search.ts (surfaced), learning-
 *   ledger.ts (corrected / confirmed), any caller that wants to record
 *   a cite.
 * Readers: scripts/tools/recall-rate.ts (CLI report), nightly snapshot
 *   job, capability scorecard.
 */

const { supabaseGet, supabasePost } = require('./supabase.ts');
const { tryStorage, registerUnavailable } = require('./portable.ts');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  registerUnavailable('memory-recall', {
    reason: 'Supabase credentials not configured.',
    enableWith: 'Set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env. Run migration 002 against the project.',
    docs: 'HYPOTHESIS.md §9 Memory System; migrations/002-memory-recall-events.sql.',
  });
}

type RecallEventType = 'surfaced' | 'cited' | 'confirmed' | 'corrected';

interface RecallEvent {
  event_type: RecallEventType;
  memory_ref: string;
  memory_kind?: string;
  session_id?: string;
  terminal_id?: string;
  signal_delta?: number;
  metadata?: Record<string, any>;
}

interface RateResult {
  window_hours: number;
  surfaced: number;
  cited: number;
  rate: number;      // cited / surfaced, 0..1
  sample_size: number;
}

/**
 * Record a memory-touch event. Fire-and-forget. Never throws, never blocks.
 */
async function recordRecallEvent(event: RecallEvent): Promise<void> {
  if (!event || !event.event_type || !event.memory_ref) return;
  await tryStorage(
    () => supabasePost('memory_recall_events', {
      event_type: event.event_type,
      memory_ref: event.memory_ref,
      memory_kind: event.memory_kind || null,
      session_id: event.session_id || process.env.ALIENKIND_TERMINAL_ID || null,
      terminal_id: event.terminal_id || process.env.ALIENKIND_TERMINAL_ID || null,
      signal_delta: event.signal_delta ?? 0,
      metadata: event.metadata || null,
    }),
    null,
  );
}

/**
 * Rolling recall rate over a window. Default 7 days.
 * rate = cited_count / surfaced_count (floor 0 when surfaced==0).
 */
async function getRecallRate(windowHours: number = 24 * 7): Promise<RateResult> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const rows = await tryStorage(
    () => supabaseGet(
      'memory_recall_events',
      `select=event_type&created_at=gte.${since}&limit=100000`,
    ),
    [] as Array<{ event_type: RecallEventType }>,
  );
  const surfaced = rows.filter(r => r.event_type === 'surfaced').length;
  const cited = rows.filter(r => r.event_type === 'cited').length;
  const rate = surfaced > 0 ? cited / surfaced : 0;
  return { window_hours: windowHours, surfaced, cited, rate, sample_size: rows.length };
}

/**
 * Write a daily snapshot to memory_recall_rate_history. Idempotent per day
 * via the UNIQUE(snapshot_date, window_hours) constraint — re-running the
 * same day silently no-ops.
 */
async function snapshotRecallRate(windowHours: number = 24 * 7, notes?: string): Promise<RateResult> {
  const result = await getRecallRate(windowHours);
  const today = new Date().toISOString().slice(0, 10);
  await tryStorage(
    () => supabasePost('memory_recall_rate_history', {
      snapshot_date: today,
      window_hours: windowHours,
      surfaced_count: result.surfaced,
      cited_count: result.cited,
      recall_rate: result.rate,
      notes: notes || null,
    }),
    null,
  );
  return result;
}

module.exports = {
  recordRecallEvent,
  getRecallRate,
  snapshotRecallRate,
};
