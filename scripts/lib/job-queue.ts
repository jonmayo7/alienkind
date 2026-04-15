/**
 * Resource-Aware Concurrent Job Queue
 *
 * Replaces the sequential FIFO queue. Jobs declare resource requirements.
 * Jobs on different resources run concurrently. Jobs competing for the same
 * resource run sequentially within that resource's pool.
 *
 * Design patterns from:
 *   SLURM GRES — typed resource pools with capacities
 *   Kueue ResourceFlavor — named classes with admission control
 *   Apple GCD QoS — priority tiers
 *
 * Resources:
 *   studio1:  capacity 1 (Metal GPU — one inference at a time)
 *   studio2:  capacity 1 (Metal GPU — one inference at a time)
 *   browser:  capacity 1 (Ghost Chrome — one session at a time)
 *
 * Jobs without resource requirements run freely (unlimited concurrency).
 * Claude API sessions are externally managed (subscription rate limiting).
 *
 * Usage:
 *   const queue = createJobQueue({ log });
 *   queue.enqueue({ name: 'crypto-engine', run: async () => {...} }); // runs immediately
 *   queue.enqueue({ name: 'linkedin-engage', resources: ['browser', 'studio2'], run: async () => {...} }); // waits for browser + studio2
 */

const { DAEMON } = require('./constants.ts');

// --- Resource Pool ---

interface ResourcePool {
  name: string;
  capacity: number;
  inUse: number;
}

const RESOURCE_POOLS: Record<string, ResourcePool> = {
  studio1: { name: 'studio1', capacity: 1, inUse: 0 },
  studio2: { name: 'studio2', capacity: 1, inUse: 0 },
  browser: { name: 'browser', capacity: 1, inUse: 0 },
};

function acquireResources(resources: string[]): boolean {
  // Check all resources available before acquiring any
  for (const r of resources) {
    const pool = RESOURCE_POOLS[r];
    if (!pool) continue; // Unknown resource = no constraint
    if (pool.inUse >= pool.capacity) return false;
  }
  // All available — acquire
  for (const r of resources) {
    const pool = RESOURCE_POOLS[r];
    if (pool) pool.inUse++;
  }
  return true;
}

function releaseResources(resources: string[]): void {
  for (const r of resources) {
    const pool = RESOURCE_POOLS[r];
    if (pool && pool.inUse > 0) pool.inUse--;
  }
}

// --- Job Types ---

type Priority = 'critical' | 'high' | 'normal' | 'low';
const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

interface Job {
  name: string;
  priority?: Priority | 'high' | 'normal'; // Backward compat: 'high' and 'normal' still work
  resources?: string[]; // e.g. ['studio2', 'browser']. Empty/undefined = no resource constraint.
  run: () => Promise<void>;
  onSuccess?: () => void;
  onError?: (err: Error) => void;
}

interface JobQueueOptions {
  log?: (level: string, msg: string) => void;
}

interface JobQueue {
  enqueue(job: Job): boolean;
  hasPending(name: string): boolean;
  drain(timeoutMs?: number): Promise<void>;
  readonly depth: number;
  readonly currentJob: string | null; // Backward compat: returns first running job name
  readonly isRunning: boolean;
  readonly status: { running: string[]; pending: number; resources: Record<string, { capacity: number; inUse: number }> };
}

function createJobQueue({ log = console.log }: JobQueueOptions = {}): JobQueue {
  const pending: Job[] = [];
  const running: Map<string, Job> = new Map(); // name → job (concurrent)
  let draining = false;
  let drainResolve: (() => void) | null = null;

  function checkDrain(): void {
    if (draining && running.size === 0 && pending.length === 0 && drainResolve) {
      drainResolve();
    }
  }

  async function startJob(job: Job): Promise<void> {
    running.set(job.name, job);
    const startTime = Date.now();
    const resources = job.resources || [];

    try {
      log('INFO', `[queue] Starting job: ${job.name}${resources.length ? ` [${resources.join('+')}]` : ''}`);
      await job.run();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log('INFO', `[queue] Completed job: ${job.name} (${elapsed}s)`);
      if (job.onSuccess) job.onSuccess();
    } catch (err: any) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log('ERROR', `[queue] Job failed: ${job.name} after ${elapsed}s — ${err.message}`);
      if (job.onError) job.onError(err);
    } finally {
      running.delete(job.name);
      if (resources.length) releaseResources(resources);
      // Try to start more jobs now that resources are freed
      processQueue();
      checkDrain();
    }
  }

  function processQueue(): void {
    if (pending.length === 0) return;

    // Try to start as many pending jobs as possible
    // Iterate in priority order (pending is already sorted on insert)
    const toStart: Job[] = [];
    const remaining: Job[] = [];

    for (const job of pending) {
      const resources = job.resources || [];
      if (resources.length === 0) {
        // No resource requirements — start immediately
        toStart.push(job);
      } else if (acquireResources(resources)) {
        // Resources acquired — start
        toStart.push(job);
      } else {
        // Resources busy — keep in queue
        remaining.push(job);
      }
    }

    pending.length = 0;
    pending.push(...remaining);

    // Start all admitted jobs concurrently
    for (const job of toStart) {
      startJob(job); // Fire-and-forget — async execution
    }
  }

  function enqueue(job: Job): boolean {
    // Dedup: reject if same job name already pending or running
    if (pending.some(p => p.name === job.name)) {
      log('DEBUG', `[queue] Dedup: ${job.name} already pending — skipped (queue depth: ${pending.length})`);
      return false;
    }
    if (running.has(job.name)) {
      log('DEBUG', `[queue] Dedup: ${job.name} already running — skipped`);
      return false;
    }

    // Depth cap
    if (pending.length >= (DAEMON.maxQueueDepth || 50)) {
      log('WARN', `[queue] DEPTH CAP: ${job.name} dropped — queue at ${pending.length}/${DAEMON.maxQueueDepth}`);
      return false;
    }

    // Insert by priority
    const jobPriority = PRIORITY_ORDER[job.priority as Priority] ?? PRIORITY_ORDER.normal;
    let inserted = false;
    for (let i = 0; i < pending.length; i++) {
      const existingPriority = PRIORITY_ORDER[pending[i].priority as Priority] ?? PRIORITY_ORDER.normal;
      if (jobPriority < existingPriority) {
        pending.splice(i, 0, job);
        inserted = true;
        break;
      }
    }
    if (!inserted) pending.push(job);

    const resources = job.resources || [];
    const pri = job.priority || 'normal';
    if (pri === 'high' || pri === 'critical') {
      log('INFO', `[queue] Enqueued ${pri.toUpperCase()}: ${job.name}${resources.length ? ` [${resources.join('+')}]` : ''} (pending: ${pending.length}, running: ${running.size})`);
    } else {
      log('DEBUG', `[queue] Enqueued: ${job.name}${resources.length ? ` [${resources.join('+')}]` : ''} (pending: ${pending.length}, running: ${running.size})`);
    }

    // Try to start jobs immediately
    processQueue();
    return true;
  }

  function drain(timeoutMs: number = DAEMON.drainTimeoutMs || 10000): Promise<void> {
    if (running.size === 0 && pending.length === 0) return Promise.resolve();
    draining = true;
    return new Promise((resolve) => {
      drainResolve = resolve;
      const timer = setTimeout(() => {
        log('WARN', `[queue] Drain timeout after ${timeoutMs}ms — ${pending.length} pending, running: ${[...running.keys()].join(', ') || 'none'}`);
        pending.length = 0;
        draining = false;
        resolve();
      }, timeoutMs);
      timer.unref();
    });
  }

  return {
    enqueue,
    hasPending(name: string): boolean { return pending.some(p => p.name === name) || running.has(name); },
    drain,
    get depth() { return pending.length; },
    get currentJob() { return running.size > 0 ? [...running.keys()][0] : null; }, // Backward compat
    get isRunning() { return running.size > 0; },
    get status() {
      return {
        running: [...running.keys()],
        pending: pending.length,
        resources: Object.fromEntries(
          Object.entries(RESOURCE_POOLS).map(([k, v]) => [k, { capacity: v.capacity, inUse: v.inUse }])
        ),
      };
    },
  };
}

module.exports = { createJobQueue, RESOURCE_POOLS };
