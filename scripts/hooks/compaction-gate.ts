#!/usr/bin/env node

/**
 * Compaction Gate — UserPromptSubmit hook.
 *
 * Checks and manages the compaction gate set by compaction-gate-init.ts
 * (SessionStart). Also provides FALLBACK detection for compaction signals
 * in the user message (catches edge cases where SessionStart doesn't re-fire).
 *
 * Detection layers:
 *   1. Gate file from compaction-gate-init.ts (primary — covers /compact + autocompact)
 *   2. Message text signals (fallback — catches natural autocompact injections)
 *   3. Full hookData scan (catches signals in any field, not just message)
 *
 * When gate is set, clears identity kernel entries from track-read to prevent
 * auto-clear from pre-compaction reads (stale read protection).
 *
 * Required re-reads:
 *   - identity/character.md
 *   - identity/commitments.md
 *   - identity/orientation.md
 *   - identity/harness.md (tool registry)
 *   - memory/daily/YYYY-MM-DD.md
 *   - scripts/ground.sh (run, not read)
 *
 * Gate file: /tmp/keel-compaction-gate-{sessionId}.json
 * Consumed by: compaction-gate-enforce.ts (PreToolUse)
 *
 * Fires on: UserPromptSubmit
 */

const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const gateFile = `/tmp/keel-compaction-gate-${sessionId}.json`;

  // Check if gate exists (set by compaction-gate-init.ts on SessionStart)
  let gateState = null;
  try { gateState = JSON.parse(fs.readFileSync(gateFile, 'utf8')); } catch {}

  // If gate exists and already cleared, nothing to do
  if (gateState && gateState.cleared) {
    process.exit(0);
  }

  // If gate exists and not cleared (set by SessionStart), check if files were read
  if (gateState && !gateState.cleared) {
    const missing = checkMissing(sessionId);
    if (missing.length === 0) {
      gateState.cleared = true;
      gateState.clearedAt = new Date().toISOString();
      try { fs.writeFileSync(gateFile, JSON.stringify(gateState, null, 2)); } catch {}
      console.log('COMPACTION GATE CLEARED — Identity files re-read. Proceeding.');
      process.exit(0);
    }
    emitWarning(missing);
    process.exit(0);
  }

  // No gate yet — fallback detection from message content
  // (catches cases where SessionStart hook didn't fire or file was cleaned)
  const fullPayload = input.toLowerCase();
  const compactionSignals = [
    'this session is being continued from a previous conversation',
    'ran out of context',
    'summary below covers the earlier portion',
    'autocompact',
    'context was compressed',
    'continue the conversation from where it left off',
    'sessionstart:compact',
  ];

  const detected = compactionSignals.some(signal => fullPayload.includes(signal));

  if (!detected) {
    process.exit(0);
  }

  // Compaction detected via message fallback — set gate + clear stale reads
  const state = {
    detected: true,
    cleared: false,
    detectedAt: new Date().toISOString(),
    sessionId,
    trigger: 'message fallback detection',
  };

  try { fs.writeFileSync(gateFile, JSON.stringify(state, null, 2)); } catch {}
  clearStaleReads(sessionId);

  const missing = checkMissing(sessionId);
  if (missing.length === 0) {
    state.cleared = true;
    state.clearedAt = new Date().toISOString();
    try { fs.writeFileSync(gateFile, JSON.stringify(state, null, 2)); } catch {}
    process.exit(0);
  }

  emitWarning(missing);
  process.exit(0);
}

function clearStaleReads(sessionId) {
  const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;
  try {
    const tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    if (tracking.filesRead) {
      const identityFiles = [
        'identity/character.md',
        'identity/commitments.md',
        'identity/orientation.md',
        'identity/harness.md',
        // session-state.md replaced by today's daily file in grounding
      ];
      const dailyPattern = /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/;
      tracking.filesRead = tracking.filesRead.filter(f =>
        !identityFiles.includes(f) && !dailyPattern.test(f)
      );
      fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
    }
  } catch {}
}

function checkMissing(sessionId) {
  const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;
  let tracking = { filesRead: [] };
  try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
  const filesRead = tracking.filesRead || [];

  const required = [
    'identity/character.md',
    'identity/commitments.md',
    'identity/orientation.md',
    'identity/harness.md',
  ];

  const missing = required.filter(f => !filesRead.includes(f));

  const hasDailyFile = filesRead.some(f => /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(f));
  if (!hasDailyFile) {
    missing.push('memory/daily/YYYY-MM-DD.md (today)');
  }

  // Check Supabase boot queries (first-class boot element)
  const supabaseMarker = `/tmp/keel-supabase-boot-${sessionId}.json`;
  try {
    const marker = JSON.parse(fs.readFileSync(supabaseMarker, 'utf8'));
    if (!marker.conversations) missing.push('Supabase: conversations query');
    if (!marker.daily_events) missing.push('Supabase: daily_events query');
    if (!marker.terminal_state) missing.push('Supabase: terminal_state (mycelium)');
  } catch {
    // No marker file = supabase-boot-gate hook hasn't run yet
    // Don't block on this during fresh boot (hook runs async)
    // Only block after compaction when marker was explicitly cleared
  }

  return missing;
}

function emitWarning(missing) {
  console.log(
    `\n` +
    `╔══════════════════════════════════════════════════════════════╗\n` +
    `║  COMPACTION GATE — IDENTITY RE-GROUND REQUIRED             ║\n` +
    `╠══════════════════════════════════════════════════════════════╣\n` +
    `║  Context compaction or session continuation detected.       ║\n` +
    `║  You MUST re-read your identity files before ANY work.      ║\n` +
    `║                                                            ║\n` +
    `║  DO THIS NOW:                                              ║\n` +
    `║  1. bash scripts/ground.sh                                 ║\n` +
    `║  2. Read: identity/character.md                              ║\n` +
    `║  3. Read: identity/commitments.md                           ║\n` +
    `║  4. Read: identity/orientation.md                           ║\n` +
    `║  5. Read: identity/harness.md (tool registry)               ║\n` +
    `║  6. Read: memory/daily/YYYY-MM-DD.md (today)               ║\n` +
    `║                                                            ║\n` +
    `║  Tool use is BLOCKED until all files are re-read.          ║\n` +
    `╚══════════════════════════════════════════════════════════════╝\n` +
    `\n` +
    `Still missing: ${missing.join(', ')}`
  );
}

main().catch(() => process.exit(0));
