// @alienkind-core
/**
 * Session Lock — prevents concurrent --resume on the same long-running session.
 *
 * File-based advisory lock using O_EXCL (exclusive create) for atomic acquisition.
 * Stale locks (holder process dead or lock > maxAgeMs) are automatically broken.
 *
 * Race safety: O_EXCL is atomic at the kernel level — if two processes race to
 * acquire after breaking a stale lock, only one succeeds. The old tmp+rename
 * approach had a window between unlink and create where both could win.
 *
 * Usage:
 *   const acquired = acquireSessionLockSync({ holder: 'telegram-dm' });
 *   if (!acquired) { // session busy, queue or fallback }
 *   // ... invoke the session with --resume ...
 *   releaseSessionLock();
 */

const fs = require('fs');
const path = require('path');

const portable = require('./portable.ts');
const { resolveRepoRoot } = portable;

const ROOT = resolveRepoRoot();
const DEFAULT_LOCK_PATH = path.join(ROOT, 'logs', 'session.lock');
const STALE_THRESHOLD_MS = 20 * 60 * 1000; // 20 min — longer than any single job

interface LockData {
  holder: string;
  pid: number;
  acquiredAt: string;
}

interface AcquireOptions {
  holder?: string;
  lockPath?: string;
  maxWaitMs?: number;
  log?: (...args: any[]) => void;
}

interface ReleaseOptions {
  lockPath?: string;
}

/**
 * Check if a PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = test existence, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Break a stale lock if the holder is dead or the lock is too old.
 * Returns true if the lock was broken (or didn't exist), false if held by a live process.
 */
function breakStaleIfNeeded(lockPath: string, log: (...args: any[]) => void): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock: LockData = JSON.parse(raw);
    const age = Date.now() - new Date(lock.acquiredAt).getTime();

    if ((lock.pid && !isProcessAlive(lock.pid)) || age > STALE_THRESHOLD_MS) {
      log('WARN', `[session-lock] Breaking stale lock (holder=${lock.holder}, pid=${lock.pid}, age=${Math.round(age / 1000)}s)`);
      try { fs.unlinkSync(lockPath); } catch { /* another process may have already broken it */ }
      return true;
    }

    log('DEBUG', `[session-lock] Lock held by ${lock.holder} (pid=${lock.pid}, age=${Math.round(age / 1000)}s)`);
    return false;
  } catch (e: any) {
    if (e.code === 'ENOENT') return true; // No lock file — proceed to acquire
    // Corrupt lock file — break it
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    return true;
  }
}

/**
 * Attempt to acquire the lock atomically using O_EXCL.
 * O_EXCL guarantees that only one process can create the file — if two race,
 * exactly one gets EEXIST and the other succeeds.
 */
function tryAcquire(holder: string, lockPath: string, log: (...args: any[]) => void): boolean {
  // Ensure parent dir exists (first run may not have logs/ yet)
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* ok */ }

  // Check for stale lock first
  if (fs.existsSync(lockPath)) {
    if (!breakStaleIfNeeded(lockPath, log)) {
      return false; // Lock is held by a live process
    }
    // Stale lock was broken (or broke between exists check and read — fine either way)
  }

  // Atomic acquisition: O_CREAT | O_EXCL | O_WRONLY — fails if file already exists
  const lockData: LockData = {
    holder,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx'); // 'wx' = O_CREAT | O_EXCL | O_WRONLY
  } catch (e: any) {
    if (e.code === 'EEXIST') {
      // Another process won the race — they acquired between our stale check and our create
      log('DEBUG', `[session-lock] Lost acquisition race to another process`);
      return false;
    }
    log('WARN', `[session-lock] Unexpected error during acquire: ${e.message}`);
    return false;
  }

  try {
    fs.writeSync(fd, JSON.stringify(lockData));
    fs.closeSync(fd);
    return true;
  } catch {
    // Failed to write lock data — clean up
    try { fs.closeSync(fd); } catch { /* ok */ }
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    return false;
  }
}

/**
 * Attempt to acquire the session lock (synchronous, no waiting).
 */
function acquireSessionLockSync({ holder = `pid-${process.pid}`, lockPath = DEFAULT_LOCK_PATH, log = () => {} }: AcquireOptions = {}): boolean {
  return tryAcquire(holder, lockPath, log);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionLock({ holder = `pid-${process.pid}`, lockPath = DEFAULT_LOCK_PATH, maxWaitMs = 0, log = () => {} }: AcquireOptions = {}): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    if (tryAcquire(holder, lockPath, log)) return true;
    if (Date.now() >= deadline) return false;
    const waitMs = Math.min(1000, deadline - Date.now());
    if (waitMs <= 0) return false;
    await sleep(waitMs);
  }
}

/**
 * Release the session lock.
 */
function releaseSessionLock({ lockPath = DEFAULT_LOCK_PATH }: ReleaseOptions = {}): void {
  try {
    if (fs.existsSync(lockPath)) {
      // Only release if we own it
      const lock: LockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch { /* ok — lock may already be cleaned up */ }
}

module.exports = {
  acquireSessionLock,
  acquireSessionLockSync,
  releaseSessionLock,
};
