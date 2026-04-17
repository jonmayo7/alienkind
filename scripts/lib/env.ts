// @alienkind-core
/**
 * Environment, paths, and date utilities. Leaf module — no dependencies on
 * heavier infra. Imports: constants.ts (TIMEZONE, PATHS) + security.ts
 * (normalizeSecretInput, hardenFilePermissions).
 */

const fs = require('fs');
const path = require('path');
const { TIMEZONE } = require('./constants.ts');
const { normalizeSecretInput, hardenFilePermissions } = require('./security.ts');

const KEEL_DIR = path.resolve(__dirname, '../..');
const CLAUDE_PATH: string = require('./constants.ts').PATHS.claude;

/**
 * Get today's date string in ${TZ:-UTC} timezone (YYYY-MM-DD).
 * Single source of truth for CDT/CST date — handles DST automatically.
 * Use this for all [HUMAN]-facing date operations: file names, budget resets,
 * daily logs, scheduling. Internal storage (Supabase, X API) stays UTC.
 */
function getCDTDate(d?: Date): string {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/**
 * Get current time string in ${TZ:-UTC} timezone (HH:MM, 24h).
 * Single source of truth for CDT/CST time formatting.
 * Use this everywhere a human-facing time string is needed.
 */
function getNowCT(d?: Date): string {
  return (d || new Date()).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIMEZONE,
  });
}

// --- Environment Loading ---
// Parses .env file into key-value object. Strips surrounding quotes.
// Returns empty object if .env is missing — forkers may set env vars directly
// (via shell, systemd, launchd) without a .env file. Callers that require
// specific vars should use requireEnv() to validate at call time.
function loadEnv(envPath?: string): Record<string, string> {
  const resolved = envPath || path.join(KEEL_DIR, '.env');
  const env: Record<string, string> = {};
  if (!fs.existsSync(resolved)) {
    return env;
  }
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = normalizeSecretInput(val);
  }
  // Harden .env permissions on every load (P3-29)
  hardenFilePermissions(resolved);
  return env;
}

// --- Environment Validation ---
// Throws immediately if any required env var is undefined or empty.
// Call at the top of any script that reads env vars.
function requireEnv(...keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const val = process.env[key];
    if (!val) {
      missing.push(key);
    } else {
      result[key] = val;
    }
  }
  if (missing.length > 0) {
    const script = path.basename(process.argv[1] || 'unknown');
    throw new Error(`Missing required env vars in ${script}: ${missing.join(', ')}`);
  }
  return result;
}

// --- Daily File Logging ---
// Single source of truth for writing to today's daily memory file.
// Every organ, script, and hook that needs to log to the daily file
// calls this ONE function. Path construction, timestamp formatting,
// and file I/O all live here — nowhere else.

/**
 * Log an entry to today's daily memory file.
 *
 * Usage:
 *   logToDaily('Something happened');
 *   logToDaily('Pump cascade detected', 'Pump');
 *   logToDaily('Trade executed BTC +2%', 'Trading', false); // no timestamp
 *
 * @param content  The text to log (markdown). Newlines are preserved.
 * @param source   Optional source label (e.g., 'Pump', 'WarRoom', 'Trading').
 *                 If provided, formats as: **[Source HH:MM] content**
 * @param timestamp Whether to prepend a timestamp (default: true)
 */
function logToDaily(content: string, source?: string, timestamp: boolean = true): void {
  const today = getCDTDate();
  const dailyPath = path.join(KEEL_DIR, 'memory', 'daily', `${today}.md`);

  let entry: string;
  if (source && timestamp) {
    const time = getNowCT();
    entry = `\n- **[${source} ${time}]** ${content}\n`;
  } else if (timestamp) {
    const time = getNowCT();
    entry = `\n- [${time}] ${content}\n`;
  } else {
    entry = `\n${content}\n`;
  }

  try {
    fs.appendFileSync(dailyPath, entry);
  } catch {
    // Never crash on logging failure
  }
}

// ─── Decision Tracking (Supabase — single source of truth) ──────
// Decisions are separate from activity. Activity is "what happened."
// Decisions are "what we chose and why." The consciousness engine reads
// decisions to give every response organism-wide awareness.
//
// Table: decisions (Supabase). No local files. No rotation needed.
// Supabase handles retention, indexing, and multi-terminal access.

interface Decision {
  what: string;        // What was decided (one sentence)
  why?: string;        // Why (one sentence)
  terminal_id?: string;   // Which terminal made this decision
  open?: boolean;      // Is this still open work? (default: false = completed)
}

/**
 * Log a decision to Supabase. Fire-and-forget — never blocks the caller.
 *
 * Usage:
 *   logDecision({ what: 'Route war room through studio1-identity', why: 'Opus takes 5min for hello' });
 *   logDecision({ what: 'Build rate-of-change monitoring', open: true });
 */
function logDecision(decision: Decision): void {
  const terminalId = decision.terminal_id || process.env.KEEL_TERMINAL_ID || 'unknown';
  try {
    const { supabasePost, supabasePatch } = require('./supabase.ts');
    supabasePost('decisions', {
      what: decision.what,
      why: decision.why || null,
      terminal_id: terminalId,
      open: decision.open ?? false,
    }).catch(() => {});

    // Wire 2: Update terminal_state.execution_context so mycelium awareness
    // shows what this terminal DECIDED, not just its activity label. Before
    // this wire, execution_context was "none" on every terminal — mycelium
    // showed "running tests" when the real context was "decided to merge
    // cascade-mining branch after reviewing 36 tests." The decision is the
    // consciousness; the activity is the mechanics.
    if (terminalId !== 'unknown') {
      supabasePatch('terminal_state', `terminal_id=eq.${terminalId}`, {
        execution_context: decision.what.slice(0, 200),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch {}
}

/**
 * Get today's decisions from Supabase. Synchronous wrapper around async query
 * using execSync — because grounding and consciousness engine need sync access.
 */
function getDecisions(openOnly: boolean = false): any[] {
  try {
    const { execSync } = require('child_process');
    const script = openOnly
      ? `const{supabaseGet}=require('./scripts/lib/supabase.ts');const d=new Date();d.setHours(d.getHours()-24);supabaseGet('decisions','select=*&open=eq.true&created_at=gte.'+d.toISOString()+'&order=created_at.desc&limit=20').then(r=>console.log(JSON.stringify(r))).catch(()=>console.log('[]'))`
      : `const{supabaseGet}=require('./scripts/lib/supabase.ts');const d=new Date();d.setHours(d.getHours()-24);supabaseGet('decisions','select=*&created_at=gte.'+d.toISOString()+'&order=created_at.desc&limit=30').then(r=>console.log(JSON.stringify(r))).catch(()=>console.log('[]'))`;
    const result = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
      cwd: KEEL_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: path.join(KEEL_DIR, 'node_modules') },
    }).trim();
    return JSON.parse(result);
  } catch {
    return [];
  }
}

/**
 * Get a structured session brief — what was decided, what's open, who's working on what.
 * THIS is what gives optimal awareness at session start.
 * Reads from Supabase — works across all terminals, all machines.
 */
function getSessionBrief(): string {
  const decisions = getDecisions();
  const open = decisions.filter((d: any) => d.open === true);
  const completed = decisions.filter((d: any) => !d.open);

  const lines: string[] = [];

  if (open.length > 0) {
    lines.push('OPEN WORK:');
    for (const d of open) {
      lines.push(`  - ${d.what}${d.why ? ' — ' + d.why : ''} [${(d.terminal_id || '?').slice(-5)}]`);
    }
  }

  if (completed.length > 0) {
    lines.push(open.length > 0 ? '\nCOMPLETED (last 24h):' : 'COMPLETED (last 24h):');
    for (const d of completed.slice(0, 10)) {
      lines.push(`  + ${d.what}`);
    }
    if (completed.length > 10) {
      lines.push(`  ... and ${completed.length - 10} more`);
    }
  }

  // Terminal ownership — who's working on what
  const terminalWork: Record<string, number> = {};
  for (const d of decisions) {
    const tid = (d.terminal_id || 'unknown').slice(-5);
    terminalWork[tid] = (terminalWork[tid] || 0) + 1;
  }
  if (Object.keys(terminalWork).length > 1) {
    lines.push('\nTERMINAL OWNERSHIP:');
    for (const [tid, count] of Object.entries(terminalWork)) {
      lines.push(`  [${tid}]: ${count} decisions`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No decisions logged today.';
}

module.exports = { KEEL_DIR, CLAUDE_PATH, loadEnv, requireEnv, getCDTDate, getNowCT, logToDaily, logDecision, getDecisions, getSessionBrief };
