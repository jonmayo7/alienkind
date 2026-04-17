// @alienkind-core
/**
 * Sentinel — watchdog for long-running child processes.
 *
 * Monitors a child's stdout/stderr for "silent" runs (no output for N ms) and
 * kills gracefully when the watchdog trips. Used by daemon job runner and
 * self-heal to prevent hung sessions from wedging the queue.
 *
 * Minimal implementation — no retries, no reconnects. Callers compose higher
 * behavior on top.
 */

interface SentinelOptions {
  noOutputTimeout: number;
  onTimeout?: () => void;
  log?: (level: string, msg: string) => void;
}

interface Sentinel {
  tick: () => void;
  stop: () => void;
  isTimedOut: () => boolean;
}

function createSentinel(opts: SentinelOptions): Sentinel {
  let lastTick = Date.now();
  let stopped = false;
  let timedOut = false;

  const watcher = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastTick > opts.noOutputTimeout) {
      timedOut = true;
      clearInterval(watcher);
      (opts.log || (() => {}))('WARN', `[sentinel] No output for ${opts.noOutputTimeout}ms — firing onTimeout`);
      try { opts.onTimeout?.(); } catch { /* ok */ }
    }
  }, Math.max(1000, Math.floor(opts.noOutputTimeout / 10)));
  // Unref so the watcher doesn't keep the process alive after the child exits.
  if (watcher.unref) watcher.unref();

  return {
    tick: () => { lastTick = Date.now(); },
    stop: () => { stopped = true; clearInterval(watcher); },
    isTimedOut: () => timedOut,
  };
}

module.exports = { createSentinel };
