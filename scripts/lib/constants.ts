// @alienkind-core
/**
 * Constants — centralized configuration defaults for AlienKind.
 *
 * Every configurable threshold in one place. Scripts import from here instead
 * of hardcoding magic numbers. Change once, applies everywhere.
 *
 * Forkers: most values here are sensible defaults. Override by setting env
 * vars, editing partner-config.json, or forking this file for project-specific
 * deployments.
 *
 * Grouped by domain. Comments explain what each value controls.
 */

// --- Timezone ---
// Falls back to UTC if TZ env var isn't set. Scripts use this for human-facing
// date/time formatting. Internal storage (Supabase, API calls) stays UTC.
const TIMEZONE = process.env.TZ || 'UTC';

// --- Type Definitions ---

interface ComplexityLevel {
  maxTurns: number;
  timeout: number;
  noOutputTimeout: number;
}

interface NightlyJobConfig {
  maxTurns: number;
  overallTimeout: number;
  noOutputTimeout: number;
}

interface ReaperTarget {
  dir: string;
  maxAgeDays: number;
  pattern: string;
}

// --- Message Complexity ---
// Used by listeners to determine turns/timeout for spawned sessions.
// All levels default to 'heavy' — tune down for faster response on simple tasks.

const COMPLEXITY: Record<string, ComplexityLevel> = {
  heavy: { maxTurns: 200, timeout: 2400000, noOutputTimeout: 1800000 },
};

// --- Heartbeat / Scheduled Task Defaults ---

const HEARTBEAT = {
  maxTurns: { morning: 200, pulse: 200 },
  overallTimeout: 1200000,           // 20 minutes
  quietHoursStart: 23,                // 11 PM — skip heartbeat
  quietHoursEnd: 4,                   // 4 AM — skip heartbeat
  morningHour: 4,                     // 4 AM — morning heartbeat
  calendarWindowStart: 45,            // min ahead — pre-call brief window start
  calendarWindowEnd: 90,              // min ahead — pre-call brief window end
  pulseLightTurns: 3,
  timeoutPerTurn: 30000,
  regressionHours: [4, 10, 16, 22],   // run regression tests at these hours
} as const;

const NIGHTLY = {
  maxTurns: 200,
  overallTimeout: 1800000,           // 30 minutes
  noOutputTimeout: 1200000,          // 20 minutes
  maxBackups: 14,
  incrementalDays: 7,
  exportBufferSize: 50 * 1024 * 1024,
  emptyExportThreshold: 3,
  immune: { maxTurns: 200, overallTimeout: 1200000, noOutputTimeout: 900000 } as NightlyJobConfig,
  analysis: { maxTurns: 200, overallTimeout: 3000000, noOutputTimeout: 3000000 } as NightlyJobConfig,
  identitySync: { maxTurns: 200, overallTimeout: 3000000, noOutputTimeout: 3000000 } as NightlyJobConfig,
  weekly: { maxTurns: 200, overallTimeout: 3000000, noOutputTimeout: 3000000 } as NightlyJobConfig,
};

// --- Conversation Context ---

const CONTEXT = {
  terminalLimit: 15,
  dmLimit: 25,
  communityLimit: 8,
  heartbeatLimit: 10,
  previewLength: 200,
  queryTimeout: 5000,
} as const;

// --- Platform Limits ---

const PLATFORM = {
  telegram: {
    messageLimit: 4096,
    responseLimit: 6000,
    longPollTimeout: 30,
    apiTimeout: 35000,
    otherApiTimeout: 10000,
  },
  discord: {
    messageLimit: 2000,
    responseLimit: 1800,
  },
} as const;

// --- Retry & Delivery ---

const DELIVERY = {
  maxAttempts: 3,
  baseDelays: [1000, 5000, 15000],
  jitter: 0.1,
  queueTimeBudget: 60000,
  requestTimeout: 15000,
} as const;

// --- Reconnection Backoff ---

const RECONNECT = {
  backoffSchedule: [5000, 15000, 30000, 60000, 300000],
  alertAfterErrors: 5,
} as const;

// --- Message Debounce ---

const DEBOUNCE = {
  waitMs: 2000,
  pollTimeout: 1,
} as const;

// --- Process Supervision ---

const PROCESS = {
  killGracePeriod: 3000,
  defaultNoOutputTimeout: 600000,
} as const;

// --- Shutdown ---

const SHUTDOWN = {
  gracePeriod: 2000,
} as const;

// --- Reaper (file cleanup) ---

const REAPER = {
  targets: [
    { dir: 'logs', maxAgeDays: 7, pattern: '*.log' },
    { dir: '/tmp', maxAgeDays: 1, pattern: 'partner-memory-checkpoint-*' },
  ] as ReaperTarget[],
};

// --- Security (rate limiting) ---

const SECURITY = {
  communityRateLimit: 10000,
  maxCommunityInputLength: 2000,
} as const;

// --- Auto-commit ---

const AUTOCOMMIT = {
  pushFailureAlertThreshold: 3,
  buildLockMaxAgeMs: 600000,
  safePaths: [
    'memory/', 'identity/', 'config/', 'scripts/',
    'CLAUDE.md', 'README.md', '.gitignore', 'package.json', 'package-lock.json',
  ],
};

// --- Calibration ---

const CALIBRATION = {
  lookbackDays: 7,
  autoResumeThreshold: 2,
  cacheTtlMs: 300000,
} as const;

// --- Models ---
// Forkers: set to whatever you use. Defaults reflect a Claude Code + Anthropic
// Max plan setup as the primary path. Change to your provider of choice.

const MODELS = {
  primary: process.env.PARTNER_MODEL_PRIMARY || 'claude-opus-4-7',
  community: process.env.PARTNER_MODEL_COMMUNITY || 'claude-sonnet-4-6',
  automated: process.env.PARTNER_MODEL_AUTOMATED || 'claude-sonnet-4-6',
  reasoning: process.env.PARTNER_MODEL_REASONING || 'claude-opus-4-7',
} as const;

// --- Emergency Tier (gateway fallback) ---
// See scripts/lib/gateway.ts for the stub implementation.
// Model identifiers are provider-prefixed strings (e.g., "<provider>/<model>").
// Set your own via env. These defaults are illustrative — override for real use.

const EMERGENCY = {
  gatewayUrl: process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1',
  envKey: 'AI_GATEWAY_API_KEY',
  primary: process.env.AI_GATEWAY_PRIMARY_MODEL || '<provider>/<primary-model>',
  secondary: process.env.AI_GATEWAY_SECONDARY_MODEL || '<provider>/<secondary-model>',
  fallback: process.env.AI_GATEWAY_FALLBACK_MODEL || '<provider>/<fallback-model>',
  requestTimeout: 120000,
  maxRetries: 2,
  retryDelay: 3000,
  maxTurns: 30,
  downPatterns: [
    'service unavailable', 'internal server error',
    '503', '502', 'bad gateway', 'gateway timeout', '504',
    'connection refused', 'econnrefused', 'etimedout', 'enotfound',
  ],
} as const;

// --- Paths ---
// Tool paths — override via env if your setup differs.

const PATHS = {
  claude: process.env.CLAUDE_BIN || 'claude',
  ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
} as const;

// --- Failover ---
// How the runtime decides when to fall over to alternate substrates.

const FAILOVER = {
  rateLimitBackoffMs: 60000,
  maxConsecutiveFailures: 3,
  cooldownMs: 300000,
} as const;

// --- Daemon ---
// Scheduler + job queue defaults for the opt-in autonomous daemon.

const DAEMON = {
  tickIntervalMs: 30000,
  healthIntervalMs: 60000,
  maxConsecutiveFailures: 5,
  jobTimeouts: {
    default: 900000,
  } as Record<string, number>,
} as const;

// --- Self-Heal ---

const SELF_HEAL = {
  cooldownMs: 900000,
  lockFile: 'logs/self-heal.lock',
  lockMaxAgeMs: 1800000,
  maxDiffLines: 100,
  maxDiagnosticTurns: 30,
  noOutputTimeout: 300000,
  logTailLines: 200,
} as const;

// --- Session Management ---

const SESSION = {
  expiryMs: 1800000,
  compactionMarkers: [
    'this session is being continued from a previous conversation',
    'ran out of context',
    'autocompact',
  ],
} as const;

// --- Local Models ---
// Reference endpoints for locally-hosted inference (classifier, embedding).
// The classifier is used by action-evaluator and hooks for sub-3s semantic
// judgments. Forkers without a local server can leave this pointed at
// localhost:8000 — callers degrade gracefully when the endpoint is absent.

const LOCAL_MODELS = {
  /** Endpoint host for the OpenAI-compatible local classifier (vLLM-MLX, Ollama, etc.) */
  host: process.env.LOCAL_MODELS_HOST || 'http://127.0.0.1:8000',
  /** Model name for fast classifier — hooks, gates, semantic checks. */
  classifier: process.env.LOCAL_CLASSIFIER_MODEL || 'mlx-community/Qwen3.5-9B-MLX-4bit',
  /** Embedding model name — memory search, vectorization. */
  embedding: process.env.LOCAL_EMBEDDING_MODEL || 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ',
  /** Embedding dimension — must match database vector column. */
  embeddingDims: 4096,
} as const;

// --- Intent Queue ---
// Controls the two-tier intent lifecycle (partner-approved auto-execute vs
// human-required approval). Tuning these changes how often the partner
// surfaces decisions for the human vs acts autonomously.

const INTENTS = {
  defaultExpiry: 24 * 60 * 60 * 1000,     // 24h — non-urgent intents expire
  urgentExpiry: 4 * 60 * 60 * 1000,       // 4h — urgent intents expire faster
  maxPendingPerSource: 5,                  // prevent runaway intent creation
  telegramSummaryMaxChars: 2000,           // keep notification scannable
  approvalKeywords: ['approve', 'approved', 'do it', 'go', 'ship it', 'yes', 'go ahead', 'execute', 'send it', 'run it', 'sounds great', 'sounds good', 'go for it'],
  rejectionKeywords: ['reject', 'rejected', 'no', 'deny', 'denied', 'cancel', 'stop', 'hold', 'hold off', 'not yet', 'wait'],
} as const;

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  TIMEZONE,
  COMPLEXITY,
  HEARTBEAT,
  NIGHTLY,
  CONTEXT,
  PLATFORM,
  DELIVERY,
  RECONNECT,
  DEBOUNCE,
  PROCESS,
  SHUTDOWN,
  REAPER,
  SECURITY,
  AUTOCOMMIT,
  CALIBRATION,
  MODELS,
  EMERGENCY,
  PATHS,
  FAILOVER,
  DAEMON,
  SELF_HEAL,
  SESSION,
  INTENTS,
  LOCAL_MODELS,
};
