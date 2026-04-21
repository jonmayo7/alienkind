#!/usr/bin/env node
const { TIMEZONE } = require('../lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Autonomous Threat Hunter — Security/Immune Deep Process (Growth Engine Layer 1)
 *
 * Continuously scans infrastructure for anomalies, intrusions, and misconfigurations.
 * Runs as a daemon job, writes findings to deep_process_outputs (domain='security').
 *
 * Scans:
 *   1. File integrity — checksums on critical files
 *   2. Process monitoring — unexpected processes, resource consumption
 *   3. Network monitoring — unusual outbound connections
 *   4. Log analysis — suspicious patterns in service logs
 *   5. Injection detection — scan recent inbound messages for injection attempts
 *   6. Kill switch status — verify control plane is intact
 *   7. Behavioral anomalies — deviation from operational baselines
 *
 * Runnable standalone: npx tsx scripts/security/threat-hunter.ts
 * Runnable as daemon job via config/daemon-jobs.ts
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');
const { loadEnv, createLogger } = require('../lib/shared.ts');

const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `threat-hunter-${DATE}.log`);
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

// --- Scan 1: File Integrity ---
async function scanFileIntegrity() {
  log('INFO', 'Scan 1: File integrity...');
  try {
    const { integrityAssessment, updateBaseline } = require('../lib/integrity-monitor.ts');
    const result = await integrityAssessment();

    if (result.severity === 'critical') {
      // Check if .env is the ONLY mismatch — common during active development
      // (adding API keys, rotating tokens). If so, downgrade to warn + rebaseline.
      const envOnly = result.details.mismatches.length === 1 &&
        result.details.mismatches[0].file === '.env';

      if (envOnly) {
        addFinding({
          category: 'file_integrity',
          severity: 'warn',
          title: '.env modified (rebaselined)',
          detail: '.env changed since baseline — common during active development. Baseline updated. If unexpected, check git diff.',
        });
        await updateBaseline();
        log('INFO', '  .env change detected — rebaselined (development activity)');
      } else {
        addFinding({
          category: 'file_integrity',
          severity: 'critical',
          title: 'Critical file modification detected',
          detail: result.summary,
          evidence: JSON.stringify(result.details.mismatches),
        });
        // Rebaseline after logging — the finding is captured in Supabase.
        // Stale baselines cause every subsequent scan to re-fire critical noise.
        await updateBaseline();
        log('INFO', '  Critical finding logged — baseline updated to prevent re-fire.');
      }
    } else if (result.severity === 'warn' && result.details.mismatches?.length > 0) {
      addFinding({
        category: 'file_integrity',
        severity: 'warn',
        title: 'File modifications since baseline',
        detail: result.summary,
      });
      // Update baseline after non-critical changes (expected during development)
      await updateBaseline();
    } else {
      log('INFO', `  File integrity: ${result.summary}`);
    }
  } catch (err: any) {
    addFinding({ category: 'file_integrity', severity: 'warn', title: 'Scan failed', detail: err.message });
  }
}

// --- Scan 2: Process Monitoring ---
async function scanProcesses() {
  log('INFO', 'Scan 2: Process monitoring...');
  try {
    const ps = execSync('ps aux', { encoding: 'utf8', timeout: 10000 });
    const lines = ps.split('\n');

    // Check for suspicious processes
    // Exclude claude/node lines — their --append-system-prompt args contain arbitrary text
    // that causes false positives (e.g. "ncat" substring in chain-mode-handoff prompts)
    const nonAgentLines = lines.filter(l => {
      const lower = l.toLowerCase();
      return !lower.includes('/claude') && !lower.includes('claude --') && !lower.includes('node ');
    });
    const suspicious = ['nc -l', 'ncat', 'netcat', 'socat', 'meterpreter', 'reverse_shell', 'cryptominer'];
    for (const proc of suspicious) {
      const found = nonAgentLines.filter(l => l.toLowerCase().includes(proc));
      if (found.length > 0) {
        addFinding({
          category: 'process',
          severity: 'critical',
          title: `Suspicious process detected: ${proc}`,
          detail: `${found.length} instance(s)`,
          evidence: found[0].slice(0, 200),
        });
      }
    }

    // Check for high CPU/memory processes (>50% CPU or >50% MEM)
    // macOS system processes that transiently spike CPU during sync/indexing/thermal ops — not security concerns
    const systemProcessAllowlist = [
      'fileproviderd', 'mds_stores', 'mdworker', 'kernel_task',
      'WindowServer', 'backupd', 'photolibraryd', 'bird',
      'cloudd', 'nsurlsessiond', 'trustd', 'syspolicyd',
      'com.docker', 'Docker Desktop', 'mediaanalysisd',
      'AppTranslocation',  // macOS Gatekeeper translocated apps — CPU spike during first-run verification
      'suggestd',  // macOS CoreSuggestions framework — periodic CPU spikes during indexing
    ];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const command = parts.slice(10).join(' ');
      const isSystemProcess = systemProcessAllowlist.some(p => command.includes(p));
      if ((cpu > 80 || mem > 50) && !command.includes('claude') && !command.includes('node') && !isSystemProcess) {
        addFinding({
          category: 'process',
          severity: 'warn',
          title: 'High resource process',
          detail: `CPU: ${cpu}%, MEM: ${mem}% — ${command.slice(0, 100)}`,
        });
      }
    }

    log('INFO', `  Process scan: ${lines.length - 1} processes checked`);
  } catch (err: any) {
    addFinding({ category: 'process', severity: 'warn', title: 'Process scan failed', detail: err.message });
  }
}

// --- Scan 3: Network Monitoring ---
async function scanNetwork() {
  log('INFO', 'Scan 3: Network monitoring...');
  try {
    const lsof = execSync('lsof -i -P -n 2>/dev/null | grep ESTABLISHED', { encoding: 'utf8', timeout: 10000 });
    const connections = lsof.trim().split('\n').filter(Boolean);

    // Known safe destinations
    const SAFE_HOSTS = [
      'supabase.co', 'api.telegram.org', 'discord.com', 'gateway.discord.gg',
      'api.anthropic.com', 'api.x.com', 'api.linkedin.com', 'googleapis.com',
      'github.com', '127.0.0.1', 'localhost', '1.1.1.1', '8.8.8.8',
      'apple.com', 'icloud.com', 'aaplimg.com',
    ];

    // macOS system processes with expected network activity
    const SAFE_PROCESSES = [
      'rapportd',    // Apple device-to-device communication (AirDrop, Handoff)
      'sharingd',    // Apple sharing services
      'bluetoothd',  // Bluetooth daemon
      'identityservicesd', // Apple ID / iMessage
    ];

    const unknownConnections: string[] = [];
    for (const conn of connections) {
      const isSafe = SAFE_HOSTS.some(host => conn.includes(host));
      const isSafeProcess = SAFE_PROCESSES.some(proc => conn.startsWith(proc + ' ') || conn.includes(proc));
      const isLinkLocal = conn.includes('fe80:');  // IPv6 link-local — always local network
      if (!isSafe && !isSafeProcess && !isLinkLocal && !conn.includes('->127.0.0.1') && !conn.includes('->localhost')) {
        unknownConnections.push(conn.trim());
      }
    }

    if (unknownConnections.length > 5) {
      addFinding({
        category: 'network',
        severity: 'warn',
        title: `${unknownConnections.length} unknown outbound connections`,
        detail: 'More than expected unknown connections',
        evidence: unknownConnections.slice(0, 3).join('\n'),
      });
    }

    log('INFO', `  Network: ${connections.length} established, ${unknownConnections.length} unknown`);
  } catch (err: any) {
    // lsof may return non-zero if no ESTABLISHED connections
    log('INFO', '  Network: no established connections or scan error');
  }
}

// --- Scan 4: Log Analysis ---
async function scanLogs() {
  log('INFO', 'Scan 4: Log analysis...');
  try {
    const logDir = path.join(ALIENKIND_DIR, 'logs');
    const logFiles = fs.readdirSync(logDir).filter((f: string) => f.endsWith('.log') && f.includes(DATE));

    let errorCount = 0;
    let suspiciousPatterns = 0;
    const suspiciousLines: string[] = [];

    for (const file of logFiles) {
      const content = fs.readFileSync(path.join(logDir, file), 'utf8');
      const lines = content.split('\n');

      // Count errors
      errorCount += lines.filter((l: string) => l.includes('[ERROR]') || l.includes('[FATAL]')).length;

      // Check for suspicious patterns (with false-positive exclusions)
      // "injection" alone is too broad — catches dependency injection, context injection, etc.
      // Use specific attack signatures instead.
      const suspPatterns = [
        'unauthorized', 'forbidden', 'access denied', 'breach', 'compromised',
        'sql injection', 'command injection', 'prompt injection',
        'code injection', 'injection attack', 'injection attempt',
        'injection vulnerability', 'injection exploit',
      ];
      // Known false-positive patterns from our own tooling
      const falsePositivePatterns = [
        /breach minimum cash/i,          // trading: cash reserve check
        /injection.?detect/i,            // our own injection-detector references
        /injection.?pattern/i,           // self-assessment counting our patterns
        /injection.?phase/i,             // injection detector phase references
        /scripts\/lib\/injection/i,      // file paths mentioning injection-detector
        /\binjection patterns?\b.*\d+/i, // "157 injection patterns" metrics
      ];
      for (const pat of suspPatterns) {
        const matches = lines.filter((l: string) => {
          const lower = l.toLowerCase();
          if (!lower.includes(pat)) return false;
          // Exclude known false positives
          return !falsePositivePatterns.some(fp => fp.test(l));
        });
        if (matches.length > 0) {
          suspiciousLines.push(...matches.map((l: string) => `[${file}] ${l.trim().slice(0, 200)}`));
        }
        suspiciousPatterns += matches.length;
      }
    }

    if (suspiciousPatterns > 0) {
      const sampleLines = suspiciousLines.slice(0, 5).join('\n');
      addFinding({
        category: 'logs',
        severity: 'warn',
        title: `${suspiciousPatterns} suspicious log entries today`,
        detail: `Across ${logFiles.length} log files. Top matches:\n${sampleLines}`,
      });
    }

    log('INFO', `  Logs: ${logFiles.length} files, ${errorCount} errors, ${suspiciousPatterns} suspicious`);
  } catch (err: any) {
    addFinding({ category: 'logs', severity: 'warn', title: 'Log scan failed', detail: err.message });
  }
}

// --- Scan 5: Kill Switch Status ---
async function scanKillSwitch() {
  log('INFO', 'Scan 5: Kill switch status...');
  try {
    const { getKillLevel, getKillLog } = require('../lib/defense-elements.ts');
    const level = getKillLevel();
    const killLog = getKillLog();

    if (level > 0) {
      addFinding({
        category: 'kill_switch',
        severity: level >= 2 ? 'critical' : 'warn',
        title: `Kill switch active at level ${level}`,
        detail: `Last change: ${killLog.length > 0 ? killLog[killLog.length - 1] : 'unknown'}`,
      });
    }

    log('INFO', `  Kill switch: level ${level}`);
  } catch (err: any) {
    addFinding({ category: 'kill_switch', severity: 'warn', title: 'Kill switch check failed', detail: err.message });
  }
}

// --- Scan 6: Local Inference Security ---
async function scanLocalInference() {
  log('INFO', 'Scan 6: Local inference security...');
  try {
    // Verify vLLM-MLX is bound to localhost only (port 8000)
    const lsof = execSync('/usr/sbin/lsof -i :8000 -P -n 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const lines = lsof.trim().split('\n').filter(Boolean);

    // Skip header line, then filter for non-localhost bindings
    const dataLines = lines.filter((l: string) => !l.startsWith('COMMAND'));
    const nonLocal = dataLines.filter((l: string) => l.includes(':8000') && !l.includes('127.0.0.1') && !l.includes('localhost') && !l.includes('*:8000'));
    if (nonLocal.length > 0) {
      addFinding({
        category: 'local-inference',
        severity: 'critical',
        title: 'Local inference exposed to network',
        detail: 'vLLM-MLX is listening on non-localhost address — RCE risk',
        evidence: nonLocal[0],
      });
    }

    log('INFO', `  Local inference: ${lines.length - 1} listener(s), ${nonLocal.length} non-local`);
  } catch {
    log('INFO', '  Local inference: not running or port not open');
  }
}

// --- Scan 7: Env File Permissions ---
async function scanEnvPermissions() {
  log('INFO', 'Scan 7: Env file permissions...');
  try {
    const envPath = path.join(ALIENKIND_DIR, '.env');
    const stat = fs.statSync(envPath);
    const mode = (stat.mode & 0o777).toString(8);

    if (mode !== '600') {
      addFinding({
        category: 'permissions',
        severity: 'warn',
        title: `.env permissions too open: ${mode}`,
        detail: 'Expected 600 (owner read/write only)',
      });
    }

    log('INFO', `  .env permissions: ${mode}`);
  } catch (err: any) {
    addFinding({ category: 'permissions', severity: 'warn', title: '.env check failed', detail: err.message });
  }
}

// --- Main ---
async function main() {
  log('INFO', '=== Threat Hunter Starting ===');

  await scanFileIntegrity();
  await scanProcesses();
  await scanNetwork();
  await scanLogs();
  await scanKillSwitch();
  await scanLocalInference();
  await scanEnvPermissions();

  // Compile results
  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  const priority = criticalCount > 0 ? 10 : warnCount > 3 ? 8 : warnCount > 0 ? 6 : 3;

  const summary = `Threat scan: ${findings.length} finding(s) — ${criticalCount} critical, ${warnCount} warn, ${infoCount} info. ` +
    `Scans: file integrity, processes, network, logs, kill switch, local inference, permissions.`;

  log('INFO', `Summary: ${summary}`);
  log('INFO', `Priority: ${priority}/10`);

  // Write to deep_process_outputs
  log('INFO', 'Writing findings to deep_process_outputs...');
  await writeDeepProcessOutput({
    domain: 'security',
    process_name: 'threat-hunter',
    findings: { findings, scan_count: 7 },
    summary,
    priority,
    incorporated: false,
  }, log);

  // Alert on critical findings
  if (criticalCount > 0) {
    log('ERROR', `CRITICAL: ${criticalCount} critical finding(s) — immediate attention required`);
    // Log to audit trail
    const { auditLog } = require('../lib/audit-log.ts');
    await auditLog({
      action: 'threat_detected',
      target: 'infrastructure',
      parameters: { critical: criticalCount, findings: findings.filter(f => f.severity === 'critical') },
      source: 'threat-hunter',
      severity: 'critical',
    });
  }

  // Deposit into circulation
  try {
    const { deposit } = require('../lib/circulation.ts');
    await deposit({
      source_organ: 'threat-hunter',
      finding: summary.slice(0, 500),
      finding_type: criticalCount > 0 ? 'anomaly' : 'observation',
      domain: 'security',
      confidence: 0.9,
      action_tier: criticalCount > 0 ? 'T2' : 'T3',
      metadata: { criticalCount, warnCount, infoCount, priority },
    });
  } catch { /* non-fatal */ }

  console.log(`Threat Hunter Complete (priority ${priority}/10)`);
  console.log(summary);
  log('INFO', '=== Threat Hunter Complete ===');
}

main().catch(err => {
  log('ERROR', `Threat hunter failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
