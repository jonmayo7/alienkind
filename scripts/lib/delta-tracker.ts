/**
 * Delta Tracker — Prediction/Outcome/Experience tracking for Keel's calibration layer.
 *
 * Three tables:
 *   predictions — logged BEFORE an action/assertion
 *   outcomes    — logged AFTER the result is known, linked to prediction
 *   experiences — raw observations, domain-tagged, orientation-flagged
 *
 * Usage:
 *   const { logPrediction, logOutcome, logExperience } = require('./delta-tracker.ts');
 */

const { supabasePost, supabaseGet, supabasePatch } = require('./supabase.ts');

interface PredictionParams {
  prediction: string;
  confidence: number;
  domain: string;
  context?: string;
  sourceChannel?: string;
  sessionId?: string;
}

interface OutcomeParams {
  predictionId?: number;
  outcome: string;
  deltaScore: number;
  surpriseSignal?: string;
  learning?: string;
  domain: string;
  sourceChannel?: string;
  sessionId?: string;
}

interface ExperienceParams {
  observation: string;
  domain: string;
  significance?: number;
  tags?: string[];
  sourceChannel?: string;
  sessionId?: string;
  orientationRelevant?: boolean;
}

interface DomainSummary {
  count: number;
  totalDelta: number;
  surprises: number;
  avgDelta?: number;
}

interface DeltaSummary {
  totalPredictions: number;
  resolved: number;
  unresolved: number;
  totalOutcomes: number;
  avgDelta: number | null;
  byDomain: Record<string, DomainSummary>;
}

interface GetOptions {
  domain?: string;
  limit?: number;
  days?: number;
}

/**
 * Log a prediction before an action/assertion.
 */
async function logPrediction({ prediction, confidence, domain, context, sourceChannel, sessionId }: PredictionParams): Promise<number | null> {
  const pred = prediction?.trim();
  const dom = domain?.trim();
  if (!pred || !dom) {
    if (typeof console !== 'undefined') console.warn(`[delta-tracker] logPrediction skipped: missing ${!pred ? 'prediction' : 'domain'}`);
    return null;
  }
  try {
    const rows = await supabasePost('predictions', {
      prediction: pred,
      confidence,
      domain: dom,
      context: context || null,
      source_channel: sourceChannel || null,
      session_id: sessionId || null,
    }, { prefer: 'return=representation' });
    return rows && rows[0] ? rows[0].id : null;
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] logPrediction failed:', err.message);
    return null;
  }
}

/**
 * Log an outcome after a result is known. Links to a prediction.
 */
async function logOutcome({ predictionId, outcome, deltaScore, surpriseSignal, learning, domain, sourceChannel, sessionId }: OutcomeParams): Promise<number | null> {
  const out = outcome?.trim();
  const dom = domain?.trim();
  if (!out || !dom) {
    if (typeof console !== 'undefined') console.warn(`[delta-tracker] logOutcome skipped: missing ${!out ? 'outcome' : 'domain'}`);
    return null;
  }
  try {
    const rows = await supabasePost('outcomes', {
      prediction_id: predictionId || null,
      outcome: out,
      delta_score: deltaScore,
      surprise_signal: surpriseSignal || null,
      learning: learning || null,
      domain: dom,
      source_channel: sourceChannel || null,
      session_id: sessionId || null,
    }, { prefer: 'return=representation' });

    const outcomeId = rows && rows[0] ? rows[0].id : null;

    // Mark the prediction as resolved
    if (predictionId && outcomeId) {
      await supabasePatch('predictions', `id=eq.${predictionId}`, { resolved: true }).catch(() => {});
    }

    return outcomeId;
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] logOutcome failed:', err.message);
    return null;
  }
}

/**
 * Log a raw experience/observation.
 */
async function logExperience({ observation, domain, significance, tags, sourceChannel, sessionId, orientationRelevant }: ExperienceParams): Promise<number | null> {
  const obs = observation?.trim();
  const dom = domain?.trim();
  if (!obs || !dom) {
    if (typeof console !== 'undefined') console.warn(`[delta-tracker] logExperience skipped: missing ${!obs ? 'observation' : 'domain'}`);
    return null;
  }
  try {
    const rows = await supabasePost('experiences', {
      observation: obs,
      domain: dom,
      significance: significance || 5,
      tags: tags || null,
      source_channel: sourceChannel || null,
      session_id: sessionId || null,
      orientation_relevant: orientationRelevant || false,
    }, { prefer: 'return=representation' });
    return rows && rows[0] ? rows[0].id : null;
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] logExperience failed:', err.message);
    return null;
  }
}

/**
 * Get unresolved predictions (for nightly review / delta analysis).
 */
async function getUnresolvedPredictions(opts: GetOptions = {}): Promise<any[]> {
  try {
    let query = 'select=*&resolved=eq.false&order=created_at.desc';
    if (opts.domain) query += `&domain=eq.${opts.domain}`;
    query += `&limit=${opts.limit || 50}`;
    return await supabaseGet('predictions', query);
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] getUnresolvedPredictions failed:', err.message);
    return [];
  }
}

/**
 * Get delta summary stats for nightly analysis.
 */
async function getDeltaSummary(opts: GetOptions = {}): Promise<DeltaSummary> {
  const days = opts.days || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const predictions = await supabaseGet('predictions', `select=*&created_at=gte.${since}&order=created_at.desc`);
    const outcomes = await supabaseGet('outcomes', `select=*&created_at=gte.${since}&order=created_at.desc`);

    const byDomain: Record<string, DomainSummary> = {};
    for (const o of (outcomes || [])) {
      if (!byDomain[o.domain]) byDomain[o.domain] = { count: 0, totalDelta: 0, surprises: 0 };
      byDomain[o.domain].count++;
      if (o.delta_score != null) byDomain[o.domain].totalDelta += parseFloat(o.delta_score);
      if (o.surprise_signal) byDomain[o.domain].surprises++;
    }

    // Compute averages
    for (const d of Object.keys(byDomain)) {
      byDomain[d].avgDelta = byDomain[d].count > 0
        ? Math.round((byDomain[d].totalDelta / byDomain[d].count) * 100) / 100
        : 0;
    }

    const allDeltas = (outcomes || []).filter((o: any) => o.delta_score != null).map((o: any) => parseFloat(o.delta_score));
    const avgDelta = allDeltas.length > 0
      ? Math.round((allDeltas.reduce((a: number, b: number) => a + b, 0) / allDeltas.length) * 100) / 100
      : null;

    return {
      totalPredictions: (predictions || []).length,
      resolved: (predictions || []).filter((p: any) => p.resolved).length,
      unresolved: (predictions || []).filter((p: any) => !p.resolved).length,
      totalOutcomes: (outcomes || []).length,
      avgDelta,
      byDomain,
    };
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] getDeltaSummary failed:', err.message);
    return { totalPredictions: 0, resolved: 0, unresolved: 0, totalOutcomes: 0, avgDelta: null, byDomain: {} };
  }
}

/**
 * Get orientation-relevant experiences for feeding orientation.md updates.
 */
async function getOrientationExperiences(opts: GetOptions = {}): Promise<any[]> {
  const days = opts.days || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    return await supabaseGet('experiences',
      `select=*&orientation_relevant=eq.true&created_at=gte.${since}&order=significance.desc,created_at.desc&limit=${opts.limit || 100}`
    );
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[delta-tracker] getOrientationExperiences failed:', err.message);
    return [];
  }
}

module.exports = {
  logPrediction,
  logOutcome,
  logExperience,
  getUnresolvedPredictions,
  getDeltaSummary,
  getOrientationExperiences,
};
