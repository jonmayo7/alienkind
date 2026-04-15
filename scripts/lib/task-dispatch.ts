/**
 * Task Dispatch — 3-stage decision before any working group fires.
 *
 * From MasRouter (ACL 2025): 52% cost reduction by making three decisions
 * BEFORE spinning up agents:
 *   1. Solo or collaborative? (Does this need multiple models/passes?)
 *   2. What roles? (What capabilities are needed?)
 *   3. Which substrate per role? (Route to the right model)
 *
 * We currently only do stage 3 (substrate-policy.ts). This adds 1-2.
 * Prevents over-engineering simple tasks and under-resourcing complex ones.
 *
 * Writers: working group scripts call dispatch() before doing work
 * Readers: the dispatch result determines how the task runs
 */

type DispatchMode = 'solo' | 'consult' | 'self-moa';

interface DispatchResult {
  /** Solo (one model), consult (multiple models), or self-moa (same model N times) */
  mode: DispatchMode;
  /** Which substrate handles it (solo) or synthesizes (consult/self-moa) */
  substrate: string;
  /** For consult: which substrates to query. For self-moa: how many samples */
  consultSubstrates?: string[];
  selfMoaSamples?: number;
  /** Reasoning for the dispatch decision */
  reason: string;
}

/**
 * Determine how a task should be executed based on its characteristics.
 *
 * Heuristic v1 — simple rules. Can be replaced with a trained classifier
 * once we have enough cascade_decisions data to learn from.
 */
function dispatch(task: string, context: {
  /** Which working group is asking */
  group: string;
  /** Is this external-facing (client product) or internal? */
  externalFacing: boolean;
  /** Estimated complexity: how many files/changes likely needed */
  estimatedScope: 'small' | 'medium' | 'large';
  /** Is this a judgment call or a deterministic task? */
  requiresJudgment: boolean;
}): DispatchResult {

  const { group, externalFacing, estimatedScope, requiresJudgment } = context;

  // Stage 1: Solo or collaborative?
  // Simple rule: small scope + no judgment = solo. Everything else = collaborative.
  if (estimatedScope === 'small' && !requiresJudgment) {
    // Stage 3: Which substrate?
    // Small deterministic tasks → cascade (35B handles most, escalates if needed)
    return {
      mode: 'solo',
      substrate: 'cascade',
      reason: 'Small scope, deterministic → solo cascade (35B first, escalate if uncertain)',
    };
  }

  // Stage 2: What kind of collaboration?
  if (requiresJudgment && externalFacing) {
    // High-stakes judgment on client-facing work → Self-MoA with best available
    // Run the same strong model 3x for diverse reasoning, then synthesize
    return {
      mode: 'self-moa',
      substrate: 'studio2-heavy',
      selfMoaSamples: 3,
      reason: 'External-facing judgment → Self-MoA 3x on 122B (quality over speed)',
    };
  }

  if (requiresJudgment && !externalFacing) {
    // Internal judgment (self-improvement, architecture decisions) → consult
    // Multiple perspectives from different substrates
    return {
      mode: 'consult',
      substrate: 'studio2-heavy',  // synthesizer
      consultSubstrates: ['studio2-daily', 'studio2-heavy'],
      reason: 'Internal judgment → consult (35B + 122B perspectives, 122B synthesizes)',
    };
  }

  if (estimatedScope === 'large') {
    // Large scope needs Opus for the planning, local for execution
    return {
      mode: 'solo',
      substrate: 'opus',
      reason: 'Large scope → Opus (frontier reasoning for complex multi-file changes)',
    };
  }

  // Medium scope, no special judgment → cascade
  return {
    mode: 'solo',
    substrate: 'cascade',
    reason: 'Medium scope → cascade (35B first, escalate if needed)',
  };
}

module.exports = { dispatch };
