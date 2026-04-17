/**
 * ACTIVATE Gate — verifies infrastructure config is live before allowing commits.
 *
 * Prevents the Phase 5.2 failure: code committed but daemon running old config.
 * Called by every script that runs `git commit` — both Claude Code hooks
 * (guard-bash.sh Gate 8) and direct node scripts (auto-commit, dependency-updater,
 * nightly/immune, keel-research, intent-audit).
 *
 * Substrate-independent: works from Claude Code, any API, any local model.
 * The gate checks file modification times vs daemon process start time.
 * No Claude Code dependency. Pure Node.js.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { launchctlRunning } = require('./service-health.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

// Files that require daemon restart when modified
// Files the daemon loads ONCE at startup. Changes to these require daemon restart.
// Regular job scripts (crypto-engine.ts, morning-brief.ts, etc.) are forked as
// fresh node processes each run and pick up changes automatically.
const INFRA_FILES = [
  path.join(ALIENKIND_DIR, 'config', 'daemon-jobs.ts'),
  path.join(ALIENKIND_DIR, 'scripts', 'lib', 'constants.ts'),
  path.join(ALIENKIND_DIR, 'scripts', 'daemon.ts'),
  path.join(ALIENKIND_DIR, 'scripts', 'lib', 'scheduler.ts'),
  path.join(ALIENKIND_DIR, 'scripts', 'lib', 'job-queue.ts'),
  path.join(ALIENKIND_DIR, 'scripts', 'lib', 'session-manager.ts'),
];

// Also check any plist files in config/
const PLIST_GLOB = path.join(ALIENKIND_DIR, 'config');

interface ActivateResult {
  passed: boolean;
  reason: string;
  staleFiles: string[];
}

/**
 * Check if any infrastructure config files have been modified since the daemon last started.
 * Returns { passed: true } if safe to commit, or { passed: false, reason, staleFiles } if not.
 */
function checkActivateGate(): ActivateResult {
  // Collect all infrastructure files to check
  const filesToCheck = [...INFRA_FILES];

  // Add Studio-1-side plist files from config/
  // Studio 2 plists (com.example.studio2-*) are managed by launchd ON Studio 2,
  // not by the Studio 1 daemon. They have their own activation path
  // (bootstrap on secondary host + interconnect regression suite).
  // Including them here would force a Studio 1 daemon restart for changes
  // the Studio 1 daemon doesn't load. False positive.
  try {
    const configDir = path.join(ALIENKIND_DIR, 'config');
    const configFiles = fs.readdirSync(configDir);
    for (const f of configFiles) {
      if (f.endsWith('.plist') && f.startsWith('com.example.') && !f.startsWith('com.example.studio2-')) {
        filesToCheck.push(path.join(configDir, f));
      }
    }
  } catch { /* config dir read failure is non-fatal */ }

  // Get daemon PID and start time
  let daemonPid: number | undefined;
  let daemonEpoch = 0;
  try {
    const daemonStatus = launchctlRunning('com.example.daemon');
    daemonPid = daemonStatus.pid;
    if (daemonStatus.running && daemonPid) {
      const lstart = execSync(`ps -p ${daemonPid} -o lstart=`, { encoding: 'utf8', timeout: 5000 }).trim();
      const startDate = new Date(lstart);
      daemonEpoch = Math.floor(startDate.getTime() / 1000);
    }
  } catch { /* daemon check failure */ }

  if (!daemonPid) {
    // Daemon not running — check if any infra files exist and are staged
    const hasInfraChanges = filesToCheck.some(f => fs.existsSync(f));
    if (hasInfraChanges) {
      return {
        passed: false,
        reason: 'Daemon is not running. Infrastructure config exists but daemon is down.',
        staleFiles: [],
      };
    }
    return { passed: true, reason: 'No daemon, no infra files', staleFiles: [] };
  }

  // Check each infrastructure file's mtime against daemon start
  const staleFiles: string[] = [];
  for (const filePath of filesToCheck) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      const fileMtime = Math.floor(stat.mtimeMs / 1000);
      if (fileMtime > daemonEpoch) {
        staleFiles.push(path.relative(ALIENKIND_DIR, filePath));
      }
    } catch { /* stat failure is non-fatal */ }
  }

  if (staleFiles.length > 0) {
    return {
      passed: false,
      reason: `Infrastructure config modified after daemon started. Daemon is running stale config. Restart daemon before committing.\nStale files: ${staleFiles.join(', ')}`,
      staleFiles,
    };
  }

  return { passed: true, reason: 'Daemon is running config newer than all infrastructure files', staleFiles: [] };
}

module.exports = { checkActivateGate, INFRA_FILES };
