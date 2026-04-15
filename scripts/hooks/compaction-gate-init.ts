#!/usr/bin/env node

/**
 * Compaction Gate Init — SessionStart hook.
 *
 * SessionStart fires on fresh session start AND on compaction/compact.
 * Tracks invocation count per session:
 *   count = 1: fresh start, create gate (ensures grounding on every session)
 *   count > 1: compaction detected, reset gate + clear stale reads
 *
 * When gate is created/reset, clears identity kernel entries from track-read
 * so the gate can't auto-clear from pre-compaction reads.
 *
 * Gate file: /tmp/keel-compaction-gate-{sessionId}.json
 * Counter file: /tmp/keel-session-starts-{sessionId}.json
 *
 * Consumed by:
 *   - compaction-gate.ts (UserPromptSubmit — warning + fallback detection)
 *   - compaction-gate-enforce.ts (PreToolUse — blocks tools until grounded)
 *
 * Fires on: SessionStart
 */

const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  if (sessionId === 'unknown') process.exit(0);

  const counterFile = `/tmp/keel-session-starts-${sessionId}.json`;
  const gateFile = `/tmp/keel-compaction-gate-${sessionId}.json`;
  const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;

  // Count SessionStart invocations for this session
  let counter = 0;
  try {
    const data = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
    counter = data.count || 0;
  } catch {}

  counter++;
  try {
    fs.writeFileSync(counterFile, JSON.stringify({
      count: counter,
      lastStart: new Date().toISOString(),
    }));
  } catch {}

  // --- Identity injection detection: auto-clear gate when identity files were injected ---
  // invokeKeel sets KEEL_IDENTITY_INJECTED=1 when injectIdentity: true,
  // meaning identity files were programmatically prepended to the prompt.
  if (process.env.KEEL_IDENTITY_INJECTED === '1') {
    const state = {
      detected: true,
      cleared: true,
      detectedAt: new Date().toISOString(),
      clearedAt: new Date().toISOString(),
      sessionId,
      trigger: 'Identity injected programmatically — identity kernel in prompt',
    };
    try { fs.writeFileSync(gateFile, JSON.stringify(state, null, 2)); } catch {}
    process.exit(0);
  }

  // --- Chain boot detection: auto-clear gate when grounding is pre-cached ---
  const terminalId = process.env.KEEL_TERMINAL_ID || '';
  const pidStr = terminalId.replace('terminal-', '');
  const chainBootMarker = `/tmp/keel-chain-boot-${pidStr}`;

  if (pidStr && fs.existsSync(chainBootMarker)) {
    // This is a warm chain boot — grounding was pre-cached in the handoff
    const state = {
      detected: true,
      cleared: true,
      detectedAt: new Date().toISOString(),
      clearedAt: new Date().toISOString(),
      sessionId,
      trigger: 'Chain mode warm boot — grounding pre-cached in handoff',
    };
    try { fs.writeFileSync(gateFile, JSON.stringify(state, null, 2)); } catch {}

    // Clean up chain boot marker
    try { fs.unlinkSync(chainBootMarker); } catch {}

    // Signal readiness to the parent keel.sh (waiting for warm swap)
    const warmReadyFile = `/tmp/keel-warm-ready-chain-${terminalId}`;
    // But the parent is looking for /tmp/keel-warm-ready-chain-{PARENT_TERMINAL_ID}
    // We need the parent's terminal ID. It's in the --parent flag of keel.sh.
    // keel.sh --warm sets WARM_PARENT env var... but it's a shell var, not exported.
    // Instead, use a cross-reference: write readiness at our terminal ID,
    // and also at the parent's terminal ID if we can find it.
    // The handoff file contains "Terminal: terminal-XXXX" — the parent's ID.
    try {
      // Write readiness keyed to our own terminal ID
      fs.writeFileSync(`/tmp/keel-warm-ready-chain-${terminalId}`, new Date().toISOString());

      // Also look for a parent reference file written by keel.sh --warm
      const parentFile = `/tmp/keel-warm-parent-${pidStr}`;
      if (fs.existsSync(parentFile)) {
        const parentTerminalId = fs.readFileSync(parentFile, 'utf8').trim();
        fs.writeFileSync(`/tmp/keel-warm-ready-chain-${parentTerminalId}`, new Date().toISOString());
        fs.unlinkSync(parentFile);
      }
    } catch {}

    // Output confirmation (visible as hook feedback)
    console.log('COMPACTION GATE CLEARED — Chain mode boot. Identity pre-loaded via handoff. Grounding pre-cached.');
    process.exit(0);
  }

  const trigger = counter === 1
    ? 'SessionStart (fresh session — grounding required)'
    : `SessionStart #${counter} (compaction detected)`;

  // Create/reset gate
  const state = {
    detected: true,
    cleared: false,
    detectedAt: new Date().toISOString(),
    sessionId,
    trigger,
  };

  try { fs.writeFileSync(gateFile, JSON.stringify(state, null, 2)); } catch {}

  // Clear identity kernel entries from track-read so gate can't auto-clear from stale reads
  try {
    const tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    if (tracking.filesRead) {
      const identityFiles = [
        'identity/character.md',
        'identity/commitments.md',
        'identity/orientation.md',
        'identity/harness.md',
      ];
      const dailyPattern = /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/;
      tracking.filesRead = tracking.filesRead.filter(f =>
        !identityFiles.includes(f) && !dailyPattern.test(f)
      );
      fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
    }
  } catch { /* track file doesn't exist yet on fresh sessions — that's fine */ }

  // Clear stale Supabase boot marker so gate requires fresh queries
  const supabaseMarker = `/tmp/keel-supabase-boot-${sessionId}.json`;
  try { fs.unlinkSync(supabaseMarker); } catch {}

  process.exit(0);
}

main().catch(() => process.exit(0));
