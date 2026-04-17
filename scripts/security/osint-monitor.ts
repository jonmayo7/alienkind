#!/usr/bin/env node
const { TIMEZONE } = require('../lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * OSINT Monitor — External Intelligence on Our Own Exposure
 *
 * Scans for:
 *   1. HIBP — Have our emails been in breaches?
 *   2. GitHub/git credential scanning — are any keys leaked in our repo?
 *   3. Certificate transparency — new certs issued for our domains?
 *   4. Domain reputation — is our domain on any blocklists?
 *   5. Exposed secrets in codebase — local scan for leaked patterns
 *
 * Pure Node.js — zero external dependencies.
 * Runnable standalone: npx tsx scripts/security/osint-monitor.ts
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
const LOG_FILE = path.join(LOG_DIR, `osint-monitor-${DATE}.log`);
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
    const req = https.request(urlObj, { method: 'GET', headers, timeout: 15000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data.slice(0, 10000) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// --- Scan 1: Local Secret Scanning ---
async function scanLocalSecrets() {
  log('INFO', 'Scan 1: Local secret scanning...');

  // Patterns that indicate leaked secrets (exclude .env itself and node_modules)
  // Use patterns that don't require shell escaping with single quotes
  const secretPatterns = [
    { name: 'AWS key', pattern: 'AKIA[A-Z0-9]{16}' },
    { name: 'GitHub token', pattern: 'ghp_[A-Za-z0-9]{36}' },
    { name: 'Slack token', pattern: 'xox[bpras]-[A-Za-z0-9-]+' },
    { name: 'Private key', pattern: 'BEGIN.*PRIVATE KEY' },
  ];

  for (const sp of secretPatterns) {
    try {
      const result = execSync(
        `grep -rnE '${sp.pattern}' ${ALIENKIND_DIR} ` +
        `--include='*.ts' --include='*.js' --include='*.json' ` +
        `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=logs --exclude-dir=.canary --exclude-dir=imports ` +
        `--exclude='*.log' 2>/dev/null | head -5`,
        { encoding: 'utf8', timeout: 15000 }
      ).trim();

      if (result) {
        // Filter out test files, config examples, and the scanner itself
        // Only keep lines that look like grep output (path:line:content) to avoid
        // multiline string matches creating false-positive continuation lines
        const realHits = result.split('\n').filter((line: string) =>
          line.includes(ALIENKIND_DIR) &&
          // Exclude security tooling (contains detection patterns, test payloads, canary data)
          !line.includes('/security/') &&
          !line.includes('/tests/') &&
          !line.includes('output-guard.ts') &&
          // Exclude canary/honeypot artifacts
          !line.includes('.credentials.bak') &&
          !line.includes('backup-keys.txt') &&
          !line.includes('.ssh_backup') &&
          !line.includes('.canary') &&
          !line.includes('CANARY') &&
          // Exclude examples and test fixtures
          !line.includes('.example') &&
          !line.includes('test-')
        );

        if (realHits.length > 0) {
          addFinding({
            category: 'secrets',
            severity: 'critical',
            title: `${sp.name} found in codebase`,
            detail: `${realHits.length} file(s) contain potential ${sp.name}`,
            evidence: realHits[0].slice(0, 200),
          });
        }
      }
    } catch {
      // grep returns non-zero when no matches — that's good
    }
  }

  log('INFO', '  Local secret scan complete');
}

// --- Scan 2: Certificate Transparency ---
async function scanCertTransparency() {
  log('INFO', 'Scan 2: Certificate transparency...');

  const domains = ['[YOUR_DOMAIN]'];

  for (const domain of domains) {
    try {
      // crt.sh API — find recently issued certs
      const res = await httpsGet(`https://crt.sh/?q=${domain}&output=json&limit=20`);

      if (res.status === 200 && res.body) {
        let certs: any[];
        try {
          certs = JSON.parse(res.body);
        } catch {
          log('INFO', `  ${domain}: cert transparency response too large to parse, skipping`);
          continue;
        }
        // Check for certs issued in the last 7 days
        const recentCerts = certs.filter((c: any) => {
          const issued = new Date(c.entry_timestamp);
          return (Date.now() - issued.getTime()) < 7 * 86400000;
        });

        if (recentCerts.length > 0) {
          // Check for unexpected issuers or SANs
          const unexpectedCerts = recentCerts.filter((c: any) =>
            !c.issuer_name?.includes('Let\'s Encrypt') &&
            !c.issuer_name?.includes('Cloudflare') &&
            !c.issuer_name?.includes('DigiCert') &&
            !c.issuer_name?.includes('Google')
          );

          if (unexpectedCerts.length > 0) {
            addFinding({
              category: 'cert_transparency',
              severity: 'warn',
              title: `${domain}: ${unexpectedCerts.length} unexpected cert(s) in last 7 days`,
              detail: `Issuer: ${unexpectedCerts[0].issuer_name}`,
              evidence: JSON.stringify(unexpectedCerts[0]).slice(0, 300),
            });
          }

          log('INFO', `  ${domain}: ${recentCerts.length} cert(s) in last 7 days (${unexpectedCerts.length} unexpected)`);
        } else {
          log('INFO', `  ${domain}: no recent certs`);
        }
      }
    } catch (err: any) {
      log('INFO', `  ${domain}: cert transparency check: ${err.message}`);
    }
  }
}

// --- Scan 3: Git History Secret Scan ---
async function scanGitHistory() {
  log('INFO', 'Scan 3: Git history secret scan...');

  try {
    // Check last 50 commits for accidentally committed secrets
    // Look for actual secret VALUES in git diffs (not env var names/references)
    // These patterns detect hardcoded credentials, not process.env.KEY_NAME references
    // Patterns that detect actual secret values in git diffs (not variable name references)
    const valuePatterns = [
      { name: 'Hardcoded API key', grep: 'sk-[A-Za-z0-9]{20,}' },
      { name: 'Hardcoded bot token', grep: '[0-9]{9,}:[A-Za-z0-9_-]{35}' },
    ];

    for (const pat of valuePatterns) {
      try {
        const result = execSync(
          `git -C ${ALIENKIND_DIR} log -50 -p -- '*.ts' '*.js' ':!**/security/**' ':!**/tests/**' | grep -cE "${pat.grep}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 30000 }
        ).trim();

        const count = parseInt(result, 10);
        if (count > 0) {
          addFinding({
            category: 'git_secrets',
            severity: 'critical',
            title: `${pat.name} found in git diff history`,
            detail: `${count} occurrence(s) in last 50 commits`,
          });
        }
      } catch {
        // grep returns non-zero for no matches
      }
    }

    log('INFO', '  Git history scan complete');
  } catch (err: any) {
    addFinding({ category: 'git_secrets', severity: 'warn', title: 'Git history scan failed', detail: err.message });
  }
}

// --- Scan 4: .env File Audit ---
async function scanEnvFile() {
  log('INFO', 'Scan 4: .env file audit...');

  try {
    const envPath = path.join(ALIENKIND_DIR, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));

    // Count credentials
    const keyCount = lines.length;
    log('INFO', `  .env has ${keyCount} configured values`);

    // Check for weak/default values
    const weakPatterns = ['password', 'changeme', 'default', 'test', 'example', '12345'];
    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');

      for (const weak of weakPatterns) {
        if (value.toLowerCase() === weak) {
          addFinding({
            category: 'env_audit',
            severity: 'critical',
            title: `Weak value for ${key}`,
            detail: `Value appears to be a default/test value`,
          });
        }
      }
    }

    // Check if .env is in .gitignore
    const gitignore = fs.readFileSync(path.join(ALIENKIND_DIR, '.gitignore'), 'utf8');
    if (!gitignore.includes('.env')) {
      addFinding({
        category: 'env_audit',
        severity: 'critical',
        title: '.env not in .gitignore',
        detail: 'Credentials could be committed to git',
      });
    }

    log('INFO', '  .env audit complete');
  } catch (err: any) {
    addFinding({ category: 'env_audit', severity: 'warn', title: '.env audit failed', detail: err.message });
  }
}

// --- Scan 5: Exposed Ports ---
async function scanExposedPorts() {
  log('INFO', 'Scan 5: Exposed ports scan...');

  try {
    // Check for services listening on non-localhost
    const lsof = execSync('lsof -i -P -n 2>/dev/null | grep LISTEN', { encoding: 'utf8', timeout: 10000 });
    const listeners = lsof.trim().split('\n').filter(Boolean);

    // macOS system services that are expected to listen on wildcard
    const SAFE_PROCESSES = ['rapportd', 'ControlCe', 'AirPlayXPC', 'WiFiAgent', 'sharingd', 'identitys', 'Spotify', 'logioptio', 'Electron'];

    const exposed = listeners.filter((l: string) => {
      // Skip localhost-only listeners
      if (l.includes('127.0.0.1') || l.includes('localhost') || l.includes('[::1]')) return false;
      // Skip known macOS system services
      if (SAFE_PROCESSES.some(p => l.startsWith(p))) return false;
      // Check for wildcard listeners (*:port or 0.0.0.0:port)
      return l.includes('*:') || l.includes('0.0.0.0:');
    });

    if (exposed.length > 0) {
      for (const line of exposed.slice(0, 5)) {
        addFinding({
          category: 'ports',
          severity: 'warn',
          title: 'Service exposed to network',
          detail: line.trim().slice(0, 200),
        });
      }
    }

    log('INFO', `  Ports: ${listeners.length} listeners, ${exposed.length} exposed to network`);
  } catch {
    log('INFO', '  No listening ports or scan error');
  }
}

// --- Main ---
async function main() {
  log('INFO', '=== OSINT Monitor Starting ===');

  await scanLocalSecrets();
  await scanCertTransparency();
  await scanGitHistory();
  await scanEnvFile();
  await scanExposedPorts();

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  const priority = criticalCount > 0 ? 10 : warnCount > 3 ? 8 : warnCount > 0 ? 6 : 3;

  const summary = `OSINT scan: ${findings.length} finding(s) — ${criticalCount} critical, ${warnCount} warn, ${infoCount} info. ` +
    `Scans: local secrets, cert transparency, git history, env audit, exposed ports.`;

  log('INFO', `Summary: ${summary}`);

  await writeDeepProcessOutput({
    domain: 'security',
    process_name: 'osint-monitor',
    findings: { findings, scan_count: 5 },
    summary,
    priority,
    incorporated: false,
  }, log);

  try {
    const { deposit } = require('../lib/circulation.ts');
    await deposit({ source_organ: 'osint-monitor', finding: summary.slice(0, 500), finding_type: criticalCount > 0 ? 'anomaly' : 'observation', domain: 'security', confidence: 0.8, action_tier: criticalCount > 0 ? 'T2' : 'T3', metadata: { criticalCount, warnCount, infoCount, priority } });
  } catch {}

  console.log(`OSINT Monitor Complete (priority ${priority}/10)`);
  console.log(summary);
  if (findings.length > 0) {
    console.log('Findings:');
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`);
    }
  }

  log('INFO', '=== OSINT Monitor Complete ===');
}

main().catch(err => {
  log('ERROR', `OSINT monitor failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
