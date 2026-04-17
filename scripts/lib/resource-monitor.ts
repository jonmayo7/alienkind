// @alienkind-core
/**
 * Resource Monitor — read-only system primitives + opt-in reaping.
 *
 * Read-side (always available): memory, CPU load, process counts, partner
 * process listing, and a compact summary useful for the daemon's health
 * endpoint or a partner's self-knowledge ("how stressed is this machine
 * right now?").
 *
 * Write-side (OPT-IN, security-sensitive): killing processes based on
 * thresholds is a policy decision a forker needs to own. Keeping the interface
 * but throwing CapabilityUnavailable keeps the architecture honest without
 * shipping a process-reaper wired to defaults you didn't choose.
 *
 * Write helpers are enabled by setting PARTNER_ALLOW_REAPING=1 in .env plus
 * providing a reap-policy function via partner-config.json or the optional
 * setReapPolicy() helper. That two-step opt-in prevents accidental arming.
 */

const { execSync } = require('child_process');
const os = require('os');

const portable = require('./portable.ts');
const { CapabilityUnavailable, registerUnavailable } = portable;

// ============================================================================
// Types
// ============================================================================

export interface SystemResources {
  memoryTotalMB: number;
  memoryFreeMB: number;
  memoryUsedPct: number;
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
  processCount: number;
  platform: NodeJS.Platform;
  uptimeSec: number;
}

export interface PartnerProcess {
  pid: number;
  ppid: number;
  cpu: number;  // percent
  mem: number;  // percent
  command: string;
}

export interface ResourceCheckResult {
  ok: boolean;
  warnings: string[];
  critical: string[];
  resources: SystemResources;
  partnerProcesses: PartnerProcess[];
}

export interface ResourceCheckOptions {
  memoryWarnPct?: number;          // default 80
  memoryCriticalPct?: number;      // default 90
  loadWarn?: number;                // default cpuCount * 1.5
  loadCritical?: number;            // default cpuCount * 2.0
  processPattern?: RegExp;          // default matches claude/partner binaries
}

// ============================================================================
// Read primitives — always available
// ============================================================================

function getSystemResources(): SystemResources {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const load = os.loadavg();
  const cpus = os.cpus();

  let processCount = 0;
  try {
    const out = execSync('ps -ax -o pid= 2>/dev/null | wc -l', { encoding: 'utf8', timeout: 2000 }).trim();
    processCount = parseInt(out, 10) || 0;
  } catch { /* ok */ }

  return {
    memoryTotalMB: Math.round(totalMem / 1024 / 1024),
    memoryFreeMB: Math.round(freeMem / 1024 / 1024),
    memoryUsedPct: Math.round((usedMem / totalMem) * 100),
    load1: load[0] || 0,
    load5: load[1] || 0,
    load15: load[2] || 0,
    cpuCount: cpus.length,
    processCount,
    platform: os.platform(),
    uptimeSec: Math.round(os.uptime()),
  };
}

/**
 * Compact summary for logs and health endpoints. Cheaper than getSystemResources
 * — skips the ps | wc call — so suitable for frequent polling.
 */
function getResourceSummary(): { memPct: number; freeMB: number; load1: number; cpuCount: number } {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    memPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    freeMB: Math.round(freeMem / 1024 / 1024),
    load1: os.loadavg()[0] || 0,
    cpuCount: os.cpus().length,
  };
}

const DEFAULT_PARTNER_PATTERN = /claude|partner-runtime|alien-kind/i;

/**
 * List processes matching the partner pattern. Uses `ps aux` on Unix; empty
 * list on platforms where ps isn't available.
 */
function getPartnerProcesses(pattern: RegExp = DEFAULT_PARTNER_PATTERN): PartnerProcess[] {
  try {
    const out = execSync('ps -ax -o pid=,ppid=,pcpu=,pmem=,command= 2>/dev/null', {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const results: PartnerProcess[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const cpu = parseFloat(m[3]) || 0;
      const mem = parseFloat(m[4]) || 0;
      const command = m[5] || '';
      if (pattern.test(command)) {
        results.push({ pid, ppid, cpu, mem, command });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Pure check: is this PID protected from reaping?
 * A PID is protected if it matches the daemon itself (rootPid) or is a
 * parent of it — we never want to kill our own lineage.
 */
function isProtectedProcess(pid: number, rootPid: number): boolean {
  if (pid === rootPid) return true;
  try {
    const out = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim();
    const parentPid = parseInt(out, 10);
    if (!Number.isFinite(parentPid)) return false;
    if (parentPid === rootPid) return true; // direct child of root = protected
    return false;
  } catch {
    return true; // Unknown = err on the side of not killing
  }
}

// ============================================================================
// Threshold evaluator — reads, never acts
// ============================================================================

async function checkResources(opts: ResourceCheckOptions = {}): Promise<ResourceCheckResult> {
  const resources = getSystemResources();
  const memWarn = opts.memoryWarnPct ?? 80;
  const memCritical = opts.memoryCriticalPct ?? 90;
  const loadWarn = opts.loadWarn ?? resources.cpuCount * 1.5;
  const loadCritical = opts.loadCritical ?? resources.cpuCount * 2.0;
  const partnerPattern = opts.processPattern ?? DEFAULT_PARTNER_PATTERN;

  const warnings: string[] = [];
  const critical: string[] = [];

  if (resources.memoryUsedPct >= memCritical) {
    critical.push(`Memory ${resources.memoryUsedPct}% >= critical threshold ${memCritical}%`);
  } else if (resources.memoryUsedPct >= memWarn) {
    warnings.push(`Memory ${resources.memoryUsedPct}% >= warn threshold ${memWarn}%`);
  }

  if (resources.load1 >= loadCritical) {
    critical.push(`Load ${resources.load1.toFixed(2)} >= critical threshold ${loadCritical.toFixed(2)}`);
  } else if (resources.load1 >= loadWarn) {
    warnings.push(`Load ${resources.load1.toFixed(2)} >= warn threshold ${loadWarn.toFixed(2)}`);
  }

  const partnerProcesses = getPartnerProcesses(partnerPattern);

  return {
    ok: critical.length === 0,
    warnings,
    critical,
    resources,
    partnerProcesses,
  };
}

// ============================================================================
// Write helpers — opt-in, security-sensitive
// ============================================================================

function isReapingEnabled(): boolean {
  return process.env.PARTNER_ALLOW_REAPING === '1';
}

/**
 * Kill a process. OPT-IN only — requires PARTNER_ALLOW_REAPING=1.
 * Throws CapabilityUnavailable by default so forkers must explicitly arm this.
 */
function reapProcess(pid: number, log: (level: string, msg: string) => void = () => {}): boolean {
  if (!isReapingEnabled()) {
    registerUnavailable('process-reaping', {
      reason: 'Process reaping not armed',
      enableWith: 'Set PARTNER_ALLOW_REAPING=1 in .env. Do this only after reviewing your daemon configuration — auto-reap can kill processes you did not intend to kill.',
      docs: 'docs/capabilities/resource-monitor.md',
    });
    throw new CapabilityUnavailable(
      'process-reaping',
      'Set PARTNER_ALLOW_REAPING=1 in .env to enable process reaping. Review daemon thresholds first.',
      'docs/capabilities/resource-monitor.md',
    );
  }

  try {
    process.kill(pid, 'SIGTERM');
    log('INFO', `[resource-monitor] Sent SIGTERM to pid=${pid}`);
    // Escalate to SIGKILL if the process is still alive after 3s
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        // Still alive — escalate
        try { process.kill(pid, 'SIGKILL'); log('WARN', `[resource-monitor] SIGKILL pid=${pid}`); } catch { /* already dead */ }
      } catch {
        // Process exited — good
      }
    }, 3000);
    return true;
  } catch (err: any) {
    log('WARN', `[resource-monitor] reap pid=${pid} failed: ${err.message}`);
    return false;
  }
}

/**
 * Walk partner processes, kill any that aren't protected and exceed thresholds.
 * OPT-IN only. Caller supplies the reap-policy via opts — we don't ship defaults.
 */
async function cleanupStaleNodes(opts: {
  rootPid: number;
  shouldReap: (proc: PartnerProcess) => boolean;
  log?: (level: string, msg: string) => void;
}): Promise<{ reaped: number[]; skipped: number[] }> {
  if (!isReapingEnabled()) {
    registerUnavailable('process-reaping', {
      reason: 'Process reaping not armed',
      enableWith: 'Set PARTNER_ALLOW_REAPING=1 in .env. Review daemon thresholds first.',
      docs: 'docs/capabilities/resource-monitor.md',
    });
    throw new CapabilityUnavailable(
      'process-reaping',
      'Set PARTNER_ALLOW_REAPING=1 in .env to enable cleanupStaleNodes.',
    );
  }

  const log = opts.log || (() => {});
  const procs = getPartnerProcesses();
  const reaped: number[] = [];
  const skipped: number[] = [];

  for (const proc of procs) {
    if (isProtectedProcess(proc.pid, opts.rootPid)) {
      skipped.push(proc.pid);
      continue;
    }
    if (!opts.shouldReap(proc)) {
      skipped.push(proc.pid);
      continue;
    }
    if (reapProcess(proc.pid, log)) {
      reaped.push(proc.pid);
    } else {
      skipped.push(proc.pid);
    }
  }

  return { reaped, skipped };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Read primitives
  getSystemResources,
  getResourceSummary,
  getPartnerProcesses,
  isProtectedProcess,
  checkResources,
  // Write helpers (opt-in)
  reapProcess,
  cleanupStaleNodes,
  isReapingEnabled,
  // Defaults exposed for introspection/tests
  DEFAULT_PARTNER_PATTERN,
};
