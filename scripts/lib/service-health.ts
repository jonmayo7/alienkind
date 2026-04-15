/**
 * Service Health — single source of truth for service health checking.
 *
 * Every health check in the organism routes through this module.
 * Register a service once with its check function.
 * Call checkHealth('name') or checkAll() from anywhere.
 *
 * Uses alertOperator() for alerts and trackMetric() for trajectory.
 *
 * Usage:
 *   const { checkHealth, checkAll, getHealthSummary } = require('./lib/service-health.ts');
 *   const result = await checkHealth('studio1-daily');
 *   const all = await checkAll();
 *
 * Utilities exported for callers that need them:
 *   const { httpPing, processRunning, launchctlRunning } = require('./lib/service-health.ts');
 */

const http = require('http');
const { execSync, spawnSync } = require('child_process');

// ─── Types ──────────────────────────────────────────────────────

type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

interface HealthResult {
  service: string;
  status: HealthStatus;
  latencyMs: number;
  detail?: string;
  checkedAt: string;
}

interface ServiceDefinition {
  name: string;
  check: () => Promise<HealthResult>;
}

// ─── Utilities ──────────────────────────────────────────────────
// These are the primitives. Every health check in the organism should
// use these instead of rolling its own http.request or execSync.

function httpPing(host: string, port: number, pingPath: string = '/v1/models', timeoutMs: number = 5000): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request({ host, port, path: pingPath, method: 'GET', timeout: timeoutMs }, (res: any) => {
      // Drain response so socket doesn't hang
      res.resume();
      resolve({ ok: res.statusCode === 200, latencyMs: Date.now() - start });
    });
    req.on('error', () => resolve({ ok: false, latencyMs: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latencyMs: timeoutMs }); });
    req.end();
  });
}

function processRunning(pattern: string): boolean {
  try {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    return (result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

function launchctlRunning(label: string): { running: boolean; pid?: number } {
  try {
    const listResult = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = (listResult.stdout || '').split('\n').filter((l: string) => l.includes(label));
    if (lines.length === 0) return { running: false };
    const parts = lines[0].trim().split(/\s+/);
    const pid = parseInt(parts[0]);
    return { running: pid > 0, pid: pid > 0 ? pid : undefined };
  } catch {
    return { running: false };
  }
}

// ─── Service Registry ───────────────────────────────────────────

function makeHttpService(service: string, host: string, port: number, pingPath: string = '/v1/models'): ServiceDefinition {
  return {
    name: service,
    check: async () => {
      const { ok, latencyMs } = await httpPing(host, port, pingPath);
      return { service, status: ok ? 'healthy' : 'down', latencyMs, checkedAt: new Date().toISOString() };
    },
  };
}

function makeLaunchctlService(service: string, label: string): ServiceDefinition {
  return {
    name: service,
    check: async () => {
      const start = Date.now();
      const { running, pid } = launchctlRunning(label);
      return { service, status: running ? 'healthy' : 'down', latencyMs: Date.now() - start, detail: pid ? `PID ${pid}` : undefined, checkedAt: new Date().toISOString() };
    },
  };
}

const SERVICES: Record<string, ServiceDefinition> = {
  // Studio 1 (localhost)
  'studio1-daily':     makeHttpService('studio1-daily', 'localhost', 8001),
  'studio1-vision':    makeHttpService('studio1-vision', 'localhost', 8002),
  'studio1-embedding': makeHttpService('studio1-embedding', 'localhost', 8004, '/v1/embeddings'),
  // Studio 2 ([INTERCONNECT])
  'studio2-daily':     makeHttpService('studio2-daily', '[LOCAL_HOST]', 8001),
  'studio2-heavy':     makeHttpService('studio2-heavy', '[LOCAL_HOST]', 8002),
  'studio2-identity':  makeHttpService('studio2-identity', '[LOCAL_HOST]', 8004),
  // Infrastructure
  'ghost-bridge':      makeHttpService('ghost-bridge', 'localhost', 7777, '/health'),
  'searxng':           makeHttpService('searxng', 'localhost', 8080, '/search?q=ping&format=json'),
  // Launchd services
  'daemon':            makeLaunchctlService('daemon', 'com.example.daemon'),
  'telegram':          makeLaunchctlService('telegram', 'com.example.telegram'),
  'discord':           makeLaunchctlService('discord', 'com.example.discord'),
  'war-room':          makeLaunchctlService('war-room', 'com.example.war-room'),
  'nginx':             makeLaunchctlService('nginx', 'com.example.nginx'),
};

// ─── Core Functions ─────────────────────────────────────────────

async function checkHealth(serviceName: string): Promise<HealthResult> {
  const service = SERVICES[serviceName];
  if (!service) {
    return { service: serviceName, status: 'unknown', latencyMs: 0, detail: 'Not registered', checkedAt: new Date().toISOString() };
  }
  try {
    const result = await service.check();
    // Track in trajectory — 1 = healthy, 0.5 = degraded, 0 = down
    try {
      const { trackMetric } = require('./circulation.ts');
      trackMetric(`health.${serviceName}`, result.status === 'healthy' ? 1 : result.status === 'degraded' ? 0.5 : 0);
    } catch {}
    return result;
  } catch (err: any) {
    return { service: serviceName, status: 'down', latencyMs: 0, detail: err.message?.slice(0, 100), checkedAt: new Date().toISOString() };
  }
}

async function checkAll(): Promise<HealthResult[]> {
  const results = await Promise.all(Object.keys(SERVICES).map(checkHealth));
  return results;
}

async function getHealthSummary(): Promise<{ healthy: number; degraded: number; down: number; total: number; results: HealthResult[] }> {
  const results = await checkAll();
  return {
    healthy: results.filter(r => r.status === 'healthy').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    down: results.filter(r => r.status === 'down').length,
    total: results.length,
    results,
  };
}

function registerService(name: string, def: ServiceDefinition): void {
  SERVICES[name] = def;
}

function getRegisteredServices(): string[] {
  return Object.keys(SERVICES);
}

// ─── CLI ────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const serviceName = args.find(a => !a.startsWith('-'));

    if (serviceName) {
      const result = await checkHealth(serviceName);
      const icon = result.status === 'healthy' ? '✓' : result.status === 'degraded' ? '⚠' : '✗';
      console.log(`${icon} ${result.service}: ${result.status} (${result.latencyMs}ms)${result.detail ? ' — ' + result.detail : ''}`);
    } else {
      const summary = await getHealthSummary();
      console.log(`Health: ${summary.healthy}/${summary.total} healthy, ${summary.degraded} degraded, ${summary.down} down\n`);
      for (const r of summary.results) {
        const icon = r.status === 'healthy' ? '✓' : r.status === 'degraded' ? '⚠' : '✗';
        console.log(`  ${icon} ${r.service}: ${r.status} (${r.latencyMs}ms)${r.detail ? ' — ' + r.detail : ''}`);
      }
    }
  })();
}

module.exports = { checkHealth, checkAll, getHealthSummary, registerService, getRegisteredServices, httpPing, processRunning, launchctlRunning, makeHttpService, makeLaunchctlService };
