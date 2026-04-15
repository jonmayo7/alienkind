#!/usr/bin/env node

/**
 * Compaction Gate Enforcement — PreToolUse hook.
 *
 * If the compaction gate is set (by compaction-gate-init.ts on SessionStart
 * or compaction-gate.ts fallback on UserPromptSubmit) and not yet cleared,
 * BLOCKS tool use until all identity kernel files have been re-read.
 *
 * Blocked: Bash, Edit, Write, Agent, WebSearch, WebFetch, NotebookEdit
 * Allowed: Read, Grep, Glob, ToolSearch (needed to re-read identity kernel / clear gate)
 *
 * The gate clears automatically when track-read.ts records that all
 * required files have been read.
 *
 * Fires on: PreToolUse (Bash, Edit, Write, Agent, WebSearch, WebFetch, NotebookEdit)
 */

const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const gateFile = `/tmp/keel-compaction-gate-${sessionId}.json`;

  // No gate file = no compaction detected = allow everything
  let gateState;
  try { gateState = JSON.parse(fs.readFileSync(gateFile, 'utf8')); } catch {
    process.exit(0);
  }

  // Gate already cleared
  if (gateState.cleared) {
    process.exit(0);
  }

  // Gate active — check if identity kernel files have been read since detection
  // Use same ID resolution as track-read.ts to avoid session ID mismatch
  const terminalId = process.env.KEEL_TERMINAL_ID || sessionId;
  const trackFile = `/tmp/keel-build-cycle-${terminalId}.json`;
  let tracking = { filesRead: [] };
  try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
  const filesRead = tracking.filesRead || [];

  const required = [
    'identity/character.md',
    'identity/commitments.md',
    'identity/orientation.md',
    'identity/harness.md',
  ];

  // Detect @import in CLAUDE.md — files expanded via @import are already in context
  // (Claude Code auto-expands @imports at load AND after compaction)
  let importedFiles = [];
  try {
    const claudeMd = fs.readFileSync(
      require('path').join(process.cwd(), 'CLAUDE.md'), 'utf8'
    );
    const importPattern = /^@(.+\.md)\s*$/gm;
    let match;
    while ((match = importPattern.exec(claudeMd)) !== null) {
      importedFiles.push(match[1]);
    }
  } catch {}

  const missing = required
    .filter(f => !filesRead.includes(f))
    .filter(f => !importedFiles.includes(f)); // @imported files are already in context
  const hasDailyFile = filesRead.some(f => /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(f));
  if (!hasDailyFile) missing.push('daily file');

  // Check Supabase boot queries (first-class, same enforcement as file reads)
  const supabaseMarker = `/tmp/keel-supabase-boot-${sessionId}.json`;
  try {
    const marker = JSON.parse(fs.readFileSync(supabaseMarker, 'utf8'));
    if (!marker.conversations) missing.push('Supabase: conversations');
    if (!marker.daily_events) missing.push('Supabase: daily_events');
    if (!marker.terminal_state) missing.push('Supabase: terminal_state (mycelium)');
  } catch {
    // No marker = hook hasn't run. Don't block — it fires at SessionStart.
    // After compaction, compaction-gate-init clears the marker, and
    // supabase-boot-gate re-runs on the new SessionStart to recreate it.
  }

  if (missing.length === 0) {
    // All read — clear the gate
    gateState.cleared = true;
    gateState.clearedAt = new Date().toISOString();
    try { fs.writeFileSync(gateFile, JSON.stringify(gateState, null, 2)); } catch {}
    process.exit(0);
  }

  // BLOCK — identity kernel not re-read
  // Allow ground.sh to run (it's the first step of re-grounding)
  const toolInput = hookData.tool_input || hookData.input || {};
  const command = toolInput.command || '';
  if (command.includes('ground.sh')) {
    process.exit(0); // Allow grounding script
  }

  console.error(
    `COMPACTION GATE — BLOCKED. Identity files not re-read after compaction.\n` +
    `Missing: ${missing.join(', ')}\n` +
    `Read your identity kernel FIRST. Then this gate clears automatically.`
  );
  process.exit(2);
}

main().catch(() => process.exit(0));
