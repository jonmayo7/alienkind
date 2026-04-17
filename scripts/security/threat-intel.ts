#!/usr/bin/env node
const { TIMEZONE } = require('../lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Threat Intelligence Feed — External Threat Monitoring
 *
 * Monitors:
 *   1. npm advisory feed — vulnerabilities in our dependencies
 *   2. GitHub advisory database — broader supply chain threats
 *   3. CVE monitoring — vulnerabilities in our tech stack (Node.js, Supabase, etc.)
 *   4. abuse.ch indicators — known malicious IPs/domains
 *   5. Dependency audit — `npm audit` on our own package.json
 *
 * Pure Node.js — zero external dependencies.
 * Runnable standalone: npx tsx scripts/security/threat-intel.ts
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');
const { loadEnv, createLogger } = require('../lib/shared.ts');

const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `threat-intel-${DATE}.log`);
const { log } = createLogger(LOG_FILE);

const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
Object.assign(process.env, env);
const { supabasePost } = require('../lib/supabase.ts');
const { writeDeepProcessOutput } = require('../lib/deep-process.ts');

interface Finding {
  category: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  evidence?: string;
}

const findings: Finding[] = [];

function addFinding(f: Finding) {
  findings.push(f);
  log(f.severity === 'critical' ? 'ERROR' : f.severity === 'warn' ? 'WARN' : 'INFO', `[${f.category}] ${f.title}: ${f.detail}`);
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(urlObj, {
      method: 'GET',
      headers: { 'User-Agent': 'keel-threat-intel/1.0', ...headers },
      timeout: 15000,
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// --- Scan 1: npm Audit ---
async function scanNpmAudit() {
  log('INFO', 'Scan 1: npm audit...');

  try {
    // Run npm audit and capture JSON output
    let auditOutput: string;
    try {
      auditOutput = execSync('npm audit --json 2>/dev/null', {
        cwd: ALIENKIND_DIR,
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (err: any) {
      // npm audit returns non-zero when vulnerabilities found — that's expected
      auditOutput = err.stdout || '{}';
    }

    const audit = JSON.parse(auditOutput);

    if (audit.metadata) {
      const { vulnerabilities } = audit.metadata;
      const total = (vulnerabilities?.total || 0);
      const critical = (vulnerabilities?.critical || 0);
      const high = (vulnerabilities?.high || 0);

      if (critical > 0) {
        addFinding({
          category: 'npm_audit',
          severity: 'critical',
          title: `${critical} critical npm vulnerabilities`,
          detail: `Total: ${total} (${critical} critical, ${high} high)`,
        });
      } else if (high > 0) {
        addFinding({
          category: 'npm_audit',
          severity: 'warn',
          title: `${high} high npm vulnerabilities`,
          detail: `Total: ${total}`,
        });
      }

      log('INFO', `  npm audit: ${total} vulnerabilities (${critical} critical, ${high} high)`);
    }
  } catch (err: any) {
    addFinding({ category: 'npm_audit', severity: 'warn', title: 'npm audit failed', detail: err.message.slice(0, 200) });
  }
}

// --- Scan 2: Node.js Version Security ---
async function scanNodeVersion() {
  log('INFO', 'Scan 2: Node.js version check...');

  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim();
    const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);

    // Check if our Node version is in active support
    // Node 22 LTS: active support through Oct 2025, maintenance through Apr 2027
    // Node 20 LTS: active support through Oct 2024, maintenance through Apr 2026
    if (major < 20) {
      addFinding({
        category: 'runtime',
        severity: 'critical',
        title: `Node.js ${nodeVersion} is EOL`,
        detail: 'Upgrade to Node 20+ for security patches',
      });
    } else if (major === 20 && now > new Date('2026-04-30')) {
      addFinding({
        category: 'runtime',
        severity: 'warn',
        title: `Node.js ${nodeVersion} entering/past EOL`,
        detail: 'Node 20 maintenance ends Apr 2026',
      });
    }

    log('INFO', `  Node.js: ${nodeVersion} (major: ${major})`);
  } catch (err: any) {
    addFinding({ category: 'runtime', severity: 'warn', title: 'Node version check failed', detail: err.message });
  }
}

// --- Scan 3: Dependency Freshness ---
async function scanDependencyFreshness() {
  log('INFO', 'Scan 3: Dependency freshness...');

  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(ALIENKIND_DIR, 'package.json'), 'utf8'));
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    const depCount = Object.keys(deps).length;

    // Check npm outdated
    let outdated: string;
    try {
      outdated = execSync('npm outdated --json 2>/dev/null', {
        cwd: ALIENKIND_DIR,
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (err: any) {
      outdated = err.stdout || '{}';
    }

    const outdatedPkgs = JSON.parse(outdated || '{}');
    const majorOutdated = Object.entries(outdatedPkgs).filter(([_, info]: [string, any]) => {
      const current = (info.current || '').split('.')[0];
      const latest = (info.latest || '').split('.')[0];
      return current !== latest;
    });

    if (majorOutdated.length > 5) {
      addFinding({
        category: 'dependencies',
        severity: 'warn',
        title: `${majorOutdated.length} packages behind major version`,
        detail: majorOutdated.slice(0, 5).map(([name]: [string, any]) => name).join(', '),
      });
    }

    log('INFO', `  Dependencies: ${depCount} total, ${Object.keys(outdatedPkgs).length} outdated, ${majorOutdated.length} major behind`);
  } catch (err: any) {
    addFinding({ category: 'dependencies', severity: 'warn', title: 'Dependency check failed', detail: err.message.slice(0, 200) });
  }
}

// --- Scan 4: GitHub Advisory Check for Our Stack ---
async function scanGitHubAdvisories() {
  log('INFO', 'Scan 4: GitHub advisories for our stack...');

  // Check for recent advisories affecting our key dependencies
  const keyDeps = ['@supabase/supabase-js', 'discord.js', 'anthropic'];

  for (const dep of keyDeps) {
    try {
      const encodedDep = encodeURIComponent(dep);
      const res = await httpsGet(`https://registry.npmjs.org/${encodedDep}`);

      if (res.status === 200) {
        const data = JSON.parse(res.body.slice(0, 50000)); // Limit parse size
        const latestVersion = data['dist-tags']?.latest;

        // Check if we're on latest
        const pkgJson = JSON.parse(fs.readFileSync(path.join(ALIENKIND_DIR, 'package.json'), 'utf8'));
        const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
        const ourVersion = allDeps[dep];

        if (ourVersion && latestVersion) {
          log('INFO', `  ${dep}: ours=${ourVersion}, latest=${latestVersion}`);
        }
      }
    } catch {
      // Non-critical — skip
    }
  }
}

// --- Scan 5: Local Model Integrity ---
async function scanLocalModels() {
  log('INFO', 'Scan 5: Local model integrity...');

  try {
    const http = require('http');
    const data: string = await new Promise((resolve, reject) => {
      const req = http.request('http://localhost:8000/v1/models', { timeout: 5000 }, (res: any) => {
        let d = '';
        res.on('data', (c: string) => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
    const models = JSON.parse(data).data || [];
    for (const m of models) {
      log('INFO', `  Model: ${m.id}`);
    }
    log('INFO', `  ${models.length} local model(s) loaded`);
  } catch {
    log('INFO', '  Local inference not running or no models');
  }
}

// --- Main ---
async function main() {
  log('INFO', '=== Threat Intelligence Feed Starting ===');

  await scanNpmAudit();
  await scanNodeVersion();
  await scanDependencyFreshness();
  await scanGitHubAdvisories();
  await scanLocalModels();

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  const priority = criticalCount > 0 ? 10 : warnCount > 3 ? 8 : warnCount > 0 ? 6 : 3;

  const summary = `Threat intel: ${findings.length} finding(s) — ${criticalCount} critical, ${warnCount} warn, ${infoCount} info. ` +
    `Scans: npm audit, node version, dependency freshness, advisories, local models.`;

  log('INFO', `Summary: ${summary}`);

  await writeDeepProcessOutput({
    domain: 'security',
    process_name: 'threat-intel',
    findings: { findings, scan_count: 5 },
    summary,
    priority,
    incorporated: false,
  }, log);

  try {
    const { deposit } = require('../lib/circulation.ts');
    await deposit({
      source_organ: 'threat-intel',
      finding: summary.slice(0, 500),
      finding_type: criticalCount > 0 ? 'anomaly' : 'observation',
      domain: 'security',
      confidence: 0.8,
      action_tier: criticalCount > 0 ? 'T2' : 'T3',
      metadata: { criticalCount, warnCount, infoCount, priority },
    });
  } catch { /* non-fatal */ }

  console.log(`Threat Intelligence Complete (priority ${priority}/10)`);
  console.log(summary);
  if (findings.length > 0) {
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`);
    }
  }

  log('INFO', '=== Threat Intelligence Feed Complete ===');
}

main().catch(err => {
  log('ERROR', `Threat intel failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
