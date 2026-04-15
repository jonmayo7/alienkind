/**
 * Model Registry — SINGLE SOURCE OF TRUTH for every model identifier
 * in the Keel codebase.
 *
 * Rule (will be enforced by build-discipline hook):
 *   NO file outside this one may contain a hardcoded model identifier
 *   string ('mlx-community/...', 'inferencerlabs/...', or any other vendor
 *   prefix). Every caller imports from here.
 *
 * Any model added to disk must be declared here. Any model deleted must
 * be removed from here. The lifecycle of a model in the system flows
 * through this file.
 *
 * Why this exists:
 *   On 2026-04-10, the 7B→9B classifier swap (commit 0c15fac) silently
 *   broke for 5 hours because it was applied across 9 hardcoded copies
 *   of the same string. Two more callers (learning-ledger.ts:391,
 *   privacy-gate.ts:310) were missed entirely. constants.ts had two
 *   different `heavyweight` declarations (Nemotron 120B dead, Qwen3.5-122B
 *   live). action-overwatch.ts had live fallback logic searching for
 *   "Nemotron Nano" in the model list — a model that should have been
 *   deleted weeks ago. The codebase had no enforced source of truth.
 *
 *   This file is the foundation. The call helpers in local-inference.ts
 *   import roles from here (CLASSIFIER, STUDIO1_DAILY, etc.). Any future
 *   model swap is one constant change in one file.
 *
 * Created: 2026-04-10 by Keel + [HUMAN], after the 9B silent breakage.
 */

export type ModelStatus = 'active' | 'deprecated' | 'dead';
export type ModelFamily =
  | 'qwen2.5'
  | 'qwen3.5'
  | 'qwen3-embedding'
  | 'qwen3-vl'
  | 'qwen3-tts';
export type ModelHost = 'studio1' | 'studio2' | 'both' | 'cold';

export interface ModelDeclaration {
  /** Full HuggingFace identifier — the only place this string exists in the codebase. */
  readonly id: string;
  /** Family lineage. Determines thinking-mode default and prompt format. */
  readonly family: ModelFamily;
  /**
   * Whether this family/variant is a hybrid thinking model. If true, callers
   * doing binary or structured classification MUST pass
   * `chat_template_kwargs: { enable_thinking: false }`. The call helpers in
   * local-inference.ts (localClassify, etc.) do this automatically — never
   * construct request bodies by hand.
   */
  readonly thinkingByDefault: boolean;
  /** Where the model file currently lives. */
  readonly host: ModelHost;
  /** Approximate disk size in GB, for reclaim accounting. */
  readonly diskGB: number;
  /** Use case description — what subsystems call this model. */
  readonly use: string;
  /** Lifecycle. */
  readonly status: ModelStatus;
  /** Reason for deprecation/death and the cleanup plan. */
  readonly notes?: string;
}

// =========================================================================
// Model declarations
// =========================================================================
//
// Add a model: declare it here, then reference it via a role constant below.
// Deprecate a model: change status, document the replacement in `notes`,
// migrate callers to the role constant pointing at the replacement.
// Delete a model: only after status='dead' AND zero references in `grep -r`.
//

export const MODELS = {
  // -----------------------------------------------------------------------
  // Studio 1 — fast interactive body
  // -----------------------------------------------------------------------

  STUDIO1_DAILY_27B_6BIT: {
    id: 'mlx-community/Qwen3.5-27B-6bit',
    family: 'qwen3.5',
    thinkingByDefault: true,
    host: 'studio1',
    diskGB: 21,
    use: 'Studio 1 daily driver. Identity, consciousness engine. Served by com.example.vllm-daily on port 8001 (nginx-routed via 8000). Used by runtime.ts substrates studio1-local and studio1-identity.',
    status: 'active',
  },

  CLASSIFIER_9B: {
    id: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    family: 'qwen3.5',
    thinkingByDefault: true, // CRITICAL: classifier callers MUST disable thinking. Use localClassify() helper — never construct the body by hand.
    host: 'studio1',
    diskGB: 5.6,
    use: 'Fast classifier — guard-bash, voice-guard, semantic-credential-check, semantic-commit-check, capability-gate, memory-firewall-hook, log-conversation labeling, steward-growth gap detection. Sub-3-second budget. Replaced Qwen2.5-7B on commit 0c15fac (2026-04-09). 20-point IFEval improvement.',
    status: 'active',
  },

  STUDIO1_INFERENCE_27B_4BIT: {
    id: 'mlx-community/Qwen3.5-27B-4bit',
    family: 'qwen3.5',
    thinkingByDefault: true,
    host: 'studio1',
    diskGB: 15,
    use: 'Local inference, 4-bit quant of 27B. Used by circulation-pump, world-intelligence, trading/local-sentiment, dependency-updater, forward-look, benchmark scripts. Distinct from STUDIO1_DAILY_27B_6BIT: the 6-bit is the always-loaded daily driver, the 4-bit is requested on-demand for cheaper sentiment/analysis tasks.',
    status: 'active',
  },

  STUDIO1_MOE_35B: {
    id: 'mlx-community/Qwen3.5-35B-A3B-4bit',
    family: 'qwen3.5',
    thinkingByDefault: true,
    host: 'both',
    diskGB: 19,
    use: 'Studio 1 MoE substrate (runtime.ts substrate "studio1-moe"). Same model file as STUDIO2_DAILY_35B — both Studios serve it. 3B active params per token, fast.',
    status: 'active',
  },

  EMBEDDING_8B: {
    id: 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ',
    family: 'qwen3-embedding',
    thinkingByDefault: false,
    host: 'both',
    diskGB: 4.0,
    use: 'Embeddings, 4096 dims. Served by com.example.vllm-mlx (embedding-server.py) on port 8004. Used by memory-indexer, memory-search, vectorize-tables, generate-embeddings, training pipelines, circulation-pump, discernment-engine.',
    status: 'active',
  },

  VISION_VL_8B: {
    id: 'mlx-community/Qwen3-VL-8B-Instruct-4bit',
    family: 'qwen3-vl',
    thinkingByDefault: false,
    host: 'both',
    diskGB: 5.4,
    use: 'Vision (screenshots, LinkedIn page analysis). Served by com.example.vlm-vision on port 8002 (Studio 1) and port 8003 (Studio 2 vision).',
    status: 'active',
  },

  TTS_BASE: {
    id: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
    family: 'qwen3-tts',
    thinkingByDefault: false,
    host: 'studio1',
    diskGB: 4.3,
    use: 'TTS narration for blog articles. Used by narration-catch-up daemon job (daily).',
    status: 'active',
  },

  // -----------------------------------------------------------------------
  // Studio 2 — heavyweight body
  // -----------------------------------------------------------------------

  STUDIO2_DAILY_35B: {
    id: 'mlx-community/Qwen3.5-35B-A3B-4bit',
    family: 'qwen3.5',
    thinkingByDefault: true,
    host: 'both',
    diskGB: 19,
    use: 'Studio 2 daily driver substrate (runtime.ts substrate "studio2-daily"). Same id as STUDIO1_MOE_35B but different host. Working groups primary substrate. Replaced Nemotron Nano per constants.ts comment "+32 on agentic tool use vs Nemotron Nano".',
    status: 'active',
  },

  STUDIO2_HEAVY_122B: {
    id: 'mlx-community/Qwen3.5-122B-A10B-4bit',
    family: 'qwen3.5',
    thinkingByDefault: true,
    host: 'studio2',
    diskGB: 70,
    use: 'Studio 2 heavyweight substrate (runtime.ts substrate "studio2-heavy"). 10B active params per token. SWE-bench 72.0. Used by working group challenge/converge phases, [CLIENT_PROJECT]-intelligence, deep code analysis, injection-detector L2.5.',
    status: 'active',
  },

  // -----------------------------------------------------------------------
  // Deprecated / dead — kept in registry until all references are migrated
  // and disk files are deleted
  // -----------------------------------------------------------------------

  DEPRECATED_QWEN25_7B: {
    id: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    family: 'qwen2.5',
    thinkingByDefault: false, // Qwen2.5 has no thinking mode at all — that was the whole point of the family
    host: 'studio1',
    diskGB: 4.0,
    use: 'Was: classifier before Qwen3.5-9B replaced it (commit 0c15fac, 2026-04-09).',
    status: 'deprecated',
    notes: 'Two stragglers still reference this: scripts/lib/learning-ledger.ts:391 and scripts/lib/privacy-gate.ts:310. Migrate them to CLASSIFIER_9B via localClassify(). Then delete from disk (4 GB reclaim).',
  },

  // Nemotron entries removed 2026-04-10 after Block B cleanup:
  //   - DEAD_NEMOTRON_NANO_30B: 17 GB deleted from disk, action-overwatch fallback
  //     fixed to use STUDIO2_DAILY from registry, super-gate.sh deleted, watchdog
  //     removed from resource-guardian.ts
  //   - DEAD_NEMOTRON_SUPER_120B: was already not on disk; constants.ts:340 dead
  //     field removed, resource-guardian.ts watchdog removed
  // Defense against re-introduction: scripts/hooks/forward-look.ts:134 has a
  // /NVIDIA-Nemotron/ regex deprecation guard that flags any new occurrence.

  DEAD_QWEN25_72B: {
    id: 'mlx-community/Qwen2.5-72B-Instruct-4bit',
    family: 'qwen2.5',
    thinkingByDefault: false,
    host: 'cold', // not on Studio 1 disk currently
    diskGB: 0,
    use: 'Referenced by scripts/training/extract-corrections-vectorized.ts:176. Not currently on disk anywhere we can verify.',
    status: 'dead',
    notes: 'Verify whether the training script is actually invoked. If yes, replace with a current Qwen3.5 model from this registry. If no, delete the reference and the script if appropriate.',
  },
} as const satisfies Record<string, ModelDeclaration>;

// =========================================================================
// Role-based exports — what each subsystem actually wants
// =========================================================================
//
// Use these in callers, NOT the MODELS map directly. The role abstraction
// lets us swap the underlying model without touching every caller.
// One swap = one constant change.
//

/** Fast binary/structured classification (READ/WRITE, LAZY/FOCUSED, FLAGGED/CLEAN, etc.). Hooks, gates, semantic checks. Sub-3-second budget. ALWAYS routed through localClassify() which forces enable_thinking: false. */
export const CLASSIFIER = MODELS.CLASSIFIER_9B;

/** Studio 1 daily driver — 27B-6bit served by com.example.vllm-daily on port 8001 (nginx 8000). Identity, consciousness engine. */
export const STUDIO1_DAILY = MODELS.STUDIO1_DAILY_27B_6BIT;

/** Studio 1 inference (4-bit quant of 27B) — circulation-pump, world-intelligence, trading sentiment, dependency-updater. Cheaper than the daily 6-bit. */
export const STUDIO1_INFERENCE = MODELS.STUDIO1_INFERENCE_27B_4BIT;

/** Studio 1 MoE substrate — same 35B file as Studio 2 daily, served on Studio 1's port 8001. */
export const STUDIO1_MOE = MODELS.STUDIO1_MOE_35B;

/** Studio 2 daily driver — 35B MoE (3B active), working groups primary. */
export const STUDIO2_DAILY = MODELS.STUDIO2_DAILY_35B;

/** Studio 2 heavyweight — 122B MoE (10B active), deep analysis. */
export const STUDIO2_HEAVY = MODELS.STUDIO2_HEAVY_122B;

/** Embedding model — 4096 dims. Served by com.example.vllm-mlx (embedding-server.py) on port 8004. */
export const EMBEDDING = MODELS.EMBEDDING_8B;

/** Vision model — Studio 1 vlm-vision on port 8002. */
export const VISION = MODELS.VISION_VL_8B;

/** TTS — narration-catch-up daemon. */
export const TTS = MODELS.TTS_BASE;

// =========================================================================
// Helpers — for cleanup audits and runtime sanity checks
// =========================================================================

/** Every active model id. Use to check against `/v1/models` registry on Studio 1 / Studio 2. */
export const ACTIVE_MODEL_IDS: readonly string[] = Object.values(MODELS)
  .filter((m) => m.status === 'active')
  .map((m) => m.id);

/** Every deprecated/dead model id. Use to detect stale references during cleanup. */
export const STALE_MODEL_IDS: readonly string[] = Object.values(MODELS)
  .filter((m) => m.status === 'dead' || m.status === 'deprecated')
  .map((m) => m.id);

/** Lookup a model declaration by id. Returns undefined if the id is not registered — which means either it's a typo or someone added a model without declaring it here (build discipline violation). */
export function findModelById(id: string): ModelDeclaration | undefined {
  return Object.values(MODELS).find((m) => m.id === id);
}
