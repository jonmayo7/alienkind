#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Infrastructure Watch Working Group
 *
 * Monitors Studios, model servers, daemon jobs, memory.
 * Identifies degradation before failure. Logs issues to daily file + circulation.
 * Does NOT create preview branches — infra issues need immediate visibility.
 * Uses studio2-daily (35B) only — no Opus needed for monitoring.
 *
 * Runs nightly via daemon-jobs.ts.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadEnv, createLogger } = require('./lib/shared.ts');
const { logToDaily, getNowCT } = require('./lib/keel-env.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..');
Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));

const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const DATE = new Date().toISOString().split('T')[0];
const { log } = createLogger(path.join(LOG_DIR, `working-group-infra-${DATE}.log`));

const { supabaseGet } = require('./lib/supabase.ts');
const http = require('http');

interface Check { name: string; status: 'healthy' | 'degraded' | 'down'; detail: string; }

function pingPort(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request({ host, port, path: '/v1/models', timeout: 5000 }, (res: any) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function checkPorts(): Promise<Check[]> {
  const checks: Check[] = [];
  const ports = [
    { host: 'localhost', port: 8001, name: 'S1:27B' },
    { host: 'localhost', port: 8002, name: 'S1:vision' },
    { host: 'localhost', port: 8004, name: 'S1:embedding' },
    { host: '[LOCAL_HOST]', port: 8001, name: 'S2:35B' },
    { host: '[LOCAL_HOST]', port: 8002, name: 'S2:122B' },
    { host: '[LOCAL_HOST]', port: 8003, name: 'S2:vision' },
    { host: '[LOCAL_HOST]', port: 8004, name: 'S2:identity' },
    { host: '[LOCAL_HOST]', port: 8005, name: 'S2:embedding' },
  ];
  for (const p of ports) {
    const up = await pingPort(p.host, p.port);
    checks.push({ name: p.name, status: up ? 'healthy' : 'down', detail: `${p.host}:${p.port}` });
  }
  return checks;
}

async function checkMemory(): Promise<Check[]> {
  try {
    const vmStat = execSync('vm_stat', { encoding: 'utf8', timeout: 5000 });
    const freeMatch = vmStat.match(/Pages free:\s+(\d+)/);
    if (freeMatch) {
      const freeGB = (parseInt(freeMatch[1]) * 16384) / 1024 / 1024 / 1024;
      return [{ name: 'S1:memory', status: freeGB < 5 ? 'degraded' : 'healthy', detail: `${freeGB.toFixed(1)}GB free` }];
    }
  } catch {}
  return [];
}

async function run() {
  log('INFO', '=== Infrastructure Watch Starting ===');

  const [ports, mem] = await Promise.all([checkPorts(), checkMemory()]);
  const all = [...ports, ...mem];
  const problems = all.filter(c => c.status !== 'healthy');

  for (const c of all) log(c.status === 'healthy' ? 'DEBUG' : 'WARN', `${c.name}: ${c.status} — ${c.detail}`);

  if (problems.length > 0) {
    const time = getNowCT();
    logToDaily(`### Infrastructure Watch (${time} CDT)\n${problems.map(p => `- ${p.name}: ${p.status} — ${p.detail}`).join('\n')}`, undefined, false);

    try {
      const { deposit } = require('./lib/circulation.ts');
      for (const p of problems) {
        await deposit({ source_organ: 'infra-watch', finding: `${p.name}: ${p.detail}`, finding_type: 'anomaly', domain: 'infrastructure', confidence: 0.9, action_tier: p.status === 'down' ? 'tier2' : 'tier3' }).catch(() => {});
      }
    } catch {}
  }

  log('INFO', `=== Infrastructure Watch Complete: ${all.length} checks, ${problems.length} issues ===`);
}

run().catch(e => { log('ERROR', `Fatal: ${e.message}`); process.exit(1); });
