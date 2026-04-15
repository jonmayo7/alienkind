/**
 * Auto-Remediate — autonomous infrastructure repair for known issue patterns.
 *
 * Detect → Fix → Track. Every action logged to remediation_log table.
 * Runs as operator mode — can restart services, clear locks, rotate logs.
 * Cannot modify code or identity — escalates those to builder/analyst.
 *
 * Known patterns:
 *   1. Crashed listener (launchctl exit code != 0) → restart via launchctl
 *   2. Stale lock file (session-lock older than 30 min) → clear lock
 *   3. Bloated log file (> 50MB) → truncate to last 10K lines
 *
 * Writers: remediation_log (Supabase), logs/remediation.log
 * Readers: operational-pulse (calls runRemediation after detection)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { launchctlRunning } = require('./service-health.ts');

const KEEL_DIR = path.resolve(__dirname, '..', '..');

async function logRemediation(entry: {
  issue_type: string;
  issue_description: string;
  action_taken: string;
  mode: string;
  outcome: 'success' | 'failed' | 'escalated';
  escalation_reason?: string;
}): Promise<void> {
  try {
    const { supabasePost } = require('./supabase.ts');
    await supabasePost('remediation_log', entry);
  } catch {}
  try {
    fs.appendFileSync(path.join(KEEL_DIR, 'logs', 'remediation.log'),
      `[${new Date().toISOString()}] ${entry.outcome}: ${entry.issue_type} — ${entry.action_taken}\n`);
  } catch {}
}

async function remediateServices(log: (msg: string) => void): Promise<string[]> {
  const remediations: string[] = [];
  const services = ['com.example.telegram-listener', 'com.example.discord-listener', 'com.example.daemon', 'com.example.war-room'];

  for (const service of services) {
    try {
      const { running, pid } = launchctlRunning(service);

      if (!running) {
        log(`[remediate] ${service}: down (PID=${pid || '-'}). Restarting...`);
        try {
          execSync(`launchctl kickstart -k gui/$(id -u)/${service}`, { timeout: 10000, stdio: 'pipe' });
          remediations.push(`${service}: restarted`);
          await logRemediation({ issue_type: 'service_crash', issue_description: `${service} down (PID=${pid || '-'})`, action_taken: 'launchctl kickstart', mode: 'operator', outcome: 'success' });
        } catch (e: any) {
          await logRemediation({ issue_type: 'service_crash', issue_description: `${service} down`, action_taken: 'kickstart FAILED', mode: 'operator', outcome: 'failed', escalation_reason: e.message?.slice(0, 200) });
        }
      }
    } catch {}
  }
  return remediations;
}

async function remediateStaleLocks(log: (msg: string) => void): Promise<string[]> {
  const remediations: string[] = [];
  const lockFiles = [path.join(KEEL_DIR, 'logs', 'session-lock.json'), path.join(KEEL_DIR, 'logs', 'keel-session-lock.json')];

  for (const lockFile of lockFiles) {
    try {
      if (!fs.existsSync(lockFile)) continue;
      const ageMin = (Date.now() - fs.statSync(lockFile).mtimeMs) / 60000;
      if (ageMin > 30) {
        log(`[remediate] Stale lock: ${path.basename(lockFile)} (${Math.round(ageMin)}min). Clearing...`);
        fs.unlinkSync(lockFile);
        remediations.push(`${path.basename(lockFile)}: cleared`);
        await logRemediation({ issue_type: 'stale_lock', issue_description: `${path.basename(lockFile)} ${Math.round(ageMin)}min old`, action_taken: 'deleted', mode: 'operator', outcome: 'success' });
      }
    } catch {}
  }
  return remediations;
}

async function remediateLogs(log: (msg: string) => void): Promise<string[]> {
  const remediations: string[] = [];
  try {
    const logDir = path.join(KEEL_DIR, 'logs');
    for (const file of fs.readdirSync(logDir)) {
      if (!file.endsWith('.log') && !file.endsWith('.jsonl')) continue;
      const filePath = path.join(logDir, file);
      const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
      if (sizeMB > 50) {
        log(`[remediate] Bloated: ${file} (${Math.round(sizeMB)}MB). Truncating...`);
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        fs.writeFileSync(filePath, lines.slice(-10000).join('\n'));
        remediations.push(`${file}: truncated`);
        await logRemediation({ issue_type: 'log_bloat', issue_description: `${file} ${Math.round(sizeMB)}MB`, action_taken: 'truncated to 10K lines', mode: 'operator', outcome: 'success' });
      }
    }
  } catch {}
  return remediations;
}

async function runRemediation(log: (msg: string) => void): Promise<{ total: number; actions: string[] }> {
  const actions: string[] = [];
  actions.push(...await remediateServices(log));
  actions.push(...await remediateStaleLocks(log));
  actions.push(...await remediateLogs(log));

  // Deposit remediation actions into circulation
  if (actions.length > 0) {
    try {
      const { deposit } = require('./circulation.ts');
      await deposit({
        source_organ: 'auto-remediate',
        finding: `${actions.length} auto-fix(es): ${actions.join(', ')}`,
        finding_type: 'anomaly',
        domain: 'infrastructure',
        confidence: 0.9,
        action_tier: 'T1',
      });
    } catch { /* circulation unavailable — non-fatal */ }
  }

  return { total: actions.length, actions };
}

module.exports = { runRemediation, remediateServices, remediateStaleLocks, remediateLogs, logRemediation };
