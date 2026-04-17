// @alienkind-core
/**
 * Terminal State — Supabase-backed per-terminal state management.
 *
 * Replaces JSON files (mycelium.json, context-window-state.json,
 * consciousness-recent.json, handoff-pending.md) with per-terminal
 * Supabase rows. Fixes multi-terminal clobbering.
 *
 * Table: terminal_state (migration 032)
 * Key: terminal_id (e.g., "terminal-28792", "daemon", "operator")
 *
 * Every hook imports from here instead of reading/writing shared files.
 */

const path = require('path');
const fs = require('fs');

// --- Env loading (lazy, once) ---
let envLoaded = false;
function ensureEnv(): void {
  if (envLoaded) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    try {
      const { loadEnv } = require(path.resolve(__dirname, 'shared.ts'));
      const env = loadEnv();
      Object.assign(process.env, env);
    } catch {
      // If .env loading fails, supabase.ts will throw on first call
    }
  }
  envLoaded = true;
}

function getSupabase() {
  ensureEnv();
  return require(path.resolve(__dirname, 'supabase.ts'));
}

/**
 * Canonical terminal ID for this process.
 * Resolution order:
 *   1. ALIENKIND_TERMINAL_ID env var (set by entry script, inherited by
 *      Claude + hooks)
 *   2. File marker at /tmp/alienkind-terminal-id (written by entry script at start)
 *   3. PID-based fallback (terminal-{ppid})
 *
 * The file fallback exists because SessionStart hooks may not inherit the
 * env var due to Claude Code's process tree — the hook subprocess may not
 * see exports from the grandparent entry-script shell.
 */
function getTerminalId(): string {
  if (process.env.ALIENKIND_TERMINAL_ID) return process.env.ALIENKIND_TERMINAL_ID;

  // File fallback: entry script writes the terminal ID to a per-PID marker file.
  // Process tree: entry-script (writes file) → claude (ppid of hook) → hook (this).
  // Check markers for our ppid and its parent.
  const fs = require('fs');
  try {
    // Try ppid marker (claude process — direct parent of this hook)
    const ppid = process.ppid;
    if (ppid) {
      const marker = `/tmp/alienkind-terminal-id-${ppid}`;
      const id = fs.readFileSync(marker, 'utf8').trim();
      if (id) return id;
    }
  } catch {}
  try {
    // Try grandparent: get ppid's ppid via ps (macOS compatible)
    const ppid = process.ppid;
    if (ppid) {
      const { execSync } = require('child_process');
      const grandPpid = execSync(`ps -o ppid= -p ${ppid}`, { encoding: 'utf8', timeout: 1000 }).trim();
      if (grandPpid) {
        const marker = `/tmp/alienkind-terminal-id-${grandPpid}`;
        const id = fs.readFileSync(marker, 'utf8').trim();
        if (id) return id;
      }
    }
  } catch {}

  return `terminal-${process.ppid || process.pid}`;
}

/**
 * Upsert a terminal's state. Used at registration and for bulk updates.
 * PostgREST upsert: POST with on_conflict + resolution=merge-duplicates.
 */
async function upsertTerminal(terminalId: string, data: Record<string, any>): Promise<void> {
  const { supabasePost } = getSupabase();
  await supabasePost('terminal_state', {
    terminal_id: terminalId,
    ...data,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'terminal_id', prefer: 'resolution=merge-duplicates,return=minimal' });
}

/**
 * Read a single terminal's state.
 */
async function getTerminal(terminalId: string): Promise<any | null> {
  const { supabaseGet } = getSupabase();
  const rows = await supabaseGet(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}&limit=1`
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Read all terminal states (mycelium awareness).
 * Cached in /tmp for 30 seconds — multiple hooks call this per turn,
 * each spawning a separate process. Without caching, 4+ identical
 * Supabase GETs fire per turn (800-2000ms wasted).
 */
const TERMINAL_CACHE_FILE = '/tmp/alienkind-terminal-state-cache.json';
const TERMINAL_CACHE_TTL_MS = 30000;

async function getAllTerminals(): Promise<any[]> {
  try {
    const stat = fs.statSync(TERMINAL_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < TERMINAL_CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(TERMINAL_CACHE_FILE, 'utf8'));
    }
  } catch { /* cache miss */ }

  const { supabaseGet } = getSupabase();
  const result = await supabaseGet('terminal_state', 'order=updated_at.desc') || [];

  try { fs.writeFileSync(TERMINAL_CACHE_FILE, JSON.stringify(result)); } catch {}
  return result;
}

/**
 * Delete a terminal's state (deregistration).
 */
async function deleteTerminal(terminalId: string): Promise<void> {
  const { supabaseDelete } = getSupabase();
  await supabaseDelete(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`
  );
}

/**
 * Update just the context percentage for a terminal.
 */
async function updateContextPct(terminalId: string, pct: number): Promise<void> {
  const { supabasePatch } = getSupabase();
  await supabasePatch(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`,
    {
      context_used_pct: Math.round(pct),
      updated_at: new Date().toISOString(),
    }
  );
}

/**
 * Update focus and activity for a terminal (mycelium).
 * Uses upsert so daemon/telegram/discord nodes auto-register on first write.
 */
async function updateTerminalFocus(
  terminalId: string,
  focus: string,
  opts?: { activity?: string; repoContext?: string; executionContext?: string }
): Promise<void> {
  const { supabasePost } = getSupabase();
  const data: Record<string, any> = {
    terminal_id: terminalId,
    updated_at: new Date().toISOString(),
  };
  // Only set focus if non-empty (avoids overwriting focus when only updating activity)
  if (focus) data.focus = String(focus).slice(0, 150);
  if (opts?.activity !== undefined) data.activity = String(opts.activity || '').slice(0, 200);
  if (opts?.repoContext !== undefined) data.repo_context = opts.repoContext;
  if (opts?.executionContext !== undefined) data.execution_context = opts.executionContext;
  await supabasePost('terminal_state', data, {
    onConflict: 'terminal_id',
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

/**
 * Write chain handoff data to this terminal's row.
 */
async function setHandoff(terminalId: string, handoff: Record<string, any>): Promise<void> {
  const { supabasePatch } = getSupabase();
  await supabasePatch(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`,
    {
      handoff_pending: handoff,
      updated_at: new Date().toISOString(),
    }
  );
}

/**
 * Read chain handoff for a terminal.
 */
async function getHandoff(terminalId: string): Promise<any | null> {
  const row = await getTerminal(terminalId);
  return row?.handoff_pending || null;
}

/**
 * Clear handoff after consumption.
 */
async function clearHandoff(terminalId: string): Promise<void> {
  const { supabasePatch } = getSupabase();
  await supabasePatch(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`,
    {
      handoff_pending: null,
      updated_at: new Date().toISOString(),
    }
  );
}

/**
 * Write consciousness state to this terminal's row.
 */
async function setConsciousness(terminalId: string, state: Record<string, any>): Promise<void> {
  const { supabasePatch } = getSupabase();
  await supabasePatch(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`,
    {
      consciousness_state: state,
      updated_at: new Date().toISOString(),
    }
  );
}

/**
 * Read consciousness state for a terminal.
 */
async function getConsciousness(terminalId: string): Promise<any | null> {
  const row = await getTerminal(terminalId);
  return row?.consciousness_state || null;
}

/**
 * Set a human-readable label for this terminal (e.g., "Phase 4 — Organism Architecture").
 * Stored in execution_context. Survives focus/activity updates.
 * Used by signals, mycelium awareness, and all display surfaces
 * so the human sees WHAT a terminal is doing, not a number.
 */
async function setLabel(terminalId: string, label: string): Promise<void> {
  const { supabasePatch } = getSupabase();
  await supabasePatch(
    'terminal_state',
    `terminal_id=eq.${encodeURIComponent(terminalId)}`,
    {
      execution_context: label,
      updated_at: new Date().toISOString(),
    }
  );
  // Also update the terminal tab title so the human sees it immediately
  const shortId = terminalId.replace('terminal-', '');
  try {
    process.stderr.write(`\x1b]0;${label} [${shortId}]\x07`);
  } catch { /* not in a terminal context (daemon, subagent) */ }
}

module.exports = {
  getTerminalId,
  upsertTerminal,
  getTerminal,
  getAllTerminals,
  deleteTerminal,
  updateContextPct,
  updateTerminalFocus,
  setLabel,
  setHandoff,
  getHandoff,
  clearHandoff,
  setConsciousness,
  getConsciousness,
};
