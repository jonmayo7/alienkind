/**
 * Comms Coordination — Data helpers for coordination requests.
 *
 * Provides read-only data access to the coordination_requests table
 * for nightly/immune, scheduled analyzers, and other reporting consumers.
 *
 * Data flows:
 *   Readers: nightly analysis, nightly/immune, any scheduled reporter
 *   Table: coordination_requests (Supabase)
 */

const { supabaseGet, supabasePatch } = require('./supabase.ts');

// --- Types ---

interface CoordinationRequest {
  id: string;
  source_channel: string;
  source_message_id?: string;
  sender: string;
  message_text: string;
  evaluation?: string;
  proposed_response?: string;
  target_channel: string;
  target_context?: string;
  status: string;
  coordination_notes?: string;
  created_at: string;
  evaluated_at?: string;
  aligned_at?: string;
  executed_at?: string;
}

// --- Helpers ---

/**
 * Format internal channel identifiers as human-readable labels.
 * discord_partner_collab → #a channel, telegram_group → #a channel, etc.
 */
function formatChannelLabel(channel: string): string {
  if (!channel) return channel;
  return '#' + channel
    .replace(/^discord_/, '')
    .replace(/^telegram_/, '')
    .replace(/^keel_proactive_.*/, 'keel-initiated')
    .replace(/_/g, '-');
}

// --- Data Access Functions ---

/**
 * Get pending coordination requests (status = 'evaluated', waiting for the human).
 */
async function getPendingCoordRequests(): Promise<CoordinationRequest[]> {
  return supabaseGet(
    'coordination_requests',
    'status=eq.evaluated&order=created_at.desc&limit=20'
  );
}

/**
 * Get coordination request stats for a date range.
 * Used by nightly analysis and scheduled reporters.
 */
async function getCoordStats(dateFrom: string): Promise<{
  total: number;
  evaluated: number;
  aligned: number;
  rejected: number;
  executed: number;
  expired: number;
  proactive: number;
}> {
  try {
    const all = await supabaseGet(
      'coordination_requests',
      `created_at=gte.${dateFrom}T00:00:00&select=status,sender`
    );
    if (!all || all.length === 0) {
      return { total: 0, evaluated: 0, aligned: 0, rejected: 0, executed: 0, expired: 0, proactive: 0 };
    }
    return {
      total: all.length,
      evaluated: all.filter((r: any) => r.status === 'evaluated').length,
      aligned: all.filter((r: any) => r.status === 'aligned').length,
      rejected: all.filter((r: any) => r.status === 'rejected').length,
      executed: all.filter((r: any) => r.status === 'executed').length,
      expired: all.filter((r: any) => r.status === 'expired').length,
      proactive: all.filter((r: any) => r.sender === 'keel').length,
    };
  } catch {
    return { total: 0, evaluated: 0, aligned: 0, rejected: 0, executed: 0, expired: 0, proactive: 0 };
  }
}

/**
 * Get coordination requests with the human's edits (for learning analysis).
 * Returns requests where the human changed the proposed response.
 */
async function getEditedRequests(dateFrom: string): Promise<CoordinationRequest[]> {
  try {
    return supabaseGet(
      'coordination_requests',
      `created_at=gte.${dateFrom}T00:00:00&coordination_notes=not.is.null&status=eq.executed&select=*&order=created_at.desc&limit=20`
    );
  } catch {
    return [];
  }
}

/**
 * Expire stale coordination requests.
 * Requests at 'evaluated' for >24h → 'expired'.
 * Called from nightly-cycle.ts.
 */
async function expireStaleRequests(log: (level: string, msg: string) => void): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const stale = await supabaseGet(
      'coordination_requests',
      `status=eq.evaluated&created_at=lt.${cutoff}&select=id`
    );
    if (!stale || stale.length === 0) return 0;
    for (const row of stale) {
      await supabasePatch('coordination_requests', `id=eq.${row.id}`, {
        status: 'expired',
        executed_at: new Date().toISOString(),
      });
    }
    log('INFO', `[comms-coord] Expired ${stale.length} stale coordination request(s)`);
    return stale.length;
  } catch (err: any) {
    log('WARN', `[comms-coord] Expiry sweep failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  getPendingCoordRequests,
  getCoordStats,
  getEditedRequests,
  expireStaleRequests,
  formatChannelLabel,
};
