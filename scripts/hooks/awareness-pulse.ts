#!/usr/bin/env node

/**
 * Awareness Pulse — PostToolUse hook for Read.
 *
 * Injects a brief context line every Nth tool call with:
 *   - Current time (CST)
 *   - Mycelium snapshot from Supabase (what other instances are doing)
 *   - Today's calendar events (from cache)
 *
 * This is the "electricity" through the mycelium — making awareness
 * reflexive instead of conscious. The signal is in the processing path
 * itself, so it can't be missed.
 *
 * Zero compute: reads Supabase, formats a one-liner, exits.
 * Fires on: PostToolUse (Read) — the most frequent tool in any session.
 *
 * Source of truth: Supabase terminal_state (migration 032).
 */

const fs = require('fs');
const path = require('path');
const { TIMEZONE } = require('../lib/constants.ts');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();
const PULSE_INTERVAL = 8; // every 8th Read call

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  // Session-level counter
  const sessionId = hookData.session_id || process.ppid || 'unknown';
  const stateFile = `/tmp/keel-awareness-${sessionId}.json`;

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = { count: 0 };
  }

  state.count++;

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch { /* best effort */ }

  // Only pulse every Nth call
  if (state.count % PULSE_INTERVAL !== 0) process.exit(0);

  // --- Build the pulse ---
  const parts = [];

  // Time
  const now = new Date();
  const cst = now.toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  parts.push(`${dateStr} ${cst} CST`);

  // Mycelium — what other instances are doing (from Supabase)
  try {
    const { getTerminalId, getAllTerminals } = require(
      path.resolve(KEEL_DIR, 'scripts', 'lib', 'terminal-state.ts')
    );
    const myId = getTerminalId();
    const all = await getAllTerminals();
    const others = [];
    for (const row of all) {
      if (row.terminal_id === myId) continue;
      // Skip stale nodes (>2 hours)
      const age = now.getTime() - new Date(row.updated_at).getTime();
      if (age > 2 * 60 * 60 * 1000) continue;
      const focus = (row.focus || '').slice(0, 60);
      others.push(`${row.terminal_id}: ${focus}`);
    }
    if (others.length > 0) {
      parts.push(`Mesh: ${others.join(' | ')}`);
    }
  } catch { /* non-critical */ }

  // Calendar cache — today's events
  try {
    const calPath = path.join(KEEL_DIR, 'logs', 'calendar-cache.json');
    if (fs.existsSync(calPath)) {
      const cache = JSON.parse(fs.readFileSync(calPath, 'utf8'));
      // Only use cache from today
      const cacheDate = (cache.date || '').slice(0, 10);
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
      if (cacheDate === todayStr && cache.events && cache.events.length > 0) {
        const eventStr = cache.events.map(e => `${e.time} ${e.title}`).join(', ');
        parts.push(`Calendar: ${eventStr}`);
      }
    }
  } catch { /* non-critical */ }

  // Circulation — unseen findings from other organs (Supabase-backed)
  try {
    const { withdraw } = require(
      path.resolve(KEEL_DIR, 'scripts', 'lib', 'circulation.ts')
    );
    const { getTerminalId } = require(
      path.resolve(KEEL_DIR, 'scripts', 'lib', 'terminal-state.ts')
    );
    const termId = getTerminalId();
    const findings = await withdraw({
      unconsumedOnly: true,
      consumer: termId,
      limit: 5,
      minIntensity: 0.2,
    });
    if (findings.length > 0) {
      parts.push(`Circulation: ${findings.length} new finding(s)`);
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║  CIRCULATION — New findings from other organs               ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      for (const f of findings) {
        const line = `[${f.domain}] ${f.source_organ}: ${f.finding.slice(0, 55)}`;
        console.log(`║  ${line.padEnd(60)}║`);
      }
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    }
  } catch { /* circulation unavailable */ }

  // Output the pulse
  console.log(`[Awareness] ${parts.join(' | ')}`);
  process.exit(0);
}

main().catch(() => process.exit(0));
