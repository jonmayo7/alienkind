/**
 * Calibration Layer — data-driven complexity adjustment.
 *
 * Feeds delta observations back into classification decisions.
 * If light messages frequently trigger auto-resumes, upgrades to medium.
 * If medium triggers many, upgrades to heavy.
 *
 * Usage:
 *   const { calibrateComplexity, getCalibrationContext } = require('./calibration.ts');
 *   const adjusted = await calibrateComplexity('light', messageText);
 *   const ctx = await getCalibrationContext();
 */

const { supabaseGet } = require('./supabase.ts');
const { CALIBRATION } = require('./constants.ts');
const { readCalibration } = require('./substrate.ts');

type ComplexityLevel = 'light' | 'medium' | 'heavy';

interface CalibrationCache {
  complexity: number | null;
  context: string | null;
  ts: number;
}

// --- 5-minute TTL cache ---
let _cache: CalibrationCache = { complexity: null, context: null, ts: 0 };

function cacheValid(): boolean {
  return Date.now() - _cache.ts < CALIBRATION.cacheTtlMs;
}

/**
 * Adjust classification based on recent auto-resume patterns.
 */
async function calibrateComplexity(baseClassification: ComplexityLevel, _messageText?: string): Promise<ComplexityLevel> {
  try {
    if (baseClassification === 'heavy') return 'heavy';

    // Use cached data if fresh
    if (cacheValid() && _cache.complexity !== null) {
      return applyCalibration(baseClassification, _cache.complexity);
    }

    const since = new Date(Date.now() - CALIBRATION.lookbackDays * 86400000).toISOString();
    const rows = await supabaseGet('keel_experiences',
      `select=tags,significance&domain=eq.interaction&created_at=gte.${since}&order=created_at.desc&limit=20`,
      { timeout: 5000 }
    );

    const autoResumeCount = (rows || []).filter((r: any) =>
      r.tags && Array.isArray(r.tags) && r.tags.includes('auto-resume')
    ).length;

    _cache.complexity = autoResumeCount;
    _cache.ts = Date.now();

    return applyCalibration(baseClassification, autoResumeCount);
  } catch (err) {
    // Supabase failed — try local substrate fallback
    try {
      const local = readCalibration();
      if (local && local.experiences) {
        const autoResumeCount = local.experiences.filter((r: any) =>
          r.tags && Array.isArray(r.tags) && r.tags.includes('auto-resume')
        ).length;
        _cache.complexity = autoResumeCount;
        _cache.ts = Date.now();
        return applyCalibration(baseClassification, autoResumeCount);
      }
    } catch { /* fallback failed too */ }
    return baseClassification;
  }
}

function applyCalibration(base: ComplexityLevel, autoResumeCount: number): ComplexityLevel {
  if (base === 'light' && autoResumeCount >= CALIBRATION.autoResumeThreshold) {
    return 'medium';
  }
  if (base === 'medium' && autoResumeCount >= CALIBRATION.autoResumeThreshold * 2) {
    return 'heavy';
  }
  return base;
}

/**
 * Returns a text block summarizing recent delta patterns.
 * For injection into heartbeat/morning prompts.
 */
async function getCalibrationContext(): Promise<string> {
  try {
    // Use cached context if fresh
    if (cacheValid() && _cache.context !== null) {
      return _cache.context;
    }

    const since = new Date(Date.now() - CALIBRATION.lookbackDays * 86400000).toISOString();

    const outcomes = await supabaseGet('keel_outcomes',
      `select=delta_score,surprise_signal,learning&created_at=gte.${since}&order=created_at.desc&limit=20`,
      { timeout: 5000 }
    );

    if (!outcomes || outcomes.length === 0) {
      _cache.context = '';
      _cache.ts = Date.now();
      return '';
    }

    const deltas = outcomes.filter((o: any) => o.delta_score != null).map((o: any) => parseFloat(o.delta_score));
    const avgDelta = deltas.length > 0
      ? Math.round((deltas.reduce((a: number, b: number) => a + b, 0) / deltas.length) * 100) / 100
      : null;
    const surpriseCount = outcomes.filter((o: any) => o.surprise_signal).length;
    const learnings = outcomes.filter((o: any) => o.learning).map((o: any) => o.learning).slice(0, 3);

    const lines: string[] = ['CALIBRATION CONTEXT (last 7 days):'];
    if (avgDelta !== null) lines.push(`  Avg delta score: ${avgDelta}`);
    lines.push(`  Outcomes: ${outcomes.length}, Surprises: ${surpriseCount}`);
    if (learnings.length > 0) {
      lines.push('  Top learnings:');
      learnings.forEach((l: string) => lines.push(`    - ${l.slice(0, 150)}`));
    }

    const result = '\n' + lines.join('\n');
    _cache.context = result;
    _cache.ts = Date.now();
    return result;
  } catch (err) {
    // Supabase failed — try local substrate fallback
    try {
      const local = readCalibration();
      if (local && local.outcomes && local.outcomes.length > 0) {
        const outcomes = local.outcomes;
        const deltas = outcomes.filter((o: any) => o.delta_score != null).map((o: any) => parseFloat(o.delta_score));
        const avgDelta = deltas.length > 0
          ? Math.round((deltas.reduce((a: number, b: number) => a + b, 0) / deltas.length) * 100) / 100
          : null;
        const surpriseCount = outcomes.filter((o: any) => o.surprise_signal).length;
        const learnings = outcomes.filter((o: any) => o.learning).map((o: any) => o.learning).slice(0, 3);
        const lines: string[] = ['CALIBRATION CONTEXT (from local substrate):'];
        if (avgDelta !== null) lines.push(`  Avg delta score: ${avgDelta}`);
        lines.push(`  Outcomes: ${outcomes.length}, Surprises: ${surpriseCount}`);
        if (learnings.length > 0) {
          lines.push('  Top learnings:');
          learnings.forEach((l: string) => lines.push(`    - ${l.slice(0, 150)}`));
        }
        const result = '\n' + lines.join('\n');
        _cache.context = result;
        _cache.ts = Date.now();
        return result;
      }
    } catch { /* fallback failed too */ }
    return '';
  }
}

module.exports = {
  calibrateComplexity,
  getCalibrationContext,
};
