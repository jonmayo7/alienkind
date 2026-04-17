// @alienkind-core
/**
 * Process — child-process helpers for graceful kill + output watching.
 * Thin wrappers around node:child_process primitives. Used by invoke.ts and
 * other spawners to enforce no-output timeouts and clean shutdown.
 */

import type { ChildProcess } from 'child_process';

interface WatchOutputOptions {
  noOutputTimeout?: number;
  onTimeout?: () => void;
  log?: (level: string, msg: string) => void;
}

interface WatchHandle {
  tick: () => void;
  stop: () => void;
  isTimedOut: () => boolean;
}

/**
 * Watch a child process for output starvation. Calls onTimeout when
 * noOutputTimeout elapses without a tick. Forward streams through the
 * returned handle's tick() from your data handlers.
 *
 * Usage:
 *   const watcher = watchOutput({ noOutputTimeout: 60000, onTimeout: () => child.kill() });
 *   child.stdout.on('data', () => watcher.tick());
 *   child.on('close', () => watcher.stop());
 */
function watchOutput(opts: WatchOutputOptions = {}): WatchHandle {
  const timeout = opts.noOutputTimeout || 0;
  if (timeout <= 0) {
    return { tick: () => {}, stop: () => {}, isTimedOut: () => false };
  }

  let lastTick = Date.now();
  let stopped = false;
  let timedOut = false;

  const interval = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastTick > timeout) {
      timedOut = true;
      clearInterval(interval);
      try { opts.onTimeout?.(); } catch { /* ok */ }
    }
  }, Math.max(1000, Math.floor(timeout / 10)));
  if (interval.unref) interval.unref();

  return {
    tick: () => { lastTick = Date.now(); },
    stop: () => { stopped = true; clearInterval(interval); },
    isTimedOut: () => timedOut,
  };
}

/**
 * Gracefully kill a child process: SIGTERM, wait grace period, SIGKILL.
 * Returns a promise that resolves when the child exits (or grace elapses).
 */
function gracefulKill(child: ChildProcess, graceMs: number = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    let exited = false;
    const onExit = () => { exited = true; resolve(); };
    child.once('exit', onExit);

    try { child.kill('SIGTERM'); } catch { /* ok */ }

    setTimeout(() => {
      if (!exited && child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ok */ }
      }
      // Resolve regardless — don't hang forever.
      if (!exited) { child.off('exit', onExit); resolve(); }
    }, graceMs);
  });
}

module.exports = {
  watchOutput,
  gracefulKill,
};
