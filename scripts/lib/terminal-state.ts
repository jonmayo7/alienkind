// @alienkind-core
/**
 * Terminal State — Supabase-backed multi-instance awareness for AlienKind.
 *
 * Source of truth: Supabase `terminal_state` table (migration 004).
 *
 * Each running Claude Code session of your partner writes a row keyed by
 * terminal_id. On every UserPromptSubmit, every session reads the others
 * so the partner knows what its peers are doing — same partner, multiple
 * concurrent windows, coherent awareness.
 *
 * Public API:
 *   getTerminalId()                — stable per-session ID (env / file / PID)
 *   upsertTerminal(focus, activity)— write/update this session's row
 *   getAllTerminals()              — read every active row
 *   deleteTerminal(id)             — remove a row (used by prune)
 *   pruneStale()                   — drop rows older than ACTIVE_WINDOW_MS
 *
 * Graceful degradation:
 *   If SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, every function
 *   returns an empty/no-op result. Single-instance behaviour falls out of
 *   the wash — nothing throws, nothing logs noisily.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// 30-minute window — matches typical Claude Code session length. Rows older
// than this are considered stale and pruned at the next SessionStart.
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

const ROOT = path.resolve(__dirname, '..', '..');

// ────────────────────────────────────────────────────────────────────
// Env loading (lazy, idempotent)
// ────────────────────────────────────────────────────────────────────

let envLoaded = false;
function ensureEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* best-effort */ }
}

function hasSupabase(): boolean {
  ensureEnv();
  return !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY));
}

function supabaseAuth(): { url: string; key: string } {
  ensureEnv();
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  };
}

// ────────────────────────────────────────────────────────────────────
// Minimal Supabase REST client (no SDK dependency)
// ────────────────────────────────────────────────────────────────────

type Row = {
  terminal_id: string;
  type?: string;
  pid?: number | null;
  session_id?: string | null;
  focus?: string;
  activity?: string;
  repo_context?: string | null;
  updated_at?: string;
  registered_at?: string;
};

function request(method: string, p: string, body?: any, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const { url, key } = supabaseAuth();
    if (!url || !key) {
      resolve({ status: 0, body: '' });
      return;
    }
    const target = new URL(`${url}${p}`);
    const headers: Record<string, string> = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    if (data) headers['Content-Length'] = String(data.length);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request({
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      timeout: 5000,
    }, (res: any) => {
      let buf = '';
      res.on('data', (chunk: any) => { buf += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: buf }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    if (data) req.write(data);
    req.end();
  });
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Stable terminal ID for this process.
 *
 * Resolution order:
 *   1. ALIENKIND_TERMINAL_ID env var (set by an external launcher if any)
 *   2. /tmp/alienkind-terminal-id-<ppid> marker file (if Claude Code wrote one)
 *   3. PID-based fallback: "terminal-<ppid>" or "terminal-<pid>"
 */
export function getTerminalId(): string {
  if (process.env.ALIENKIND_TERMINAL_ID) return process.env.ALIENKIND_TERMINAL_ID;
  try {
    const ppid = process.ppid;
    if (ppid) {
      const marker = `/tmp/alienkind-terminal-id-${ppid}`;
      if (fs.existsSync(marker)) {
        const id = fs.readFileSync(marker, 'utf8').trim();
        if (id) return id;
      }
    }
  } catch { /* ignore */ }
  const pid = process.ppid || process.pid;
  return `terminal-${pid}`;
}

/**
 * Detect the basename of the git repo this process is inside, or null.
 * Used for display only — not load-bearing.
 */
export function detectRepoContext(): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.basename(root);
  } catch {
    return null;
  }
}

/**
 * Write or update this terminal's row.
 * No-op (returns false) when Supabase isn't configured.
 */
export async function upsertTerminal(fields: { focus?: string; activity?: string; type?: string; sessionId?: string } = {}): Promise<boolean> {
  if (!hasSupabase()) return false;
  const row: Row = {
    terminal_id: getTerminalId(),
    type: fields.type || 'terminal',
    pid: process.ppid || process.pid,
    session_id: fields.sessionId ?? null,
    focus: (fields.focus || '').slice(0, 500),
    activity: (fields.activity || '').slice(0, 500),
    repo_context: detectRepoContext(),
    updated_at: new Date().toISOString(),
  };
  const r = await request('POST', '/rest/v1/terminal_state', row, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return r.status >= 200 && r.status < 300;
}

/**
 * Read every row. Returns an empty array when Supabase isn't configured
 * or when the table doesn't exist yet (e.g. migration 004 not applied).
 */
export async function getAllTerminals(): Promise<Row[]> {
  if (!hasSupabase()) return [];
  const r = await request('GET', '/rest/v1/terminal_state?select=*&order=updated_at.desc');
  if (r.status < 200 || r.status >= 300) return [];
  try {
    const parsed = JSON.parse(r.body);
    return Array.isArray(parsed) ? parsed as Row[] : [];
  } catch {
    return [];
  }
}

/**
 * Delete a specific row by terminal_id.
 */
export async function deleteTerminal(terminalId: string): Promise<boolean> {
  if (!hasSupabase()) return false;
  const r = await request('DELETE', `/rest/v1/terminal_state?terminal_id=eq.${encodeURIComponent(terminalId)}`);
  return r.status >= 200 && r.status < 300;
}

/**
 * Drop every row older than ACTIVE_WINDOW_MS.
 * Returns the number of rows pruned (best-effort — based on the read count).
 */
export async function pruneStale(): Promise<number> {
  if (!hasSupabase()) return 0;
  const all = await getAllTerminals();
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let pruned = 0;
  for (const row of all) {
    const t = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (t < cutoff) {
      const ok = await deleteTerminal(row.terminal_id);
      if (ok) pruned += 1;
    }
  }
  return pruned;
}
