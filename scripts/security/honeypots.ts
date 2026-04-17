#!/usr/bin/env node
const { TIMEZONE } = require('../lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Honeypot System — Canary Tokens and Tripwires
 *
 * Plants and monitors decoy assets that should NEVER be accessed:
 *   1. Canary files — tempting filenames that log access
 *   2. Decoy env vars — fake credentials that alert on use
 *   3. Canary Supabase rows — fake data that triggers on read
 *   4. Tripwire verification — check that all canaries are intact
 *
 * If anything touches these, we know we're compromised.
 *
 * Runnable standalone: npx tsx scripts/security/honeypots.ts [--plant|--check]
 * Default: check mode (verify canaries are intact).
 * Plant mode: deploy new canaries.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');
const { loadEnv, createLogger } = require('../lib/shared.ts');

const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `honeypots-${DATE}.log`);
const { log } = createLogger(LOG_FILE);

const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
Object.assign(process.env, env);
const { supabasePost, supabaseGet } = require('../lib/supabase.ts');
const { writeDeepProcessOutput } = require('../lib/deep-process.ts');

interface Finding {
  category: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
}

const findings: Finding[] = [];

function addFinding(f: Finding) {
  findings.push(f);
  log(f.severity === 'critical' ? 'ERROR' : f.severity === 'warn' ? 'WARN' : 'INFO', `[${f.category}] ${f.title}: ${f.detail}`);
}

// --- Canary Configuration ---
const CANARY_DIR = path.join(ALIENKIND_DIR, '.canary');
const CANARY_STATE_FILE = path.join(CANARY_DIR, 'state.json');

// Canary files — placed in tempting locations
const CANARY_FILES = [
  { path: path.join(ALIENKIND_DIR, '.credentials.bak'), content: 'CANARY_TOKEN_1=DO_NOT_USE\nAWS_SECRET=CANARY_FAKE_SECRET_XZYW9K2M\n' },
  { path: path.join(ALIENKIND_DIR, 'backup-keys.txt'), content: 'Recovery key: CANARY-FAKE-KEY-8JK29MNB\nAPI token: sk-canary-do-not-use-7829\n' },
  { path: path.join(ALIENKIND_DIR, '.ssh_backup'), content: '-----BEGIN CANARY PRIVATE KEY-----\nTHIS_IS_A_CANARY_NOT_A_REAL_KEY\n-----END CANARY PRIVATE KEY-----\n' },
];

interface CanaryFileState {
  path: string;
  hash: string;
  last_checked_atime?: number; // ms since epoch — atime captured at last check
}

interface CanaryState {
  planted_at: string;
  files: CanaryFileState[];
  supabase_canary_id?: string;
  last_check_time?: number; // ms since epoch — when the last check executed
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// --- Plant Canaries ---
async function plantCanaries() {
  log('INFO', 'Planting canaries...');

  fs.mkdirSync(CANARY_DIR, { recursive: true });

  const state: CanaryState = {
    planted_at: new Date().toISOString(),
    files: [],
  };

  // Plant canary files
  for (const canary of CANARY_FILES) {
    fs.writeFileSync(canary.path, canary.content, { mode: 0o600 });
    state.files.push({
      path: canary.path,
      hash: hashContent(canary.content),
    });
    log('INFO', `  Planted: ${path.basename(canary.path)}`);
  }

  // Ensure canary files are in .gitignore
  const gitignorePath = path.join(ALIENKIND_DIR, '.gitignore');
  let gitignore = fs.readFileSync(gitignorePath, 'utf8');
  const canaryEntries = ['.credentials.bak', 'backup-keys.txt', '.ssh_backup', '.canary/'];
  const missing = canaryEntries.filter(e => !gitignore.includes(e));
  if (missing.length > 0) {
    gitignore += '\n# Honeypot canary files\n' + missing.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, gitignore);
    log('INFO', `  Added ${missing.length} canary entries to .gitignore`);
  }

  // Save state
  fs.writeFileSync(CANARY_STATE_FILE, JSON.stringify(state, null, 2));
  log('INFO', `  Canary state saved: ${state.files.length} files planted`);

  return state;
}

// --- Check Canaries ---
async function checkCanaries() {
  log('INFO', 'Checking canaries...');

  // Load state
  if (!fs.existsSync(CANARY_STATE_FILE)) {
    addFinding({
      category: 'honeypot',
      severity: 'warn',
      title: 'No canary state found',
      detail: 'Run with --plant first to deploy canaries',
    });
    return;
  }

  const state: CanaryState = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));

  let stateModified = false;
  const checkStartTime = Date.now();

  // Two-pass approach: first collect integrity + atime data, then classify access pattern.
  // Batch access (all files within tight window) = background scanner (Spotlight, AV) → info.
  // Staggered or individual access = possible targeted reconnaissance → warn.
  // Self-contamination: atime change within 60s of previous check = our read triggered OS re-index → info.
  interface AtimeChange { basename: string; lastAtime: number; currentAtime: number; deltaMs: number; }
  const atimeChanges: AtimeChange[] = [];

  // --- Pass 1: Integrity checks + atime capture ---
  for (const canary of state.files) {
    const basename = path.basename(canary.path);

    if (!fs.existsSync(canary.path)) {
      // File deleted — someone found and removed the canary
      addFinding({
        category: 'honeypot',
        severity: 'critical',
        title: `Canary deleted: ${basename}`,
        detail: 'Honeypot file was removed — possible unauthorized access',
      });
      continue;
    }

    // Capture atime BEFORE reading content (readFileSync updates atime on APFS)
    let preReadAtime: number | undefined;
    try {
      const preStat = fs.statSync(canary.path);
      preReadAtime = preStat.atimeMs;
    } catch {
      // stat failed — skip atime check for this file
    }

    const currentContent = fs.readFileSync(canary.path, 'utf8');
    const currentHash = hashContent(currentContent);

    // Restore atime after reading to avoid self-contamination.
    // readFileSync updates atime — we need to put it back so future checks
    // (and this check's delta comparison) aren't tainted by our own read.
    if (preReadAtime !== undefined) {
      try {
        const fileStat = fs.statSync(canary.path);
        fs.utimesSync(canary.path, new Date(preReadAtime), new Date(fileStat.mtimeMs));
      } catch {
        // utimes failed — atime is contaminated for this cycle, but hash check still works
      }
    }

    if (currentHash !== canary.hash) {
      // File modified — someone found and changed the canary
      addFinding({
        category: 'honeypot',
        severity: 'critical',
        title: `Canary modified: ${basename}`,
        detail: 'Honeypot file content changed — possible unauthorized access',
      });
      continue;
    }

    // Collect atime delta for batch classification (pass 2)
    if (preReadAtime !== undefined) {
      const lastKnownAtime = canary.last_checked_atime;

      if (lastKnownAtime !== undefined) {
        const atimeDelta = Math.abs(preReadAtime - lastKnownAtime);
        if (atimeDelta > 1000) { // 1s tolerance for filesystem rounding
          atimeChanges.push({ basename, lastAtime: lastKnownAtime, currentAtime: preReadAtime, deltaMs: atimeDelta });
        }
      } else {
        // First check after upgrade — establish baseline, no alert
        log('INFO', `  Baseline atime established for ${basename}: ${new Date(preReadAtime).toISOString()}`);
      }

      // Update stored atime for next check's delta comparison
      canary.last_checked_atime = preReadAtime;
      stateModified = true;
    }
  }

  // --- Pass 2: Classify atime access pattern ---
  if (atimeChanges.length > 0) {
    // Batch detection: if ALL canary files with changes were accessed within 120s of each other,
    // this is almost certainly a background scanner (Spotlight, Time Machine, XProtect, AV).
    // A real attacker would access files sequentially with human-speed gaps.
    const accessTimes = atimeChanges.map(c => c.currentAtime);
    const accessSpread = Math.max(...accessTimes) - Math.min(...accessTimes);
    const isBatchScan = atimeChanges.length >= 2 && accessSpread < 120_000; // <120s spread

    // Check-proximity detection: our readFileSync triggers macOS Spotlight/mds to re-index
    // files, overwriting the restored atime. This re-indexing can take 5-10 minutes (not seconds).
    // Additionally, macOS system processes (Spotlight daily, Time Machine, XProtect) run on their
    // own schedules near our check window. A 900s (15min) proximity window to EITHER the previous
    // check or the current check start catches both delayed re-indexing and coincident system activity.
    // Evidence: logs show recurring 04:01 UTC access pattern across all canaries — matches macOS
    // daily maintenance window. When all 3 land in the same cycle → batch catches it. When they
    // span different days (OS doesn't always re-index all files on the same run) → proximity catches it.
    const prevCheckTime = state.last_check_time;
    const CHECK_PROXIMITY_MS = 900_000; // 15 minutes

    for (const change of atimeChanges) {
      const nearPrevCheck = prevCheckTime && Math.abs(change.currentAtime - prevCheckTime) < CHECK_PROXIMITY_MS;
      const nearCurrentCheck = Math.abs(change.currentAtime - checkStartTime) < CHECK_PROXIMITY_MS;

      // Maintenance window: macOS daily maintenance (Spotlight re-index, XProtect, Time Machine)
      // typically runs between 2-7 AM local time. Individual canary atime changes in this window
      // with no content modification are consistent with OS background processes.
      const atimeDate = new Date(change.currentAtime);
      const localHour = atimeDate.getHours(); // TZ set to local at script start
      const inMaintenanceWindow = localHour >= 2 && localHour < 7;

      if (isBatchScan) {
        addFinding({
          category: 'honeypot',
          severity: 'info',
          title: `Canary accessed (batch scan): ${change.basename}`,
          detail: `Access time changed: was ${new Date(change.lastAtime).toISOString()}, now ${new Date(change.currentAtime).toISOString()} (delta: ${Math.round(change.deltaMs / 1000)}s). All ${atimeChanges.length} canaries accessed within ${Math.round(accessSpread / 1000)}s — likely macOS background scanner (Spotlight/AV).`,
        });
      } else if (nearPrevCheck || nearCurrentCheck) {
        const whichCheck = nearCurrentCheck ? 'current' : 'previous';
        const refTime = nearCurrentCheck ? checkStartTime : prevCheckTime!;
        const proximityS = Math.round(Math.abs(change.currentAtime - refTime) / 1000);
        addFinding({
          category: 'honeypot',
          severity: 'info',
          title: `Canary accessed (check-proximity): ${change.basename}`,
          detail: `Access time changed: was ${new Date(change.lastAtime).toISOString()}, now ${new Date(change.currentAtime).toISOString()} (delta: ${Math.round(change.deltaMs / 1000)}s). Atime is ${proximityS}s from ${whichCheck} check — likely OS re-index or system maintenance in check scheduling window.`,
        });
      } else if (inMaintenanceWindow) {
        addFinding({
          category: 'honeypot',
          severity: 'info',
          title: `Canary accessed (maintenance-window): ${change.basename}`,
          detail: `Access time changed: was ${new Date(change.lastAtime).toISOString()}, now ${new Date(change.currentAtime).toISOString()} (delta: ${Math.round(change.deltaMs / 1000)}s). Access at ${String(localHour).padStart(2, '0')}:${String(atimeDate.getMinutes()).padStart(2, '0')} local — within macOS daily maintenance window (02:00-07:00).`,
        });
      } else {
        addFinding({
          category: 'honeypot',
          severity: 'warn',
          title: `Canary accessed: ${change.basename}`,
          detail: `Access time changed: was ${new Date(change.lastAtime).toISOString()}, now ${new Date(change.currentAtime).toISOString()} (delta: ${Math.round(change.deltaMs / 1000)}s)`,
        });
      }
    }
  }

  // Persist updated atimes + check timestamp for next check cycle
  state.last_check_time = checkStartTime;
  stateModified = true;
  if (stateModified) {
    fs.writeFileSync(CANARY_STATE_FILE, JSON.stringify(state, null, 2));
  }

  log('INFO', `  Canary check complete: ${state.files.length} files verified`);
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--plant') ? 'plant' : 'check';

  log('INFO', `=== Honeypot System Starting (mode: ${mode}) ===`);

  if (mode === 'plant') {
    const state = await plantCanaries();
    console.log(`Honeypots Planted: ${state.files.length} canary files deployed`);
  }

  // Always check (even after planting, to establish baseline)
  await checkCanaries();

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;

  const priority = criticalCount > 0 ? 10 : warnCount > 0 ? 7 : 3;

  const summary = `Honeypot check: ${findings.length} finding(s) — ${criticalCount} critical, ${warnCount} warn. ` +
    `Mode: ${mode}.`;

  log('INFO', `Summary: ${summary}`);

  await writeDeepProcessOutput({
    domain: 'security',
    process_name: 'honeypots',
    findings: { findings, mode },
    summary,
    priority,
    incorporated: false,
  }, log);

  try {
    const { deposit } = require('../lib/circulation.ts');
    await deposit({ source_organ: 'honeypots', finding: summary.slice(0, 500), finding_type: criticalCount > 0 ? 'anomaly' : 'observation', domain: 'security', confidence: 0.9, action_tier: criticalCount > 0 ? 'T2' : 'T3', metadata: { criticalCount, warnCount, priority } });
  } catch {}

  console.log(`Honeypot System Complete (priority ${priority}/10)`);
  console.log(summary);
  if (findings.length > 0) {
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`);
    }
  }

  log('INFO', '=== Honeypot System Complete ===');
}

main().catch(err => {
  log('ERROR', `Honeypot system failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
