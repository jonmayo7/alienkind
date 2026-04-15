/**
 * Gateway lock — prevents duplicate listener instances.
 *
 * Writes a lockfile with PID on startup. If a lock already exists,
 * checks whether the holding process is still alive. If alive: exit
 * (duplicate). If dead: steal the lock (stale).
 *
 * Usage:
 *   const { acquireLock } = require('./lib/lockfile');
 *   acquireLock('telegram-listener', { log });
 *   // Lock auto-releases on SIGTERM, SIGINT, and process exit.
 *
 * OpenClaw pattern #6 — Gateway lock (PID liveness check)
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const LOCK_DIR = path.join(KEEL_DIR, 'logs');

interface LockData {
  pid: number;
  name: string;
  startedAt: string;
}

interface LockResult {
  lockFile: string;
  release: () => void;
}

interface LockOptions {
  log?: (...args: any[]) => void;
}

/**
 * Check if a process with the given PID is alive.
 * Uses signal 0 (no-op) — standard POSIX liveness check.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = no such process (dead). EPERM = exists but no permission (alive).
    return e.code === 'EPERM';
  }
}

/**
 * Acquire a named lock. If a duplicate live instance holds the lock, exits the process.
 * If a stale lock from a dead process exists, steals it.
 *
 * Registers cleanup handlers to release the lock on exit.
 */
function acquireLock(name: string, { log = console.log }: LockOptions = {}): LockResult {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);

  // Check for existing lock
  if (fs.existsSync(lockFile)) {
    try {
      const existing: LockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const existingPid = existing.pid;

      if (existingPid && isProcessAlive(existingPid)) {
        log(`FATAL: Duplicate instance detected — pid=${existingPid} is already running. Exiting.`);
        process.exit(1);
      }

      // Stale lock — previous process is dead
      log(`Stale lock found (pid=${existingPid} is dead) — acquiring lock`);
    } catch (e: any) {
      // Corrupt lock file — overwrite it
      log(`Corrupt lock file (${e.message}) — acquiring lock`);
    }
  }

  // Write lock
  const lockData: LockData = {
    pid: process.pid,
    name,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
  log(`Lock acquired: ${lockFile} (pid=${process.pid})`);

  // Release function
  function release(): void {
    try {
      // Only delete if we still own the lock (prevent deleting a newer instance's lock)
      if (fs.existsSync(lockFile)) {
        const current: LockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.pid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch (e) {
      // Best-effort cleanup
    }
  }

  // Auto-release on exit and signals.
  // IMPORTANT: Signal handlers call release() only — NOT process.exit().
  // Reason: acquireLock() runs early in startup (before listener signal handlers).
  // Node.js fires all listeners for a signal sequentially. If this handler calls
  // process.exit(0), the listener's handleShutdown (which writes the restart
  // sentinel) never fires. By only calling release(), we clean up the lock and
  // let the consumer's handler run next (write sentinel → process.exit).
  process.on('exit', () => { release(); });
  process.on('SIGTERM', () => { release(); });
  process.on('SIGINT', () => { release(); });

  return { lockFile, release };
}

module.exports = { acquireLock };
