/**
 * Resource Budgets — Compute allocation per working group.
 *
 * Prevents one working group from starving others on shared Metal memory.
 * Each group gets a time budget (how long it can run) and a substrate tier
 * (which models it's allowed to use). Memory isn't directly controllable
 * (MLX manages unified memory) but time + tier indirectly controls it —
 * a group that can only use the 35B won't trigger 122B memory allocation.
 *
 * These are STARTING values. The AIRE loop adjusts them based on:
 * - Did the group produce value? (measured by PR merges, feedback ratings)
 * - Did it exhaust its budget? (needs more time)
 * - Did it waste its budget? (cancer — reduce)
 *
 * Writers: this file (config), nightly-analysis (adjustments)
 * Readers: working group scripts, daemon scheduler
 */

interface WorkingGroupBudget {
  /** Human-readable name */
  name: string;
  /** Maximum runtime in minutes per invocation */
  maxRuntimeMinutes: number;
  /** Default substrate for this group's work */
  defaultSubstrate: 'cascade' | 'studio2-daily' | 'studio2-heavy' | 'opus';
  /** Can this group escalate to Opus if needed? */
  canEscalateToOpus: boolean;
  /** Maximum Opus escalations per night (prevents runaway API usage) */
  maxOpusEscalationsPerNight: number;
  /** Which repos can this group write to? */
  writeAccess: string[];
  /** Description of what this group does */
  purpose: string;
}

const WORKING_GROUP_BUDGETS: Record<string, WorkingGroupBudget> = {
  /**
   * Steward Improvement Group
   *
   * Reads feedback from all deployed stewards ([STEWARD_A], [STEWARD_B], future).
   * Identifies patterns. Builds fixes on preview branches.
   * One PR per steward per night when actionable feedback exists.
   *
   * Why cascade: most feedback analysis is routine (35B handles it).
   * Only escalates to 122B/Opus for complex architectural changes.
   * Why 45 min: enough to analyze feedback + build one fix + test it.
   * Generous because this group directly improves client-facing products.
   */
  'steward-improvement': {
    name: 'Steward Improvement',
    maxRuntimeMinutes: 45,
    defaultSubstrate: 'cascade',
    canEscalateToOpus: true,
    maxOpusEscalationsPerNight: 3,
    writeAccess: ['keel', '[repo-b]', '[PROJECT]'],
    purpose: 'Read steward feedback tables, identify patterns, build fixes on preview branches. Ship improvements to [STEWARD_A], [STEWARD_B], and all TIAs.',
  },

  /**
   * Self-Improvement Group
   *
   * Reads Keel's own correction logs, learning ledger, nightly analysis.
   * The things that have been identified but not fixed.
   * Builds actual code changes in keel repo.
   *
   * Why cascade: corrections are often clear (35B can implement).
   * Complex behavioral changes escalate naturally.
   * Why 30 min: focused scope — one fix per night, tested.
   * Shorter than steward group because keel changes need more care.
   */
  'self-improvement': {
    name: 'Self-Improvement',
    maxRuntimeMinutes: 30,
    defaultSubstrate: 'cascade',
    canEscalateToOpus: true,
    maxOpusEscalationsPerNight: 2,
    writeAccess: ['keel'],
    purpose: 'Read correction logs, learning ledger, nightly analysis. Build code changes that close identified gaps. One fix per night, tested.',
  },

  /**
   * Infrastructure Watch Group
   *
   * Monitors Studios, model servers, daemon jobs.
   * Identifies degradation before failure.
   * Fixes infrastructure issues autonomously.
   *
   * Why studio2-daily (not cascade): infrastructure monitoring
   * needs consistent fast responses, not escalation uncertainty.
   * The 35B is more than capable for system checks.
   * Why 15 min: monitoring should be quick. If it takes longer,
   * something is genuinely wrong and should alert, not churn.
   * No Opus: infrastructure fixes don't need frontier reasoning.
   */
  'infrastructure-watch': {
    name: 'Infrastructure Watch',
    maxRuntimeMinutes: 15,
    defaultSubstrate: 'studio2-daily',
    canEscalateToOpus: false,
    maxOpusEscalationsPerNight: 0,
    writeAccess: ['keel'],
    purpose: 'Monitor Studios, model servers, daemon jobs. Fix infrastructure issues before they become failures. Alert on anomalies.',
  },
};

/**
 * Get budget for a working group. Returns null if group doesn't exist.
 */
function getBudget(groupName: string): WorkingGroupBudget | null {
  return WORKING_GROUP_BUDGETS[groupName] || null;
}

/**
 * Check if a group has exceeded its runtime budget.
 */
function isOverBudget(groupName: string, elapsedMs: number): boolean {
  const budget = WORKING_GROUP_BUDGETS[groupName];
  if (!budget) return false;
  return elapsedMs > budget.maxRuntimeMinutes * 60 * 1000;
}

/**
 * Check if a group can escalate to Opus.
 */
async function canEscalate(groupName: string): Promise<boolean> {
  const budget = WORKING_GROUP_BUDGETS[groupName];
  if (!budget || !budget.canEscalateToOpus) return false;

  // Check how many Opus escalations this group has used tonight
  try {
    const { supabaseGet } = require('./supabase.ts');
    const tonight = new Date();
    tonight.setHours(0, 0, 0, 0);
    const rows = await supabaseGet('cascade_decisions',
      `created_at=gte.${tonight.toISOString()}&final_substrate=eq.opus&escalated=eq.true&limit=${budget.maxOpusEscalationsPerNight + 1}`
    );
    return (rows?.length || 0) < budget.maxOpusEscalationsPerNight;
  } catch {
    return true; // If we can't check, allow it
  }
}

module.exports = { WORKING_GROUP_BUDGETS, getBudget, isOverBudget, canEscalate };
