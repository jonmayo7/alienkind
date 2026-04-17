#!/usr/bin/env node
const { TIMEZONE, DAEMON, SESSION, SELF_HEAL } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Keel Daemon — Persistent Core (Phase 1)
 *
 * Single Node.js process that replaces all scheduled launchd services.
 * Runs scheduled jobs, nightly cycle, and auto-commit
 * through a unified scheduler with sequential job execution.
 *
 * Phase 1: Jobs fork existing scripts as child processes (runner: 'node').
 *          Zero behavioral change. Existing retry logic preserved.
 * Phase 1b: Daemon passes session env vars to forked scripts. Scripts
 *           use --session-id/--resume instead of -p. Context accumulates.
 *
 * Managed by: launchd (com.example.daemon.plist)
 *
 * Usage:
 *   node scripts/daemon.js           # normal operation
 *   node scripts/daemon.js --once    # run one tick and exit (testing)
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// --- Load dependencies ---
const { createLogger } = require('./lib/shared.ts');
const { getNowCT } = require('./lib/env.ts');
const { acquireLock } = require('./lib/lockfile.ts');
const { createScheduler } = require('./lib/scheduler.ts');
const { createSessionManager, readSessionState } = require('./lib/session-manager.ts');
const { acquireSessionLock, releaseSessionLock } = require('./lib/session-lock.ts');
const { getChannelSession, recordSessionMessage } = require('./lib/channel-sessions.ts');
const { createJobQueue } = require('./lib/job-queue.ts');
const { updateFocus } = require('./lib/mycelium.ts');
const { createIntent, formatForTelegram, getPendingIntents, expireStaleIntents } = require('./lib/intents.ts');
const { readFailoverState, writeFailoverState, activateFailover, getActiveConfigDir } = require('./lib/shared.ts');
// usage-monitor polling removed Apr 9 — OTEL collector is primary data source
const resourceMonitor = require('./lib/resource-monitor.ts');
const { JOBS, RESOURCE_REQUIREMENTS } = require('../config/daemon-jobs.ts');
const { createEventBus } = require('./lib/event-bus.ts');

// Jobs that warrant self-healing intents on failure.
// Exclude action-router (30s interval, self-recovers) and auto-commit (low-stakes).
const SELF_HEALING_JOBS = new Set(['operational-pulse', 'nightly-immune', 'nightly-analysis', 'nightly-identity-sync', 'nightly-weekly']);

// --- Error deduplication ---
// Prevents 5+ duplicate alerts and self-heal investigations for the same root cause.
// Keyed by error fingerprint (first 100 chars normalized), value = { ts, jobs, alerted }.
const recentErrorFingerprints = new Map<string, { ts: number; jobs: string[]; alerted: boolean }>();
const ERROR_DEDUP_WINDOW_MS = 300000; // 5 minutes

// --- Job failure alert suppression ---
// Tracks which jobs have already sent a consecutive-failure (5x) Telegram alert
// since this daemon process started. Cleared per-job when the job succeeds,
// so the NEXT failure cycle will alert again. Prevents repeat "failed 5x" noise.
const jobFailureAlerted = new Set<string>();

function getErrorFingerprint(errMsg: string): string {
  return errMsg.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function isDuplicateError(name: string, errMsg: string): { isDup: boolean; fingerprint: string; affectedJobs: string[] } {
  const fp = getErrorFingerprint(errMsg);
  const now = Date.now();

  // Expire old entries
  for (const [key, val] of recentErrorFingerprints) {
    if (now - val.ts > ERROR_DEDUP_WINDOW_MS) recentErrorFingerprints.delete(key);
  }

  const existing = recentErrorFingerprints.get(fp);
  if (existing && now - existing.ts < ERROR_DEDUP_WINDOW_MS) {
    if (!existing.jobs.includes(name)) existing.jobs.push(name);
    return { isDup: true, fingerprint: fp, affectedJobs: existing.jobs };
  }

  recentErrorFingerprints.set(fp, { ts: now, jobs: [name], alerted: false });
  return { isDup: false, fingerprint: fp, affectedJobs: [name] };
}

// --- Logger ---
const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const LOG_FILE = path.join(LOG_DIR, `daemon-${DATE}.log`);
const { log } = createLogger(LOG_FILE);

// --- Gateway lock ---
const lockLog = (msg) => log('INFO', msg);
acquireLock('daemon', { log: lockLog });

// --- Alerting via single source of truth ---
const { formatJobFailure, formatWatchdog, formatWatchdogStorm } = require('./lib/alert-format.ts');
const { alertOperator: _daemonAlert } = require('./lib/alert-dispatcher.ts');

// sendAlert wrapper for backward compat with all 15+ call sites in this file.
// Routes through alertOperator — one delivery path, one truth.
const sendAlert = (text: string) => {
  _daemonAlert({ severity: 'heads-up', source: 'daemon', summary: text.slice(0, 200), detail: text.length > 200 ? text : undefined, cooldownMs: 0 });
};

// Populate process.env for downstream modules
try {
  const { loadEnv } = require('./lib/shared.ts');
  const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
  for (const [k, v] of Object.entries(env) as [string, string][]) {
    if (!process.env[k]) process.env[k] = v;
  }
} catch (err) {
  log('WARN', `Env loading failed: ${err.message}`);
}

// --- Initialize components ---
const sessions = createSessionManager({ log: (level, msg) => log(level, msg), stateFile: 'logs/daemon-sessions.json' });
// Context cache removed (Finding #20): created but .get() never called. Dead code with active file watchers.
// Restore when Phase 2 needs it — wire into prompt building before re-enabling.
const queue = createJobQueue({ log: (level, msg) => log(level, msg) });

// --- Health monitor ---
const HEALTH_FILE = path.join(LOG_DIR, 'daemon-health.json');
let healthTimer = null;

function writeHealth() {
  // Build listener health snapshot
  const listeners = {};
  for (const l of WATCHED_LISTENERS) {
    let pid = null, alive = false;
    try {
      if (fs.existsSync(l.lockFile)) {
        const raw = fs.readFileSync(l.lockFile, 'utf-8').trim();
        try { pid = JSON.parse(raw).pid; } catch { pid = parseInt(raw, 10); }
        if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      }
    } catch { /* ok */ }
    listeners[l.name] = { pid, alive, alerted: !!listenerAlerted[l.name] };
  }

  const health = {
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    session: sessions.getHealth(),
    queue: queue.status || {
      depth: queue.depth,
      currentJob: queue.currentJob,
    },
    scheduler: scheduler.getStatus(),
    listeners,
  };
  try {
    const tmpFile = HEALTH_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(health, null, 2));
    fs.renameSync(tmpFile, HEALTH_FILE);
  } catch (err) {
    log('WARN', `Health write failed: ${err.message}`);
  }
}

// --- Listener watchdog ---
// Checks if Telegram and Discord listeners are alive every health tick.
// Reads their lock files for PIDs, checks liveness, alerts + restarts if dead.
const { execSync } = require('child_process');

const WATCHED_LISTENERS = [
  { name: 'telegram-listener', label: 'com.example.telegram-listener', lockFile: path.join(LOG_DIR, 'telegram-bot.lock') },
  { name: 'discord-listener', label: 'com.example.discord-listener', lockFile: path.join(LOG_DIR, 'discord-engine.lock') },
];

// Track consecutive dead checks to avoid alert spam (only alert once per outage)
const listenerAlerted = {};

// --- Listener restart frequency monitoring (Intent #173) ---
const RESTART_HISTORY_FILE = path.join(LOG_DIR, 'listener-restarts.json');
const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const RESTART_ESCALATION_THRESHOLD = 2; // >2 restarts in 24h = warning

function loadRestartHistory(): Record<string, number[]> {
  try {
    if (fs.existsSync(RESTART_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESTART_HISTORY_FILE, 'utf-8'));
      const cutoff = Date.now() - RESTART_WINDOW_MS;
      for (const name of Object.keys(data)) {
        data[name] = (data[name] || []).filter((ts: number) => ts > cutoff);
      }
      return data;
    }
  } catch { /* corrupt file, start fresh */ }
  return {};
}

function recordRestart(listenerName: string) {
  const history = loadRestartHistory();
  if (!history[listenerName]) history[listenerName] = [];
  history[listenerName].push(Date.now());

  try {
    fs.writeFileSync(RESTART_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    log('WARN', `Failed to write restart history: ${err.message}`);
  }

  const count = history[listenerName].length;
  if (count > RESTART_ESCALATION_THRESHOLD) {
    log('WARN', `[watchdog] ${listenerName}: ${count} restarts in 24h — escalating from info to warning`);
    // Rate-limit alerts: only send at thresholds 3, 5, 10, 25, 50, 100 (not every restart)
    const alertThresholds = [3, 5, 10, 25, 50, 100];
    if (sendAlert && alertThresholds.includes(count)) {
      sendAlert(`⚠️ ${listenerName}: ${count} restarts in 24h (threshold: ${RESTART_ESCALATION_THRESHOLD}). Investigating stability.`);
    }
  } else {
    log('INFO', `[watchdog] ${listenerName}: restart recorded (${count} in 24h window)`);
  }
}

// --- Restart storm detection (Intent #203) ---
// During restart storms (rapid listener cycling), individual restarting/recovered
// alert pairs flood the channel. This batches them into one summary per storm.
const STORM_WINDOW_MS = 5 * 60 * 1000; // 5 min — restarts within this window = same storm
const STORM_MIN_RESTARTS = 3; // 3+ restarts in window = storm mode
const STORM_QUIET_TICKS = 2; // 2 consecutive alive ticks (2 min) = storm over
const STORM_MARKER_FILE = path.join(LOG_DIR, 'restart-storm.json');

interface StormState {
  restartTimestamps: number[];
  aliveTicks: number;
  inStorm: boolean;
}

const stormStates: Record<string, StormState> = {};

function getStormState(name: string): StormState {
  if (!stormStates[name]) {
    stormStates[name] = { restartTimestamps: [], aliveTicks: 0, inStorm: false };
  }
  const cutoff = Date.now() - STORM_WINDOW_MS;
  stormStates[name].restartTimestamps = stormStates[name].restartTimestamps.filter(t => t > cutoff);
  return stormStates[name];
}

function writeStormMarker(): void {
  const activeStorms = Object.entries(stormStates).filter(([, s]) => s.inStorm).map(([n]) => n);
  if (activeStorms.length > 0) {
    try {
      fs.writeFileSync(STORM_MARKER_FILE, JSON.stringify({ active: true, services: activeStorms, since: new Date().toISOString() }));
    } catch { /* best effort */ }
  } else {
    try { fs.unlinkSync(STORM_MARKER_FILE); } catch { /* ok */ }
  }
}

function flushStormSummary(name: string, state: StormState): void {
  const count = state.restartTimestamps.length;
  if (count === 0) return;

  const first = Math.min(...state.restartTimestamps);
  const last = Math.max(...state.restartTimestamps);
  const durationMin = Math.max(1, Math.round((last - first) / 60000));
  const fmt = (ts: number) => getNowCT(new Date(ts));
  const timeRange = `${fmt(first)} to ${fmt(last)}`;

  if (sendAlert) sendAlert(formatWatchdogStorm(name, count, durationMin, timeRange));
  log('INFO', `[watchdog] Storm summary for ${name}: ${count} restarts in ${durationMin}m, now stable`);
}

function checkListenerHealth() {
  for (const listener of WATCHED_LISTENERS) {
    try {
      // Read PID from lock file
      if (!fs.existsSync(listener.lockFile)) {
        // No lock file = not running and never started, or crashed hard
        const storm = getStormState(listener.name);
        storm.restartTimestamps.push(Date.now());
        storm.aliveTicks = 0;

        if (!storm.inStorm && storm.restartTimestamps.length >= STORM_MIN_RESTARTS) {
          storm.inStorm = true;
          log('WARN', `[watchdog] ${listener.name}: restart storm detected (${storm.restartTimestamps.length} restarts) — batching alerts`);
          writeStormMarker();
        }

        if (!storm.inStorm && !listenerAlerted[listener.name]) {
          log('WARN', `[watchdog] ${listener.name}: no lock file — not running`);
          if (sendAlert) sendAlert(formatWatchdog(listener.name, 'down'));
          listenerAlerted[listener.name] = true;
        } else if (storm.inStorm) {
          log('INFO', `[watchdog] ${listener.name}: restart #${storm.restartTimestamps.length} (storm mode — alert suppressed)`);
        }

        try {
          execSync(`launchctl start ${listener.label}`, { timeout: 5000 });
          log('INFO', `[watchdog] ${listener.name}: restart issued via launchctl`);
          recordRestart(listener.name);
        } catch (e) {
          log('WARN', `[watchdog] ${listener.name}: launchctl start failed: ${e.message}`);
        }
        continue;
      }

      const lockContent = fs.readFileSync(listener.lockFile, 'utf-8').trim();
      let pid;
      try { pid = JSON.parse(lockContent).pid; } catch { pid = parseInt(lockContent, 10); }
      if (!pid || isNaN(pid)) {
        log('WARN', `[watchdog] ${listener.name}: corrupt lock file`);
        continue;
      }

      // Check if PID is alive
      try {
        process.kill(pid, 0); // signal 0 = liveness check, no actual signal sent
        // Alive
        const storm = getStormState(listener.name);
        storm.aliveTicks++;

        if (storm.inStorm && storm.aliveTicks >= STORM_QUIET_TICKS) {
          // Storm over — flush one summary instead of N individual alerts
          flushStormSummary(listener.name, storm);
          storm.inStorm = false;
          storm.restartTimestamps = [];
          storm.aliveTicks = 0;
          listenerAlerted[listener.name] = false;
          writeStormMarker();
        } else if (!storm.inStorm && listenerAlerted[listener.name]) {
          log('INFO', `[watchdog] ${listener.name}: recovered (pid=${pid})`);
          if (sendAlert) sendAlert(formatWatchdog(listener.name, 'recovered'));
          listenerAlerted[listener.name] = false;
        }
      } catch (e) {
        // PID is dead
        const storm = getStormState(listener.name);
        storm.restartTimestamps.push(Date.now());
        storm.aliveTicks = 0;

        if (!storm.inStorm && storm.restartTimestamps.length >= STORM_MIN_RESTARTS) {
          storm.inStorm = true;
          log('WARN', `[watchdog] ${listener.name}: restart storm detected (${storm.restartTimestamps.length} restarts) — batching alerts`);
          writeStormMarker();
        }

        if (!storm.inStorm && !listenerAlerted[listener.name]) {
          log('WARN', `[watchdog] ${listener.name}: dead (stale pid=${pid}). Restarting.`);
          if (sendAlert) sendAlert(formatWatchdog(listener.name, 'restarting'));
          listenerAlerted[listener.name] = true;
        } else if (storm.inStorm) {
          log('INFO', `[watchdog] ${listener.name}: restart #${storm.restartTimestamps.length} (storm mode — alert suppressed)`);
        }

        // Clean stale lock and restart (always, regardless of storm)
        try { fs.unlinkSync(listener.lockFile); } catch { /* ok */ }
        try {
          execSync(`launchctl start ${listener.label}`, { timeout: 5000 });
          log('INFO', `[watchdog] ${listener.name}: restart issued via launchctl`);
          recordRestart(listener.name);
        } catch (e2) {
          log('WARN', `[watchdog] ${listener.name}: launchctl start failed: ${e2.message}`);
        }
      }
    } catch (err) {
      log('WARN', `[watchdog] ${listener.name} check failed: ${err.message}`);
    }
  }
}

// --- Job runner (Phase 1: fork existing scripts) ---
async function runNodeJob(jobDef, opts?: { recoveryContext?: 'missed' | 'retry' | null }) {
  const scriptPath = path.resolve(ALIENKIND_DIR, jobDef.script);
  const args = jobDef.args || [];

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }

  // Phase 1b: pass session env vars to Claude-using jobs
  // Security: strip dangerous env vars that could alter child behavior
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    // Block dynamic linker injection (macOS + Linux)
    if (key.startsWith('DYLD_') || key.startsWith('LD_')) {
      delete childEnv[key];
    }
  }

  // Intent #32: Recovery flag — tells jobs they're running in catch-up mode
  if (opts?.recoveryContext) {
    childEnv.ALIENKIND_RECOVERY_DATE = new Date().toISOString();
    childEnv.ALIENKIND_RECOVERY_TYPE = opts.recoveryContext;
    log('INFO', `[runner] Recovery mode: ${opts.recoveryContext} — setting ALIENKIND_RECOVERY_DATE`);
  } else {
    delete childEnv.ALIENKIND_RECOVERY_DATE;
    delete childEnv.ALIENKIND_RECOVERY_TYPE;
  }
  if (jobDef.useSession) {
    // Persistent session via Supabase channel_sessions (single source of truth).
    // Each persistent job gets its own channel: 'daemon_<jobName>' or a shared
    // pipeline channel (e.g., 'daemon_nightly' for sequential nightly phases).
    const sessionChannel = jobDef.sessionChannel || `daemon_${jobDef.name}`;
    try {
      const session = await getChannelSession(sessionChannel, (level: string, msg: string) => log(level, msg));
      childEnv.ALIENKIND_DAEMON_SESSION_ID = session.sessionId;
      childEnv.ALIENKIND_DAEMON_SESSION_RESUME = session.isResume ? 'true' : '';
      childEnv.ALIENKIND_SESSION_CHANNEL = sessionChannel;
      log('INFO', `[runner] Session: ${session.sessionId} (${session.isResume ? 'resume' : 'new'}) [${sessionChannel}]`);
    } catch (err: any) {
      log('WARN', `[runner] Session lookup failed: ${err.message} — running stateless`);
    }
  }

  // Session mode (Containment Fields) — set from daemon-jobs.ts MODE_OVERRIDES
  // Re-require on each execution to pick up changes without daemon restart.
  // delete require.cache[...] forces a fresh read of the file.
  const daemonJobsPath = require.resolve('../config/daemon-jobs.ts');
  delete require.cache[daemonJobsPath];
  const { getJobMode } = require('../config/daemon-jobs.ts');
  childEnv.ALIENKIND_SESSION_MODE = getJobMode(jobDef.name);

  log('INFO', `[runner] Forking: ${jobDef.script} [mode=${childEnv.ALIENKIND_SESSION_MODE}] ${args.join(' ')}`);

  return new Promise<void>((resolve, reject) => {
    const child = fork(scriptPath, args, {
      cwd: ALIENKIND_DIR,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      silent: true,
      // Use tsx loader so forked .ts scripts resolve ESM imports correctly.
      // Without this, Node looks for .js files (e.g. shared.js instead of shared.ts)
      // when a script uses ESM `import` syntax. Applies to all jobs uniformly.
      // --max-old-space-size=6144: nightly-analysis OOM'd at default ~2-4GB heap
      // during pre-Claude data collection (30+ Supabase queries + enrichment).
      // 6GB gives headroom for heavy jobs without affecting light ones.
      execArgv: ['--import=tsx', '--max-old-space-size=6144'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // Per-job timeout from constants (default 15 min)
    const jobTimeout = DAEMON.jobTimeouts[jobDef.name] || DAEMON.jobTimeouts.default;
    const timeout = setTimeout(() => {
      log('WARN', `[runner] ${jobDef.name} timeout after ${Math.round(jobTimeout / 60000)}m — killing`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000);
    }, jobTimeout);

    child.on('close', (code) => {
      clearTimeout(timeout);

      // Always release session lock when job finishes (legacy telegram path)
      if (jobDef.useSession === 'telegram') {
        releaseSessionLock();
      }

      // Record successful session message for Supabase-backed persistent sessions
      if (jobDef.useSession && code === 0 && childEnv.ALIENKIND_SESSION_CHANNEL) {
        recordSessionMessage(childEnv.ALIENKIND_SESSION_CHANNEL, (level: string, msg: string) => log(level, msg)).catch(() => {});
      }

      // Compaction detection: check if context was compressed during this job
      if (jobDef.useSession && SESSION.compactionMarkers) {
        const combined = (stdout + stderr).toLowerCase();
        const detected = SESSION.compactionMarkers.find(marker => combined.includes(marker.toLowerCase()));
        if (detected) {
          if (jobDef.useSession === 'telegram') {
            // Signal the Telegram listener to rotate its session
            try {
              fs.writeFileSync(path.join(LOG_DIR, 'telegram-session-rotate.signal'), JSON.stringify({
                reason: `compaction detected in ${jobDef.name}`,
                timestamp: new Date().toISOString(),
              }));
              log('WARN', `[runner] Signaled Telegram session rotation (compaction in ${jobDef.name})`);
            } catch (e) {
              log('ERROR', `[runner] Failed to write rotation signal: ${e.message}`);
            }
          } else {
            sessions.forceRotate('compaction detected');
          }
        }
      }

      if (code === 0) {
        if (jobDef.expectsOutput && stdout.trim().length === 0) {
          log('WARN', `[runner] ${jobDef.name} exited 0 but produced NO output — possible silent failure`);
        }
        log('INFO', `[runner] ${jobDef.name} completed (stdout: ${stdout.length}b)`);
        // Update Telegram session jobCount when shared session job completes
        if (jobDef.useSession === 'telegram' && childEnv.ALIENKIND_SESSION_SHARED === 'telegram') {
          try {
            const tgStatePath = path.join(LOG_DIR, 'telegram-sessions.json');
            const tgState = JSON.parse(fs.readFileSync(tgStatePath, 'utf8'));
            tgState.jobCount = (tgState.jobCount || 0) + 1;
            const tmp = tgStatePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(tgState, null, 2));
            fs.renameSync(tmp, tgStatePath);
          } catch (err) {
            log('WARN', `[runner] Failed to update Telegram session jobCount: ${err.message}`);
          }
        }
        resolve();
      } else {
        const errMsg = `${jobDef.name} exited code=${code}`;
        log('ERROR', `[runner] ${errMsg}`);
        if (stderr.trim()) {
          log('ERROR', `[runner] stderr: ${stderr.trim().slice(0, 500)}`);
        }
        // Rotate session on failure to prevent "Session ID already in use" cascade
        if (jobDef.useSession === 'telegram') {
          try {
            fs.writeFileSync(path.join(LOG_DIR, 'telegram-session-rotate.signal'), JSON.stringify({
              reason: stderr.includes('already in use') ? 'session conflict' : `job failed (code=${code})`,
              timestamp: new Date().toISOString(),
            }));
          } catch { /* ok */ }
        } else if (jobDef.useSession) {
          const reason = stderr.includes('already in use') ? 'session conflict' : `job failed (code=${code})`;
          sessions.forceRotate(reason);
        }
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Fork failed: ${err.message}`));
    });
  });
}

// --- Scheduler callback: enqueue jobs ---
function onJob(name, entry) {
  const jobDef = JOBS.find(j => j.name === name);
  if (!jobDef) {
    log('WARN', `[daemon] Unknown job: ${name}`);
    return;
  }

  // Capture recovery context from scheduler entry (missed job or retry after failure)
  const recoveryContext = entry?.recoveryContext || null;

  // Nightly jobs get high priority so they jump ahead of queued interval
  // jobs (30s/1m/5m) that pile up during long-running jobs.
  const isHighPriority = name.startsWith('nightly-');

  queue.enqueue({
    name,
    priority: isHighPriority ? 'high' : 'normal',
    resources: RESOURCE_REQUIREMENTS[name] || [],
    run: async () => {
      const startTime = Date.now();
      if (jobDef.runner === 'node') {
        await runNodeJob(jobDef, { recoveryContext });
      } else {
        throw new Error(`Unknown runner: ${jobDef.runner}`);
      }
      // Only count session jobs that actually invoked Claude (>5s runtime).
      // Scripts that exit early via idempotency guards complete in <1s without
      // ever calling Claude, so the session was never created.
      const duration = Date.now() - startTime;
      if (jobDef.useSession && duration > 5000) {
        sessions.recordJob();
      }
    },
    onSuccess: () => {
      scheduler.recordSuccess(name);
      // Clear per-job failure alert suppression so next failure cycle will alert again
      if (jobFailureAlerted.has(name)) {
        log('INFO', `[daemon] ${name} recovered — cleared failure alert suppression`);
        jobFailureAlerted.delete(name);
      }
      // Mycelium: write last completed job as focus
      updateFocus('daemon', { type: 'daemon', focus: `completed: ${name}`, pid: process.pid });
    },
    onError: (err) => {
      const failures = scheduler.recordFailure(name, err.message);

      // Dedup: check if this is the same root cause as a recent failure
      const { isDup, fingerprint, affectedJobs } = isDuplicateError(name, err.message);

      if (failures >= DAEMON.maxConsecutiveFailures && sendAlert) {
        // Dedup: only send consecutive-failure alert if we haven't already alerted for this fingerprint
        const fpEntry = recentErrorFingerprints.get(fingerprint);
        const fpAlreadyAlerted = fpEntry && fpEntry.alerted;
        // Per-job suppression: don't re-alert for the same job since last daemon restart
        const jobAlreadyAlerted = jobFailureAlerted.has(name);
        if (!fpAlreadyAlerted && !jobAlreadyAlerted) {
          sendAlert(formatJobFailure(name, err.message, failures));
          if (fpEntry) fpEntry.alerted = true;
          jobFailureAlerted.add(name);
        } else {
          log('INFO', `[daemon] Suppressed repeat failure alert for ${name} (failures=${failures})`);
        }
      }

      // Self-healing: auto-investigate on first failure.
      // Investigation is autonomous — no approval needed to look.
      // Intent is only created if investigation finds a proposed fix that needs approval.
      // DEDUP: Skip if another job already triggered investigation for same root cause.
      if (SELF_HEALING_JOBS.has(name) && failures === 1) {
        if (isDup) {
          log('INFO', `[self-healing] Skipping ${name} — same root cause as ${affectedJobs.filter(j => j !== name).join(', ')} (fingerprint: ${fingerprint})`);
          // Send a consolidated update if 3+ jobs hit the same error
          const fpEntry = recentErrorFingerprints.get(fingerprint);
          if (affectedJobs.length >= 3 && fpEntry && !fpEntry.alerted && sendAlert) {
            fpEntry.alerted = true;
            sendAlert(formatJobFailure(affectedJobs.join(', '), err.message, affectedJobs.length));
          }
          return; // Skip per-job investigation
        }

        const scriptPath = JOBS.find(j => j.name === name)?.script || `scripts/${name}.js`;

        // Notify the human immediately — investigation starts now, not pending approval
        if (sendAlert) {
          sendAlert(formatJobFailure(name, err.message) + '\nInvestigating automatically.');
        }
        log('INFO', `[self-healing] Auto-investigating ${name} failure`);

        // Spawn autonomous diagnostic session immediately
        const selfHeal = require('./self-heal.ts');
        selfHeal.investigate({
          jobName: name,
          errorMsg: err.message,
          scriptPath,
          intentId: null, // no pre-created intent — intent created only if PROPOSE
          log: (level, msg) => log(level, msg),
        }).then(async (result) => {
          log('INFO', `[self-heal] ${name}: ${result.status} — ${(result.summary || '').slice(0, 200)}`);

          // Only create an intent when investigation found a fix that needs approval
          if (result.status === 'propose') {
            try {
              const intent = await createIntent({
                source: 'self_healing',
                triggerSummary: `${name} failed: ${err.message.slice(0, 200)}`,
                diagnosis: result.summary,
                evidence: [{ type: 'error', content: err.message.slice(0, 500) }, { type: 'diagnosis', content: result.summary }],
                proposedAction: result.summary,
                filesAffected: [scriptPath],
                riskAssessment: 'Investigation complete — proposed fix needs approval.',
                priority: name.startsWith('nightly-') ? 'high' : 'medium',
              });
              if (intent && !intent.throttled && sendAlert) {
                sendAlert(formatForTelegram(intent));
                log('INFO', `[self-healing] Intent #${intent.id} created for ${name} (proposed fix)`);
              }
            } catch (e) {
              log('WARN', `[self-healing] Failed to create intent: ${(e as Error).message}`);
            }
          }
        }).catch(e => {
          log('WARN', `[self-heal] ${name} investigation failed: ${e.message}`);
        });
      }
    },
  });
}

// --- Create scheduler and register jobs ---
const scheduler = createScheduler({
  log: (level, msg) => log(level, msg),
  onJob,
});

for (const job of JOBS) {
  scheduler.addJob(job);
}

// --- Event Bus (Nervous System) ---
// Replaces polling for file-based events with instant reactions.
// Signal polling enables cross-terminal coordination.
const eventBus = createEventBus({
  nodeId: 'daemon',
  log: (level: string, msg: string) => log(level, msg),
  watchPaths: [],
  signalPollMs: 5000,
});

// Handler: Cross-terminal signals — log and react to incoming signals
eventBus.on('signal:decision', async (signal: any) => {
  log('INFO', `[event-bus:signal] Decision from ${signal.payload?.sender_label || signal.from_node}: ${signal.payload?.summary || JSON.stringify(signal.payload).slice(0, 100)}`);
}, 'decision-logger');

eventBus.on('signal:awareness', async (signal: any) => {
  log('INFO', `[event-bus:signal] Awareness from ${signal.payload?.sender_label || signal.from_node}: ${signal.payload?.summary || ''}`);
}, 'awareness-logger');

// --- Consolidated Work Checker (Phase 4: replaces 11 cron pollers) ---
// Instead of 11 separate processes spawning every 15-60s, one cycle checks
// all Supabase tables for pending work every 5s. Only forks the handler
// script when there's actual work to do. Latency: <5s instead of 15-60s.
const WORK_CHECK_INTERVAL_MS = 5000;
let workCheckTimer: any = null;
const workCheckRunning = new Set<string>(); // prevent concurrent runs of same script

interface WorkCheck {
  name: string;
  table: string;
  query: string | (() => string); // PostgREST filter — string or function for dynamic queries
  script: string;
  args?: string[];
  cooldownMs?: number; // min time between triggers (prevents rapid re-fire)
  lastTriggered?: number;
  supabaseUrl?: string; // override for cross-project queries
  supabaseKey?: string;
}

const WORK_CHECKS: WorkCheck[] = [
  // Reference deployment absorbed intent processing into the partner's
  // autonomous operator cycle. Forkers wire their own WorkCheck entries
  // here for pending-work detection.
];
// Note: signup-monitor, [product]-feedback-monitor, and thread-scanner
// query external Supabase projects or external APIs. They stay as cron jobs
// since their Supabase URLs differ from the primary. Only pollers that hit
// our primary Supabase are converted to event-driven.

async function runWorkChecks() {
  if (shuttingDown) return;
  const now = Date.now();
  const { supabaseGet } = require('./lib/supabase.ts');

  for (const check of WORK_CHECKS) {
    try {
      // Cooldown: don't re-trigger if recently fired
      if (check.lastTriggered && (now - check.lastTriggered) < (check.cooldownMs || 5000)) continue;
      // Don't run if already running
      if (workCheckRunning.has(check.name)) continue;

      const resolvedQuery = typeof check.query === 'function' ? check.query() : check.query;
      const rows = await supabaseGet(check.table, resolvedQuery);
      if (!rows || rows.length === 0) continue;

      // Work found — fork the handler
      check.lastTriggered = now;
      workCheckRunning.add(check.name);

      const scriptPath = path.resolve(ALIENKIND_DIR, check.script);
      if (!fs.existsSync(scriptPath)) {
        log('WARN', `[work-checker] Script not found: ${check.script}`);
        workCheckRunning.delete(check.name);
        continue;
      }

      log('INFO', `[work-checker] ${check.name}: work detected, forking ${check.script}`);

      const child = fork(scriptPath, check.args || [], {
        cwd: ALIENKIND_DIR,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        silent: true,
        execArgv: ['--import=tsx'],
      });

      child.on('close', (code: number | null) => {
        workCheckRunning.delete(check.name);
        if (code === 0) {
          log('INFO', `[work-checker] ${check.name}: completed`);
        } else {
          log('WARN', `[work-checker] ${check.name}: failed (exit ${code})`);
        }
      });

      // Timeout: 2 minutes per handler
      setTimeout(() => {
        if (child.exitCode === null) {
          log('WARN', `[work-checker] ${check.name}: timeout — killing`);
          child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
        }
      }, 120000);

    } catch (e: any) {
      // Individual check failure doesn't stop others
      log('WARN', `[work-checker] ${check.name} check failed: ${e?.message || e}`);
    }
  }
}

// --- Midnight rotation ---
let lastDate = DATE;
function checkMidnight() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (todayStr !== lastDate) {
    lastDate = todayStr;
    sessions.rotateDaily();
    // Clean up old daemon-started marker files (keep only today's)
    try {
      const markers = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('daemon-started-') && !f.endsWith(todayStr));
      for (const m of markers) fs.unlinkSync(path.join(LOG_DIR, m));
      if (markers.length) log('DEBUG', `[daemon] Cleaned ${markers.length} old startup marker(s)`);
    } catch { /* ok */ }
    log('INFO', `[daemon] Midnight rotation complete for ${todayStr}`);
  }
}

// --- Graceful shutdown ---
let shuttingDown = false;

async function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `[daemon] Shutdown signal: ${signal}`);

  scheduler.stop();
  eventBus.stop();
  if (workCheckTimer) clearInterval(workCheckTimer);
  if (healthTimer) clearInterval(healthTimer);

  if (queue.isRunning) {
    log('INFO', `[daemon] Draining queue (current: ${queue.currentJob})...`);
    await queue.drain();
  }

  writeHealth();
  log('INFO', `[daemon] Shutdown complete. Uptime: ${Math.round(process.uptime())}s`);
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// --- Config Watchdog ---
// Monitors infrastructure files that the daemon loads once at startup.
// When any file's mtime changes, the daemon drains the queue and exits cleanly.
// launchd KeepAlive restarts it with fresh config. Simpler and safer than hot-reload.
const { INFRA_FILES } = require('./lib/activate-gate.ts');
const CONFIG_WATCH_INTERVAL_MS = 10_000; // poll every 10s
const configBaselines = new Map<string, { mtime: number; hash: string }>(); // path → mtime + content hash
let configWatchTimer: ReturnType<typeof setInterval> | null = null;

function getInfraFilesToWatch(): string[] {
  const files = [...INFRA_FILES];
  // Also watch plist files (same logic as activate-gate.ts)
  try {
    const configDir = path.join(ALIENKIND_DIR, 'config');
    for (const f of fs.readdirSync(configDir)) {
      if (f.endsWith('.plist') && f.startsWith('com.example.') && !f.startsWith('com.example.studio2-')) {
        files.push(path.join(configDir, f));
      }
    }
  } catch { /* non-fatal */ }
  return files;
}

function contentHash(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return require('crypto').createHash('sha256').update(content).digest('hex');
}

function snapshotMtimes(): void {
  for (const filePath of getInfraFilesToWatch()) {
    try {
      const stat = fs.statSync(filePath);
      configBaselines.set(filePath, {
        mtime: Math.floor(stat.mtimeMs / 1000),
        hash: contentHash(filePath),
      });
    } catch { /* file doesn't exist yet — skip */ }
  }
}

async function checkConfigChanges(): Promise<void> {
  if (shuttingDown) return;
  for (const filePath of getInfraFilesToWatch()) {
    try {
      const stat = fs.statSync(filePath);
      const currentMtime = Math.floor(stat.mtimeMs / 1000);
      const baseline = configBaselines.get(filePath);
      if (baseline !== undefined && currentMtime > baseline.mtime) {
        // mtime changed — verify content actually changed (git operations can touch mtime without content changes)
        const currentHash = contentHash(filePath);
        if (currentHash === baseline.hash) {
          // Content unchanged — update mtime baseline to avoid re-checking, skip restart
          baseline.mtime = currentMtime;
          continue;
        }
        const relPath = path.relative(ALIENKIND_DIR, filePath);
        await handleConfigChange(relPath);
        return; // only need to trigger once
      }
      // New file appeared since startup — set baseline, don't trigger
      if (baseline === undefined) {
        configBaselines.set(filePath, {
          mtime: currentMtime,
          hash: contentHash(filePath),
        });
      }
    } catch { /* stat failure — file may have been deleted, non-fatal */ }
  }
}

async function handleConfigChange(changedFile: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true; // prevent re-entry and block new job scheduling

  log('INFO', `[config-watchdog] Infrastructure change detected: ${changedFile}`);

  // 1. Stop scheduler and timers (no new jobs)
  scheduler.stop();
  if (configWatchTimer) clearInterval(configWatchTimer);
  if (workCheckTimer) clearInterval(workCheckTimer);
  if (healthTimer) clearInterval(healthTimer);
  eventBus.stop();

  // 2. Drain running jobs (no mid-job kills)
  if (queue.isRunning || queue.depth > 0) {
    log('INFO', `[config-watchdog] Draining queue (running: ${queue.status.running.join(', ') || 'none'}, pending: ${queue.depth})...`);
    await queue.drain();
    log('INFO', '[config-watchdog] Queue drained');
  }

  // 3. Log to daily memory
  try {
    const { logToDaily } = require('./lib/env.ts');
    logToDaily(`RESTART: config change detected in \`${changedFile}\` — daemon exiting for launchd restart`, 'Config Watchdog');
  } catch (e) {
    log('WARN', `[config-watchdog] Failed to write daily memory: ${(e as Error).message}`);
  }

  // 4. Deposit to circulation
  try {
    const { deposit } = require('./lib/circulation.ts');
    await deposit({
      source_organ: 'daemon-config-watchdog',
      finding: `Daemon self-restarting: infrastructure file changed (${changedFile}). Queue drained cleanly. launchd will restart with fresh config.`,
      finding_type: 'observation',
      domain: 'infrastructure',
      confidence: 1.0,
      decay_hours: 24,
      related_files: [changedFile],
      metadata: { trigger_file: changedFile, uptime_seconds: Math.round(process.uptime()) },
    });
  } catch (e) {
    log('WARN', `[config-watchdog] Failed to deposit to circulation: ${(e as Error).message}`);
  }

  // 5. Write final health snapshot
  writeHealth();

  log('INFO', `[config-watchdog] Exiting cleanly (uptime: ${Math.round(process.uptime())}s). launchd will restart.`);
  process.exit(0);
}

// --- Startup ---
log('INFO', `[daemon] Starting — pid=${process.pid}, ${JOBS.length} jobs registered`);
log('INFO', `[daemon] Session: ${sessions.sessionId || 'pending'}, tick=${DAEMON.tickIntervalMs/1000}s`);

// Verify session state file access
const sessionStatePath = path.join(LOG_DIR, 'daemon-sessions.json');
if (fs.existsSync(sessionStatePath)) {
  log('INFO', `[daemon] Session state file exists: ${sessionStatePath}`);
} else {
  log('DEBUG', `[daemon] Session state file will be created at: ${sessionStatePath}`);
}

// --once mode for testing
if (process.argv.includes('--once')) {
  log('INFO', '[daemon] --once mode: running single tick');
  scheduler.tick();
  if (!queue.isRunning && queue.depth === 0) {
    writeHealth();
    log('INFO', '[daemon] --once complete, exiting');
    process.exit(0);
  }
  // Wait for queue to drain then exit
  const checkDone = setInterval(() => {
    if (!queue.isRunning && queue.depth === 0) {
      clearInterval(checkDone);
      writeHealth();
      log('INFO', '[daemon] --once complete, exiting');
      process.exit(0);
    }
  }, 1000);
  checkDone.unref();
} else {
  // Normal operation
  scheduler.start();
  eventBus.start().catch((e: any) => log('WARN', `[event-bus] Start failed: ${e?.message || e}`));

  // Start consolidated work checker (replaces 8 cron pollers with 5s event-driven checks)
  workCheckTimer = setInterval(runWorkChecks, WORK_CHECK_INTERVAL_MS);
  log('INFO', `[work-checker] Started — ${WORK_CHECKS.length} tables, ${WORK_CHECK_INTERVAL_MS}ms cycle`);

  // Start config watchdog — snapshot mtimes at startup, poll for changes
  snapshotMtimes();
  configWatchTimer = setInterval(checkConfigChanges, CONFIG_WATCH_INTERVAL_MS);
  if (configWatchTimer.unref) configWatchTimer.unref();
  log('INFO', `[config-watchdog] Watching ${configBaselines.size} infrastructure files (${CONFIG_WATCH_INTERVAL_MS / 1000}s interval)`);

  // --- Usage monitor (inline, zero-cost API polling) ---
  // usage-monitor poll interval removed — OTEL replaces daemon polling
  let supabaseUrl, supabaseKey;
  try {
    const { loadEnv } = require('./lib/shared.ts');
    const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
    supabaseUrl = env.SUPABASE_URL;
    supabaseKey = env.SUPABASE_SERVICE_KEY;
  } catch { /* ok — Supabase writes will be skipped */ }

  // Usage-monitor daemon polling REMOVED (Apr 9).
  // OTEL collector (port 4318) is the primary consumption data source.
  // Subscription utilization % is on-demand: scripts/tools/refresh-usage.ts.
  // Failover triggers on actual 429 response, not polling.

  healthTimer = setInterval(() => {
    checkMidnight();
    checkListenerHealth();
    writeHealth();
  }, DAEMON.healthIntervalMs);
  healthTimer.unref();
  writeHealth();

  // Gate "Daemon started" alert: only send if first start of the day or recovering from failure.
  // Prevents noise from routine restarts (launchd KeepAlive, code deploys, etc.).
  const startedMarkerFile = path.join(LOG_DIR, `daemon-started-${DATE}`);
  const isFirstStartToday = !fs.existsSync(startedMarkerFile);
  const isRecoveryStart = (() => {
    // Check if previous health file shows an error/crash state
    try {
      if (fs.existsSync(HEALTH_FILE)) {
        const prevHealth = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
        // If the previous daemon's PID is dead and uptime was < 60s, likely a crash recovery
        if (prevHealth.pid && prevHealth.uptime < 60) return true;
      }
    } catch { /* corrupt health file = treat as recovery */ return true; }
    return false;
  })();

  // Always write the marker (idempotent — just touch the file)
  try { fs.writeFileSync(startedMarkerFile, `${process.pid}\n`); } catch { /* ok */ }

  if (sendAlert) {
    if (isFirstStartToday || isRecoveryStart) {
      sendAlert(`Daemon started — ${JOBS.length} jobs`);
    } else {
      log('INFO', `[daemon] Suppressed repeat startup alert (already started today, pid=${process.pid})`);
    }
  }
}
