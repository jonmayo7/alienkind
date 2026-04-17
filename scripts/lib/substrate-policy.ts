/**
 * Substrate Policy — Data-driven substrate selection per channel.
 *
 * Reads Keel Arena results from substrate_arena table and returns the best
 * substrate for a given channel based on meritocracy: quality × speed × cost.
 *
 * One consciousness, multiple bodies, routed by evidence — not guesses.
 *
 * Writers: scripts/keel-arena.ts (fills substrate_arena table)
 * Readers: consciousness scripts that want policy-based substrate selection
 *
 * Usage:
 *   const { selectSubstrate } = require('./lib/substrate-policy.ts');
 *   const substrate = await selectSubstrate('linkedin_comments');
 *   // Returns the highest-scoring substrate for that channel, or null if
 *   // no arena data exists yet (caller falls back to 'opus' or 'auto').
 */

type Substrate =
  | 'opus' | 'gateway-fallback' | 'gateway-fallback-alt' | 'gemini'
  | 'studio1-local' | 'studio1-identity'
  | 'studio2-daily' | 'studio2-heavy';

interface PolicyOptions {
  /** How to weight quality vs speed in selection. 1.0 = quality only, 0.0 = speed only. */
  qualityWeight?: number;
  /** Minimum quality score to consider (0-100). Substrates below this are filtered out. */
  minQuality?: number;
  /** How many recent runs to consider. Prevents stale data bias. */
  lookbackRuns?: number;
  /** Minimum samples required before policy routes. Prevents premature routing on sparse data. */
  minSamples?: number;
}

interface SubstrateStats {
  substrate: Substrate;
  avgQuality: number | null;
  avgLatencyMs: number;
  errorRate: number;
  sampleCount: number;
  compositeScore: number;
}

/**
 * Load the human's preference signal from a feedback table (if one is wired).
 *
 * AlienKind ships this function as a no-op default: returns an empty map,
 * which means no human-preference adjustment is applied to substrate scoring.
 * Substrate selection falls back to pure arena data (quality, speed, errors).
 *
 * Forkers who ship a feedback surface (a review UI that records thumbs-up/
 * thumbs-down on generated sections, keyed by substrate) can replace this
 * function to read their own feedback table. The expected return shape is a
 * map from substrate name to { ups, downs, total, score } where score is
 * scaled to roughly [-25, +25] so it adds/subtracts quality points from the
 * composite.
 */
async function loadHumanFeedback(): Promise<Record<string, { ups: number; downs: number; total: number; score: number }>> {
  // No-op by default. Replace with a reader for your feedback surface.
  return {};
}

/**
 * Get substrate stats for a given channel from arena data + human feedback.
 */
async function getSubstrateStats(channel: string, opts: PolicyOptions = {}): Promise<SubstrateStats[]> {
  const { supabaseGet } = require('./supabase.ts');
  const qualityWeight = opts.qualityWeight ?? 0.75;  // default: quality matters 3x more than speed
  const minQuality = opts.minQuality ?? 50;

  // Load arena data
  const limit = opts.lookbackRuns ?? 200;
  const query = `select=substrate,quality_score,latency_ms,error&channel=eq.${encodeURIComponent(channel)}&order=created_at.desc&limit=${limit}`;
  const rows = await supabaseGet('substrate_arena', query);

  // Load human preference signal (no-op by default; forkers wire their own)
  const humanFeedback = await loadHumanFeedback();

  // Aggregate by substrate
  const bySubstrate: Record<string, { scores: number[]; latencies: number[]; errors: number; total: number }> = {};
  for (const r of rows) {
    const sub = r.substrate;
    if (!bySubstrate[sub]) bySubstrate[sub] = { scores: [], latencies: [], errors: 0, total: 0 };
    bySubstrate[sub].total++;
    if (r.error) bySubstrate[sub].errors++;
    if (r.quality_score !== null && r.quality_score !== undefined) bySubstrate[sub].scores.push(r.quality_score);
    if (r.latency_ms) bySubstrate[sub].latencies.push(r.latency_ms);
  }

  // Compute stats + composite score
  const stats: SubstrateStats[] = [];
  // Normalize latency: fastest substrate gets 100, slowest gets 0
  const allLatencies = Object.values(bySubstrate).flatMap((d) => d.latencies);
  const minLat = Math.min(...allLatencies, Infinity);
  const maxLat = Math.max(...allLatencies, 0);
  const latRange = maxLat - minLat || 1;

  for (const [sub, d] of Object.entries(bySubstrate)) {
    const avgQuality = d.scores.length ? d.scores.reduce((a, b) => a + b, 0) / d.scores.length : null;
    const avgLatency = d.latencies.length ? d.latencies.reduce((a, b) => a + b, 0) / d.latencies.length : 0;
    const errorRate = d.total > 0 ? d.errors / d.total : 0;

    // Composite: quality * qualityWeight + speed * (1 - qualityWeight) - error penalty + human preference
    const speedScore = 100 - ((avgLatency - minLat) / latRange) * 100;
    const qualityComponent = (avgQuality ?? 0) * qualityWeight;
    const speedComponent = speedScore * (1 - qualityWeight);
    const errorPenalty = errorRate * 50;  // each 10% error rate = -5 composite points
    // Human preference bonus: zero by default. Forkers who wire a feedback
    // surface (see loadHumanFeedback above) have this signal weighted heavily.
    const humanBonus = humanFeedback[sub]?.score ?? 0;
    const composite = qualityComponent + speedComponent - errorPenalty + humanBonus;

    stats.push({
      substrate: sub as Substrate,
      avgQuality,
      avgLatencyMs: Math.round(avgLatency),
      errorRate,
      sampleCount: d.total,
      compositeScore: Math.round(composite * 10) / 10,
    });
  }

  const minSamples = opts.minSamples ?? 10;
  // Filter by minQuality, require enough samples, sort by composite
  return stats
    .filter((s) => s.sampleCount >= minSamples)
    .filter((s) => s.avgQuality === null || s.avgQuality >= minQuality)
    .sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Load active cascade routing hints for a channel.
 * Returns the highest-confidence active, non-expired hint if one exists.
 */
async function getCascadeHint(channel: string): Promise<{ substrate: Substrate; hint_type: string; confidence: number } | null> {
  try {
    const { supabaseGet: sbGet } = require('./supabase.ts');
    const now = new Date().toISOString();
    // Check for channel-specific hint first, then global (channel IS NULL)
    const hints = await sbGet('cascade_routing_hints',
      `active=eq.true&expires_at=gte.${now}&or=(channel.eq.${encodeURIComponent(channel)},channel.is.null)&order=confidence.desc&limit=5`
    );
    if (!hints || hints.length === 0) return null;

    // Prefer channel-specific over global
    const channelHint = hints.find((h: any) => h.channel === channel);
    const hint = channelHint || hints[0];

    // Only act on hints with enough confidence
    if (hint.confidence < 0.5) return null;

    return {
      substrate: hint.recommended_substrate as Substrate,
      hint_type: hint.hint_type,
      confidence: hint.confidence,
    };
  } catch {
    return null; // Hints unavailable — no pre-filter
  }
}

/**
 * Select the best substrate for a given channel based on arena data.
 * Pre-filters with cascade routing hints before arena-based ranking.
 * Returns null if no data exists (caller should use 'auto' or default).
 */
async function selectSubstrate(channel: string, opts: PolicyOptions = {}): Promise<Substrate | null> {
  // Pre-filter: cascade routing hints override arena ranking for specific patterns
  const cascadeHint = await getCascadeHint(channel);
  if (cascadeHint) {
    // skip_local: data says this channel always needs a heavier substrate
    // local_sufficient: data says local handles this channel fine (no need to escalate)
    // Both are direct routing recommendations from mined cascade decision data
    return cascadeHint.substrate;
  }

  const stats = await getSubstrateStats(channel, opts);
  if (stats.length === 0) return null;
  return stats[0].substrate;
}

/**
 * Get the full substrate ranking for a channel — useful for debugging/visibility.
 */
async function rankSubstrates(channel: string, opts: PolicyOptions = {}): Promise<SubstrateStats[]> {
  return getSubstrateStats(channel, opts);
}

module.exports = { selectSubstrate, rankSubstrates, getSubstrateStats, getCascadeHint };
