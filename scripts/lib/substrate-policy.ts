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
  | 'opus' | '[model_tier_2]' | '[MODEL_TIER_3]' | 'gemini'
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
 * Load [HUMAN]'s human preference signal from morning_brief_feedback.
 * Returns per-substrate quality adjustments based on thumbs up/down.
 * This is the most valuable signal — real human preference on real output.
 */
async function loadHumanFeedback(): Promise<Record<string, { ups: number; downs: number; total: number; score: number }>> {
  const { supabaseGet } = require('./supabase.ts');
  const result: Record<string, { ups: number; downs: number; total: number; score: number }> = {};
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Get feedback with section substrate info
    const feedback = await supabaseGet('morning_brief_feedback',
      `created_at=gte.${cutoff}&select=vote,section_id&order=created_at.desc&limit=200`
    );
    if (!feedback || feedback.length === 0) return result;

    const sectionIds = [...new Set(feedback.map((f: any) => f.section_id))];
    const sections = await supabaseGet('morning_brief_sections',
      `id=in.(${sectionIds.join(',')})&select=id,substrate`
    );
    const substrateMap: Record<string, string> = {};
    for (const s of sections || []) substrateMap[s.id] = s.substrate;

    for (const f of feedback) {
      const substrate = substrateMap[f.section_id];
      if (!substrate) continue;
      if (!result[substrate]) result[substrate] = { ups: 0, downs: 0, total: 0, score: 0 };
      result[substrate].total++;
      if (f.vote === 'up') result[substrate].ups++;
      if (f.vote === 'down') result[substrate].downs++;
    }

    // Compute preference score: (ups - downs) / total, scaled to 0-100
    // 100% ups = +25 quality bonus, 100% downs = -25 quality penalty
    for (const sub of Object.values(result)) {
      sub.score = sub.total > 0 ? ((sub.ups - sub.downs) / sub.total) * 25 : 0;
    }
  } catch {
    // Feedback unavailable — no human signal yet
  }
  return result;
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

  // Load human preference signal ([HUMAN]'s morning brief feedback)
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
    // Human preference: [HUMAN]'s thumbs up/down from morning brief feedback.
    // Real human preference is the most valuable signal — weighted heavily.
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
