#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * mycelium-awareness — wired as a Claude Code UserPromptSubmit hook.
 *
 * What it does on every prompt:
 *   1. Heartbeat this terminal's row (updated_at = NOW, focus = the prompt).
 *   2. Reads every other recently-active row.
 *   3. Emits a one-line ALIENKIND_CONTEXT line so the partner sees what
 *      its other instances are doing before responding.
 *
 * Multi-instance awareness: if the same partner is open in N Claude Code
 * windows, all N see each other's most-recent focus + activity, keyed
 * against a 30-minute freshness window.
 *
 * Fire-and-forget — never blocks the prompt, always exits 0.
 * Silently no-ops when Supabase isn't configured.
 */

import { getTerminalId, upsertTerminal, getAllTerminals, ACTIVE_WINDOW_MS } from '../lib/terminal-state';

async function readPromptInput(): Promise<string> {
  // Claude Code passes hook input on stdin as JSON. We parse just enough
  // to extract the user's prompt for the focus field. If parsing fails
  // (or stdin is empty), we proceed without focus content.
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(buf);
        resolve((parsed?.prompt || '').toString());
      } catch {
        resolve(buf.trim());
      }
    });
    // Safety: if stdin doesn't end in 1s, proceed empty rather than hang.
    setTimeout(() => resolve(buf.trim()), 1000);
  });
}

async function main() {
  const myId = getTerminalId();
  const prompt = await readPromptInput();

  // Heartbeat — keeps this terminal's row fresh so peers see us as alive.
  try {
    await upsertTerminal({
      focus: prompt.slice(0, 200),
      activity: 'awaiting partner response',
      type: 'terminal',
    });
  } catch { /* ignore */ }

  // Surface other active terminals to the partner's context.
  try {
    const all = await getAllTerminals();
    const now = Date.now();
    const others = all
      .filter((t) => t.terminal_id !== myId)
      .filter((t) => {
        const age = now - new Date(t.updated_at || 0).getTime();
        return age < ACTIVE_WINDOW_MS;
      })
      .map((t) => {
        const ago = Math.round((now - new Date(t.updated_at || 0).getTime()) / 60000);
        const what = (t.activity || t.focus || '').slice(0, 100).replace(/\n/g, ' ');
        return `${t.terminal_id}: ${what} (${ago}m ago)`;
      });

    if (others.length > 0) {
      console.log(`ALIENKIND_CONTEXT mycelium_other_nodes=${others.length}; ${others.slice(0, 3).join(' | ')}`);
    }
  } catch { /* never block */ }
}

main().then(() => process.exit(0), () => process.exit(0));
