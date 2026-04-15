/**
 * Async utilities for Keel.
 *
 * OpenClaw patterns: withTimeout (#22), sleepWithAbort (#14),
 * dedup cache (#18), timer.unref (#35).
 */

// --- Types ---

interface DedupeCache {
  isDuplicate(key: string): boolean;
  clear(): void;
  readonly size: number;
}

// --- withTimeout (P3-22) ---
// Races a promise against a timeout. Prevents hanging API calls.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref(); // Don't keep process alive for this timer
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// --- sleepWithAbort (P3-14) ---
// Abort-aware sleep for retry loops. Enables clean shutdown during backoff.
function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref(); // Don't block shutdown
    if (abortSignal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// --- Deduplication Cache with TTL (P3-18) ---
// Prevents duplicate processing of the same message/event within a time window.
function createDedupeCache(ttlMs: number = 60000, maxSize: number = 200): DedupeCache {
  const cache = new Map<string, number>();
  return {
    isDuplicate(key: string): boolean {
      if (!key) return false;
      const now = Date.now();
      // Prune expired entries (Map is insertion-ordered)
      for (const [k, ts] of cache) {
        if (now - ts > ttlMs) cache.delete(k);
        else break;
      }
      if (cache.has(key)) {
        cache.delete(key);
        cache.set(key, now); // bump to end
        return true;
      }
      cache.set(key, now);
      // Enforce max size
      while (cache.size > maxSize) {
        cache.delete(cache.keys().next().value!);
      }
      return false;
    },
    clear() { cache.clear(); },
    get size() { return cache.size; },
  };
}

module.exports = {
  withTimeout,
  sleepWithAbort,
  createDedupeCache,
};
