#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * register-terminal — wired as a Claude Code SessionStart hook.
 *
 * What it does on every session start:
 *   1. Prunes Supabase terminal_state rows older than ACTIVE_WINDOW_MS.
 *   2. Upserts a row for THIS terminal with focus = "session start".
 *   3. Prints a one-line summary of other active terminals (so the partner
 *      sees mycelium state in its SessionStart context).
 *
 * Fire-and-forget — never blocks session start, always exits 0.
 * Silently no-ops when Supabase isn't configured.
 */

import { getTerminalId, upsertTerminal, pruneStale, getAllTerminals, ACTIVE_WINDOW_MS } from '../lib/terminal-state';

async function main() {
  const myId = getTerminalId();

  // Best-effort prune of stale rows (other terminals that exited without
  // cleaning up). Doesn't block; if it fails, the read below will simply
  // include some stale entries.
  let pruned = 0;
  try { pruned = await pruneStale(); } catch { /* ignore */ }

  // Upsert our own row so peer sessions immediately see us.
  try {
    await upsertTerminal({
      focus: 'session start',
      activity: '',
      type: 'terminal',
    });
  } catch { /* ignore */ }

  // Surface mycelium state in this hook's stdout so it lands in the
  // partner's SessionStart context.
  try {
    const all = await getAllTerminals();
    const now = Date.now();
    const others = all.filter((t) => t.terminal_id !== myId).filter((t) => {
      const age = now - new Date(t.updated_at || 0).getTime();
      return age < ACTIVE_WINDOW_MS;
    });

    if (others.length > 0) {
      const summary = others.slice(0, 3).map((t) => {
        const ago = Math.round((now - new Date(t.updated_at || 0).getTime()) / 60000);
        const what = (t.activity || t.focus || '').slice(0, 80).replace(/\n/g, ' ');
        return `  ${t.terminal_id}: ${what} (${ago}m ago)`;
      }).join('\n');
      console.log(`\n╔══ Other instances of your partner active ══╗`);
      console.log(`${others.length} other terminal(s) running. Most recent:`);
      console.log(summary);
      if (others.length > 3) console.log(`  ...and ${others.length - 3} more`);
      console.log(`╚════════════════════════════════════════════╝`);
    }
    if (pruned > 0) {
      console.log(`[mycelium] pruned ${pruned} stale terminal(s)`);
    }
  } catch { /* never block */ }
}

main().then(() => process.exit(0), () => process.exit(0));
