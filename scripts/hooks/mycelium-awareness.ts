#!/usr/bin/env node

/**
 * UserPromptSubmit hook: injects mycelium state into every response.
 * Reads Supabase terminal_state table and outputs active nodes so Keel has
 * awareness of what other instances are doing before responding.
 *
 * Enhanced with:
 *   - Activity display (what Keel is actually doing, not just the human's prompt)
 *   - Repo context (which repo each terminal is working in)
 *   - File conflict warnings (files touched by multiple terminals)
 *
 * Source of truth: Supabase terminal_state (migration 032).
 */

const path = require('path');

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — the human works across 7+ terminals, some idle 30+ min between interactions

async function main() {
  try {
    const { getTerminalId, getAllTerminals } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
    );
    const myId = getTerminalId();
    const now = Date.now();

    const all = await getAllTerminals();
    const nodes = all
      .filter(t => t.terminal_id !== myId)
      .filter(t => {
        const age = now - new Date(t.updated_at).getTime();
        // Show if recently active
        if (age < STALE_MS) return true;
        // Show if PID is alive (terminal open but idle)
        if (t.pid) {
          try { process.kill(t.pid, 0); return true; } catch { return false; }
        }
        // Daemon/telegram/discord don't have PIDs in terminal_state — show if <4h
        if (!t.terminal_id.startsWith('terminal-')) return age < 4 * 60 * 60 * 1000;
        return false;
      })
      .map(t => {
        const ago = Math.round((now - new Date(t.updated_at).getTime()) / 60000);
        const activity = (t.activity || '').slice(0, 120).replace(/\n/g, ' ');
        const focus = (t.focus || '').slice(0, 120).replace(/\n/g, ' ');

        // Build display: prefer activity (what Keel is doing) over focus (what the human said)
        let display = activity || focus;

        // Add repo context if different from keel
        const repo = t.repo_context;
        if (repo && repo !== 'keel') {
          display = `[${repo}] ${display}`;
        }

        // Use execution_context as the terminal name when available
        const label = t.execution_context || `${t.type || 'terminal'}/${t.terminal_id}`;

        return `  ${label}: ${display} (${ago}m ago)`;
      });

    if (nodes.length > 0) {
      console.log(`Mycelium (${nodes.length} other active nodes):`);
      nodes.forEach(n => console.log(n));
    }

    // VGE: Surface recent corrections from other terminals
    // If another terminal corrected a fact in the last 30 minutes,
    // this terminal sees it BEFORE responding with stale data
    try {
      const fs = require('fs');
      const correctionFile = path.resolve(__dirname, '..', '..', 'logs', 'recent-corrections.json');
      if (fs.existsSync(correctionFile)) {
        const corrections = JSON.parse(fs.readFileSync(correctionFile, 'utf8'));
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        const recent = corrections.filter((c: any) =>
          c.timestamp > thirtyMinAgo && c.terminal !== myId
        );
        if (recent.length > 0) {
          console.log(`⚠ Recent corrections from other terminals (${recent.length}):`);
          for (const c of recent.slice(-5)) {
            const ago = Math.round((Date.now() - c.timestamp) / 60000);
            console.log(`  [${ago}m ago, ${c.terminal}] ${c.correction.slice(0, 150)}`);
          }
        }
      }
    } catch { /* correction surfacing is best-effort */ }

    // Phase 4: Surface unread signals from other terminals.
    // All signals are pull-based — displayed here on UserPromptSubmit,
    // acknowledged after display. No blocking gates, no push semantics.
    // This is the proven pattern (Pattern 3: Queue + Next-Prompt Injection).
    try {
      const { getUnreadSignals, acknowledgeSignals } = require(
        path.resolve(__dirname, '..', 'lib', 'event-bus.ts')
      );
      const signals = await getUnreadSignals(myId, { limit: 5 });
      if (signals.length > 0) {
        console.log('');
        console.log(`Cross-terminal signals (${signals.length}):`);
        for (const sig of signals) {
          const age = Date.now() - new Date(sig.created_at || '').getTime();
          const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` :
                         age < 3600000 ? `${Math.round(age / 60000)}m ago` :
                         `${Math.round(age / 3600000)}h ago`;
          const sender = sig.payload?.sender_label || sig.from_node;
          const content = sig.payload?.summary || sig.payload?.message || '';
          const urgent = sig.signal_type === 'blocking' ? ' [URGENT]' : '';
          console.log(`  [${sig.signal_type}${urgent}] from ${sender} (${ageStr}): ${content}`);
        }

        // Acknowledge all after display
        const ids = signals.map((s: any) => s.id).filter(Boolean);
        if (ids.length > 0) {
          acknowledgeSignals(ids, myId).catch(() => {});
        }
      }
    } catch { /* signal surfacing is best-effort */ }

  } catch {
    // Silent — awareness is non-critical
  }
}

main().catch(() => {});
