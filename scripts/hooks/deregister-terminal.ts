#!/usr/bin/env node

/**
 * Deregister terminal session on exit — concurrent terminal support.
 *
 * Wired as Stop hook. Removes this terminal from Supabase terminal_state
 * and legacy active-terminals.json.
 * Fire-and-forget: always exits 0.
 */

const path = require('path');

async function main() {
  // Remove from Supabase terminal_state (source of truth)
  try {
    const { getTerminalId, deleteTerminal } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
    );
    const terminalId = getTerminalId();
    await deleteTerminal(terminalId);
  } catch { /* never block exit */ }

  // Remove from legacy terminal-sessions
  try {
    const { deregisterTerminal } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-sessions.ts')
    );
    deregisterTerminal();
  } catch { /* never block exit */ }

  // Clean up build-active.lock if this terminal owns it
  // Prevents stale locks from blocking auto-commit after terminal exit
  try {
    const fs = require('fs');
    const lockPath = path.join(__dirname, '..', '..', 'logs', 'build-active.lock');
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const myPid = process.ppid || process.pid;
      if (lock.pid === myPid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch { /* never block exit */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
