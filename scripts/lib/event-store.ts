// @alienkind-core
/**
 * Event Store — organism nervous system.
 *
 * Append-only event store backed by Supabase `system_events` table.
 * Every subsystem emits events. Downstream subsystems query by event_type.
 *
 * Usage:
 *   const { emitEvent, queryEvents, getLatestEvent } = require('./event-store.ts');
 *
 *   // Emit when a pipeline completes
 *   await emitEvent('pipeline.completed', 'nightly-runner', {
 *     run_id: 42, duration_ms: 3200, items_processed: 17
 *   });
 *
 *   // Query recent events of a type
 *   const drifts = await queryEvents('watchdog.drift', { limit: 10, hours: 24 });
 *
 * Convention for event_type naming: {source}.{action}
 *   - pipeline.completed, pipeline.failed
 *   - watchdog.drift, watchdog.clean
 *   - job.started, job.completed, job.failed
 *   - content.published, content.blocked
 *   - {source} is the subsystem name; {action} is the outcome.
 */
/*
Cross-subsystem observability: because every pipeline writes to the same
append-only log keyed by event_type and source_system, any subsystem can
query another's output to verify it ran, read its result, or compute
health metrics. This is the "nervous system" for the organism — no single
component is a black box because every outcome is visible on the bus.
*/

const { supabasePost, supabaseGet } = require('./supabase.ts');

interface EmitOptions {
  metadata?: Record<string, any>;
}

interface QueryOptions {
  limit?: number;
  hours?: number;
  since?: string;  // ISO timestamp
}

/**
 * Emit an event to the system event store.
 * Returns the sequence_number of the inserted event.
 */
async function emitEvent(
  eventType: string,
  sourceSystem: string,
  payload: Record<string, any>,
  opts: EmitOptions = {}
): Promise<number | null> {
  try {
    const rows = await supabasePost('system_events', {
      event_type: eventType,
      source_system: sourceSystem,
      payload,
      metadata: opts.metadata || {},
    }, { prefer: 'return=representation' });
    return rows && rows[0] ? rows[0].sequence_number : null;
  } catch (err: any) {
    if (typeof console !== 'undefined') {
      console.error(`[event-store] emitEvent failed (${eventType}): ${err.message}`);
    }
    return null;
  }
}

/**
 * Query recent events by type.
 */
async function queryEvents(
  eventType: string,
  opts: QueryOptions = {}
): Promise<any[]> {
  try {
    const limit = opts.limit || 50;
    let query = `select=*&event_type=eq.${eventType}&order=occurred_at.desc&limit=${limit}`;

    if (opts.since) {
      query += `&occurred_at=gte.${opts.since}`;
    } else if (opts.hours) {
      const since = new Date(Date.now() - opts.hours * 3600000).toISOString();
      query += `&occurred_at=gte.${since}`;
    }

    return await supabaseGet('system_events', query);
  } catch (err: any) {
    if (typeof console !== 'undefined') {
      console.error(`[event-store] queryEvents failed (${eventType}): ${err.message}`);
    }
    return [];
  }
}

/**
 * Get the most recent event from a source system.
 */
async function getLatestEvent(sourceSystem: string): Promise<any | null> {
  try {
    const rows = await supabaseGet('system_events',
      `select=*&source_system=eq.${sourceSystem}&order=occurred_at.desc&limit=1`
    );
    return rows && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get event counts by type for a time window (for health dashboards).
 */
async function getEventCounts(hours: number = 24): Promise<Record<string, number>> {
  try {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const rows = await supabaseGet('system_events',
      `select=event_type&occurred_at=gte.${since}`
    );
    const counts: Record<string, number> = {};
    for (const row of (rows || [])) {
      counts[row.event_type] = (counts[row.event_type] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

module.exports = { emitEvent, queryEvents, getLatestEvent, getEventCounts };
