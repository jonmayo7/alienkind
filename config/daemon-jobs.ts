/**
 * Daemon Job Definitions — all scheduled jobs in one place.
 *
 * Phase 1: runner 'node' — jobs fork existing scripts as child processes.
 * Phase 1b: runner 'claude' — jobs call invokeClaude with --resume.
 *
 * Each job defines:
 *   - name: unique identifier
 *   - schedule: { hour, minute } for cron or { intervalMs } for interval
 *   - runner: 'node' (fork script) or 'claude' (future: direct invocation)
 *   - script: path to existing script (relative to repo root)
 *   - args: optional arguments to pass to the script
 *   - quietHours: optional { start, end } to skip during those hours
 *   - runOnMiss: whether to run if missed on startup (default true)
 *   - expectsOutput: if true, daemon warns when job exits 0 with zero stdout (silent success trap)
 *   - mode: 'analyst' | 'operator' | 'builder' — Containment Fields session mode.
 *       analyst: full access, comms via queues (identity-sync, analysis, incorporation, interactive)
 *       operator: external send capability, no identity/state writes (listeners, heartbeat, briefs)
 *       builder: code + domain files only, no external messaging, no personal data (CI/CD, tests, sync)
 *   - description: human-readable description
 *
 * CUSTOMIZE: Add your own jobs below. The daemon reads this array at startup
 * and schedules each job according to its cron or interval definition.
 */

// Containment Fields mode assignments — determines ALIENKIND_SESSION_MODE env var.
// Default: 'operator' (principle of least privilege). Jobs that need full access
// must be explicitly listed as 'analyst'. Jobs that only touch code/data: 'builder'.
const MODE_OVERRIDES: Record<string, 'analyst' | 'operator' | 'builder'> = {
  // Analyst: full identity access, external comms via queues only
  'nightly-analysis': 'analyst',

  // Builder: code + domain files, no external messaging, no personal data
  'resource-guardian': 'builder',
  'circulation-pump': 'builder',
  'auto-commit': 'builder',

  // Operator: can interact externally, can't write identity
  // Everything else defaults to 'operator' (can send, can't write identity)
};

// Resource requirements per job — used by the concurrent job queue.
// Jobs not listed here have no resource constraints and run freely.
// Resources: studio1 (Metal GPU), studio2 (Metal GPU), browser (headless Chrome)
const RESOURCE_REQUIREMENTS: Record<string, string[]> = {
  // Working groups use local inference hardware
  'working-group-steward': ['studio2'],
  'working-group-self-improvement': ['studio2'],
  'working-group-infra-watch': ['studio2'],

  // Everything else: no resource constraint — runs freely
};

function getJobMode(jobName: string): 'analyst' | 'operator' | 'builder' {
  return MODE_OVERRIDES[jobName] || 'operator';
}

const JOBS = [
  // ─── High-Frequency Infrastructure ────────────────────────────────────
  {
    name: 'operational-pulse',
    schedule: { intervalMs: 1800000 },  // every 30 minutes
    runner: 'node',
    script: 'scripts/operational-pulse.ts',
    args: [],
    quietHours: { start: 23, end: 4 },
    runOnMiss: false,
    useSession: false,
    description: 'Pure Node pulse — service health, meeting detection, urgent flags, regression tests. No LLM invocation. Cheap and fast.',
  },
  {
    name: 'auto-commit',
    schedule: { intervalMs: 900000 },  // every 15 minutes
    runner: 'node',
    script: 'scripts/auto-commit.ts',
    args: [],
    runOnMiss: false,
    quietHours: { start: 22, end: 1 },  // avoid nightly cycle window — git collision risk
    description: 'Stage safe paths (memory, logs, config), commit, push. Quiet during nightly cycle to avoid git collision.',
  },
  {
    name: 'circulation-pump',
    schedule: { intervalMs: 600000 },  // every 10 minutes
    runner: 'node',
    script: 'scripts/circulation-pump.ts',
    args: [],
    runOnMiss: false,
    useSession: false,
    description: 'Circulation pump — the organism\'s heart. Reads circulation table, detects cross-organ reinforcement, routes actionable findings (T1 auto-fix, T2 inform, T3 surface to human), prunes expired entries. Stigmergic coordination layer.',
  },
  {
    name: 'self-heal',
    schedule: { intervalMs: 300000 },  // every 5 minutes
    runner: 'node',
    script: 'scripts/self-heal.ts',
    args: [],
    runOnMiss: false,
    useSession: false,
    description: 'Self-heal monitor — detects failed daemon jobs, diagnoses root cause from error logs, attempts automated fix. Reports FIXED (auto-commit), PROPOSE (intent for later), or FAILED (needs manual intervention).',
  },
  {
    name: 'resource-guardian',
    schedule: { intervalMs: 180000 },  // every 3 minutes
    runner: 'node',
    script: 'scripts/resource-guardian.ts',
    args: [],
    runOnMiss: false,
    useSession: false,
    description: 'Resource guardian — monitors memory pressure, process counts, disk space, swap usage. Kills stale processes at critical thresholds. Prevents resource exhaustion. 24/7, no quiet hours. Pure Node, zero LLM cost.',
  },

  // ─── Nightly Evolution Pipeline ───────────────────────────────────────
  {
    name: 'nightly-immune',
    schedule: { hour: 22, minute: 30 },
    runner: 'node',
    script: 'scripts/nightly-cycle.ts',
    args: ['--job', 'immune'],
    runOnMiss: true,
    useSession: true,
    sessionChannel: 'daemon_nightly',  // shared across all sequential nightly phases
    expectsOutput: true,
    description: 'Nightly immune phase — security scans, infrastructure checks, backup verification, log cleanup. First phase of the nightly pipeline.',
  },
  {
    name: 'nightly-analysis',
    schedule: { hour: 23, minute: 0 },
    runner: 'node',
    script: 'scripts/nightly-cycle.ts',
    args: ['--job', 'analysis'],
    runOnMiss: true,
    useSession: true,
    sessionChannel: 'daemon_nightly',
    expectsOutput: true,
    description: 'Growth reflection + evolution analysis. Reads immune output, today\'s daily file, correction patterns. Identifies what improved, what regressed, and what to focus on next. The organism\'s self-assessment.',
  },

  // ─── Autonomous Cycles ────────────────────────────────────────────────
  // Forkers wire their own autonomous operator here. The script referenced
  // below is partner-specific (it embodies the partner's judgment about
  // what work to pick up on each wake). AlienKind ships the pattern — the
  // cron shape, the session channel, the quiet-hours policy — but not the
  // operator's decision logic itself.
];

module.exports = { JOBS, getJobMode, MODE_OVERRIDES, RESOURCE_REQUIREMENTS };
