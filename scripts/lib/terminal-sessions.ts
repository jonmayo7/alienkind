/**
 * Terminal Session Coordination
 *
 * Enables multiple concurrent terminal sessions without collision.
 * Each terminal registers itself at boot, deregisters on exit.
 * Other terminals (and the daemon) can see who's active.
 *
 * State file: logs/active-terminals.json
 *
 * Data flows:
 *   Writers: terminal SessionStart hook (register), Stop hook (deregister)
 *   Readers: ground.sh (display), terminal SessionStart hook (awareness),
 *            daemon (optional awareness), log-conversation.ts (session tagging)
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(KEEL_DIR, 'logs', 'active-terminals.json');
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours — consider stale

interface TerminalEntry {
  sessionId: string;
  label: string;
  registeredAt: string;
  pid: number;
}

interface RegisterResult {
  label: string;
  others: TerminalEntry[];
}

/**
 * Read current active terminals, pruning stale entries.
 */
function getActiveTerminals(): TerminalEntry[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const terminals: TerminalEntry[] = JSON.parse(raw);
    const now = Date.now();

    // Prune stale entries (process dead or too old)
    return terminals.filter((t: TerminalEntry) => {
      // Check if PID is still alive
      try {
        process.kill(t.pid, 0); // signal 0 = existence check
      } catch {
        return false; // process dead
      }
      // Check staleness
      const age = now - new Date(t.registeredAt).getTime();
      return age < STALE_THRESHOLD_MS;
    });
  } catch {
    return [];
  }
}

/**
 * Register a terminal session. Call at SessionStart.
 */
function registerTerminal(sessionId: string, label: string = 'terminal'): RegisterResult {
  const terminals = getActiveTerminals();
  const pid = process.ppid || process.pid; // Parent PID is the Claude Code process

  // Remove any existing entry for this PID (re-registration)
  const filtered = terminals.filter((t: TerminalEntry) => t.pid !== pid);

  const entry: TerminalEntry = {
    sessionId,
    label,
    registeredAt: new Date().toISOString(),
    pid,
  };

  filtered.push(entry);

  // Atomic write
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(filtered, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);

  return {
    label,
    others: filtered.filter((t: TerminalEntry) => t.pid !== pid),
  };
}

/**
 * Deregister a terminal session. Call at Stop.
 */
function deregisterTerminal(pid?: number): void {
  const effectivePid = pid || process.ppid || process.pid;
  const terminals = getActiveTerminals();
  const filtered = terminals.filter((t: TerminalEntry) => t.pid !== effectivePid);

  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(filtered, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

/**
 * Get count of active terminal sessions (for display).
 */
function activeTerminalCount(): number {
  return getActiveTerminals().length;
}

module.exports = {
  getActiveTerminals,
  registerTerminal,
  deregisterTerminal,
  activeTerminalCount,
  STATE_FILE,
};
