/**
 * Scheduler — cron/interval scheduler with tick loop.
 *
 * Checks all registered jobs every tick (30s). Supports:
 *   - Cron: { hour, minute } — fires once when time matches
 *   - Interval: { intervalMs } — fires every N ms
 *   - Backoff on failure with configurable retry delays
 *   - Missed job recovery on startup
 *
 * Usage:
 *   const scheduler = createScheduler({ log, onJob });
 *   scheduler.addJob({ name: 'heartbeat', schedule: { minute: 30 }, ... });
 *   scheduler.start();
 *   scheduler.stop();
 */

const fs = require('fs');
const path = require('path');
const { DAEMON } = require('./constants.ts');

const STATE_FILE = path.join(__dirname, '../../logs/scheduler-state.json');

interface PersistedState {
  [jobName: string]: { lastRunDate: string; lastRun: number; lastRunStatus?: string };
}

function loadState(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveState(jobs: Map<string, JobEntry>): void {
  const state: PersistedState = {};
  for (const [name, entry] of jobs) {
    if (entry.lastRunDate) {
      state[name] = { lastRunDate: entry.lastRunDate, lastRun: entry.lastRun || 0, lastRunStatus: entry.lastRunStatus };
    }
  }
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* non-critical */ }
}

interface Schedule {
  hour?: number;
  minute?: number;
  intervalMs?: number;
}

interface QuietHours {
  start: number;
  end: number;
}

interface JobConfig {
  name: string;
  schedule: Schedule;
  enabled?: boolean;
  quietHours?: QuietHours;
  skipDays?: number[];  // 0=Sun, 6=Sat — skip these days entirely
  runOnMiss?: boolean;
  [key: string]: any;
}

interface JobEntry extends JobConfig {
  lastRun: number | null;
  lastRunDate: string | null;
  lastRunKey?: string;
  nextRetryAt: number | null;
  consecutiveFailures: number;
  enabled: boolean;
  lastRunStatus?: string;
  lastRunAt?: string;
  lastError?: string | null;
  recoveryContext?: 'missed' | 'retry' | null;
  deferredUntilClear?: boolean;  // load gate deferred — eligible beyond normal window
}

interface JobStatus {
  enabled: boolean;
  lastRun: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
}

interface SchedulerOptions {
  log?: (...args: any[]) => void;
  onJob?: (name: string, entry: JobEntry) => void;
}

interface Scheduler {
  addJob(job: JobConfig): void;
  start(): void;
  stop(): void;
  tick(): void;
  recordSuccess(name: string): void;
  recordFailure(name: string, errorMessage?: string): number | undefined;
  enableJob(name: string): boolean;
  checkMissedJobs(): void;
  getStatus(): Record<string, JobStatus>;
  readonly jobCount: number;
  readonly isRunning: boolean;
}

function createScheduler({ log = console.log, onJob }: SchedulerOptions = {}): Scheduler {
  const jobs = new Map<string, JobEntry>();
  const persisted = loadState();
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function getDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function getYesterdayDate(): string {
    const d = new Date(Date.now() - 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function addJob(job: JobConfig): void {
    // Hydrate from persisted state so restart doesn't re-trigger completed jobs
    const saved = persisted[job.name];
    const entry: JobEntry = {
      ...job,
      lastRun: saved?.lastRun || null,
      lastRunDate: saved?.lastRunDate || null,
      lastRunStatus: saved?.lastRunStatus || undefined,
      nextRetryAt: null,
      consecutiveFailures: 0,
      enabled: job.enabled !== false,
      recoveryContext: null,
    };
    jobs.set(job.name, entry);
    log('INFO', `[scheduler] Registered job: ${job.name} (${describeSchedule(job.schedule)})`);
  }

  function describeSchedule(schedule: Schedule): string {
    if (schedule.intervalMs) return `every ${Math.round(schedule.intervalMs / 60000)}m`;
    const parts: string[] = [];
    if (schedule.hour !== undefined) parts.push(`hour=${schedule.hour}`);
    if (schedule.minute !== undefined) parts.push(`minute=${schedule.minute}`);
    return parts.join(', ') || 'unknown';
  }

  function shouldRun(entry: JobEntry): boolean {
    if (!entry.enabled) return false;

    const now = new Date();
    const schedule = entry.schedule;

    // Retry backoff check
    if (entry.nextRetryAt && now.getTime() < entry.nextRetryAt) {
      return false;
    }

    const hour = now.getHours();

    // Skip days (e.g., weekends: [0, 6])
    if (entry.skipDays?.includes(now.getDay())) return false;

    // Skip check based on quiet hours if defined (applies to ALL job types)
    if (entry.quietHours) {
      const { start, end } = entry.quietHours;
      if (start > end) {
        // Wraps midnight: e.g., 23-4 means 23,0,1,2,3
        if (hour >= start || hour < end) return false;
      } else {
        if (hour >= start && hour < end) return false;
      }
    }

    // Past retry backoff with pending failures — fire the retry.
    // Bypasses lastRunDate/lastRunKey guards that would otherwise block
    // re-running a daily/hourly job that already ran (and failed) this period.
    if (entry.nextRetryAt && entry.consecutiveFailures > 0) {
      return true;
    }

    // Interval-based (e.g., auto-commit every 2h)
    if (schedule.intervalMs) {
      if (!entry.lastRun) return true;
      return (now.getTime() - entry.lastRun) >= schedule.intervalMs;
    }

    // Cron-based: check hour and minute match
    const minute = now.getMinutes();
    const today = getDate();

    // Hourly: fire at specified minute, any hour
    if (schedule.hour === undefined && schedule.minute !== undefined) {
      // Fire once per hour at the specified minute
      const runKey = `${today}-${hour}`;
      if (entry.lastRunKey === runKey) return false;
      return minute >= schedule.minute && minute < schedule.minute + 2;
    }

    // Daily: fire at specified hour and minute
    if (schedule.hour !== undefined && schedule.minute !== undefined) {
      if (entry.lastRunDate === today) return false;
      // Load-gate deferred jobs remain eligible for the rest of the scheduled hour
      if (entry.deferredUntilClear && hour === schedule.hour && minute >= schedule.minute) {
        return true;
      }
      return hour === schedule.hour && minute >= schedule.minute && minute < schedule.minute + 2;
    }

    return false;
  }

  function tick(): void {
    const now = new Date();
    const today = getDate();
    const hour = now.getHours();

    for (const [name, entry] of jobs) {
      if (!shouldRun(entry)) continue;

      // Set recovery context if this is a retry after failure
      if (entry.consecutiveFailures > 0 && entry.nextRetryAt) {
        entry.recoveryContext = 'retry';
      } else {
        entry.recoveryContext = null;
      }

      // Mark as running for this period
      entry.lastRun = now.getTime();
      // Recovery/retry runs that fire BEFORE the scheduled hour shouldn't consume
      // today's run slot. E.g., a 23:35 job retried at 02:00 shouldn't block the
      // regular 23:35 run later that day.
      const isEarlyRecovery = entry.recoveryContext &&
        entry.schedule.hour !== undefined &&
        hour !== entry.schedule.hour;
      // Nightly jobs (scheduled hour >= 22) that run past midnight (hour < 6) due
      // to pipeline delays must use yesterday's date — otherwise they consume the
      // NEXT night's run slot and the job skips every other night.
      const isLateNightlyRun = !entry.recoveryContext &&
        entry.schedule.hour !== undefined &&
        entry.schedule.hour >= 22 &&
        hour < 6;
      if (isEarlyRecovery) {
        // Don't update lastRunDate — preserve today's scheduled slot
      } else if (isLateNightlyRun) {
        entry.lastRunDate = getYesterdayDate();
      } else {
        entry.lastRunDate = today;
      }
      if (entry.schedule.hour === undefined && entry.schedule.minute !== undefined) {
        entry.lastRunKey = `${today}-${hour}`;
      }
      saveState(jobs);

      // Load-aware routing (mycelium v2): priority-aware Claude job scheduling.
      // Pure-Node jobs bypass entirely. High-priority jobs get higher concurrent limits.
      const usesClaudeCompute = entry.usesClaude !== false && entry.expectsOutput !== false;
      if (usesClaudeCompute) {
        try {
          const { execSync } = require('child_process');
          const claudeCount = parseInt(
            execSync("ps aux | grep 'claude.*-p' | grep -v grep | wc -l", { encoding: 'utf8', timeout: 2000 }).trim()
          );

          // Priority tiers: critical jobs (nightly pipeline + operational pulse) get higher limits
          const CRITICAL_JOBS = new Set(['operational-pulse', 'nightly-analysis', 'nightly-identity-sync', 'nightly-immune']);
          const isCritical = CRITICAL_JOBS.has(name);
          const maxConcurrent = isCritical ? 12 : 6; // Critical: allow up to 12, normal: defer at 6

          if (claudeCount >= maxConcurrent) {
            log(`[scheduler] Load gate: ${name} deferred (${claudeCount} claude processes, limit ${maxConcurrent}${isCritical ? ' [critical]' : ''})`);
            entry.lastRun = 0;
            entry.lastRunDate = '';
            entry.lastRunKey = '';
            continue;
          }
        } catch { /* ps failed — proceed anyway */ }
      }

      if (onJob) {
        onJob(name, entry);
      }
    }
  }

  function recordSuccess(name: string): void {
    const entry = jobs.get(name);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.nextRetryAt = null;
    entry.lastRunStatus = 'success';
    entry.lastRunAt = new Date().toISOString();
    entry.lastError = null;
    entry.recoveryContext = null;
    saveState(jobs);
  }

  function recordFailure(name: string, errorMessage?: string): number | undefined {
    const entry = jobs.get(name);
    if (!entry) return;
    entry.consecutiveFailures++;
    entry.lastRunStatus = 'error';
    entry.lastRunAt = new Date().toISOString();
    entry.lastError = (errorMessage || 'unknown').slice(0, 200);
    const delayIdx = Math.min(entry.consecutiveFailures - 1, DAEMON.retryDelays.length - 1);
    const delay = DAEMON.retryDelays[delayIdx];
    entry.nextRetryAt = Date.now() + delay;

    // Circuit breaker: disable job after maxConsecutiveFailures
    if (entry.consecutiveFailures >= DAEMON.maxConsecutiveFailures) {
      entry.enabled = false;
      log('ERROR', `[scheduler] CIRCUIT OPEN: ${name} disabled after ${entry.consecutiveFailures} consecutive failures. Call enableJob('${name}') to re-enable.`);
    } else {
      log('WARN', `[scheduler] ${name} failed (${entry.consecutiveFailures}x) — retry in ${Math.round(delay / 1000)}s`);
    }
    return entry.consecutiveFailures;
  }

  function enableJob(name: string): boolean {
    const entry = jobs.get(name);
    if (!entry) return false;
    entry.enabled = true;
    entry.consecutiveFailures = 0;
    entry.lastError = '';
    entry.nextRetryAt = undefined;
    log('INFO', `[scheduler] Circuit closed: ${name} re-enabled`);
    saveState(jobs);
    return true;
  }

  function checkMissedJobs(): void {
    const now = new Date();
    const today = getDate();
    const yesterday = getYesterdayDate();
    const hour = now.getHours();

    for (const [name, entry] of jobs) {
      if (!entry.enabled) continue;
      const schedule = entry.schedule;

      // Check daily jobs that should have run earlier today
      if (schedule.hour !== undefined && schedule.minute !== undefined) {
        // Cross-midnight detection: if the job is scheduled for a late hour (e.g., 23)
        // and we're now in the early hours of the next day, the simple `hour > schedule.hour`
        // check fails because hour 2 is never > 23. Detect this by checking if the job's
        // lastRunDate is yesterday (or earlier) AND the current hour is before the scheduled
        // hour — meaning the scheduled time has passed (it was yesterday).
        const missedToday = hour > schedule.hour && entry.lastRunDate !== today;
        const missedYesterday = hour < schedule.hour &&
          entry.lastRunDate !== today &&
          entry.lastRunDate !== yesterday;
        // Also detect: lastRunDate IS yesterday but the job failed (lastRunStatus = 'error')
        // — a failed run shouldn't consume the next day's slot
        const failedYesterday = hour < schedule.hour &&
          entry.lastRunDate === yesterday &&
          entry.lastRunStatus === 'error';

        if (missedToday || missedYesterday || failedYesterday) {
          log('INFO', `[scheduler] Missed job detected: ${name} (scheduled ${schedule.hour}:${String(schedule.minute).padStart(2, '0')}, lastRunDate=${entry.lastRunDate || 'never'}${failedYesterday ? ', prev run failed' : ''})`);
          entry.lastRunDate = today; // prevent re-trigger
          entry.recoveryContext = 'missed';
          if (entry.runOnMiss !== false && onJob) {
            onJob(name, entry);
          }
        }
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    checkMissedJobs();
    tickTimer = setInterval(tick, DAEMON.tickIntervalMs);
    log('INFO', `[scheduler] Started — ${jobs.size} jobs, tick every ${DAEMON.tickIntervalMs / 1000}s`);
  }

  function stop(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    started = false;
    log('INFO', '[scheduler] Stopped');
  }

  function getStatus(): Record<string, JobStatus> {
    const status: Record<string, JobStatus> = {};
    for (const [name, entry] of jobs) {
      status[name] = {
        enabled: entry.enabled,
        lastRun: entry.lastRun ? new Date(entry.lastRun).toISOString() : null,
        lastRunStatus: entry.lastRunStatus || null,
        lastRunAt: entry.lastRunAt || null,
        lastError: entry.lastError || null,
        consecutiveFailures: entry.consecutiveFailures,
        nextRetryAt: entry.nextRetryAt ? new Date(entry.nextRetryAt).toISOString() : null,
      };
    }
    return status;
  }

  return {
    addJob,
    start,
    stop,
    tick,
    recordSuccess,
    recordFailure,
    enableJob,
    checkMissedJobs,
    getStatus,
    get jobCount() { return jobs.size; },
    get isRunning() { return started; },
  };
}

module.exports = { createScheduler };
