#!/usr/bin/env node

/**
 * build-cycle.ts — Stateful tracking REMOVED 2026-04-10. Now only
 * does mycelium activity update + cross-terminal file touch recording.
 *
 * Previously: PostToolUse Edit/Write hook that accumulated codeFiles[]
 * into /tmp/keel-build-cycle-*.json, reset verifyEvidence flags on
 * every edit, and printed BUILD CYCLE reminders. Downstream hooks
 * (read-guard, guard-bash) then read that state and enforced VERIFY
 * gates that turned into ritualistic test re-runs because the tracking
 * never cleared on successful commits.
 *
 * Kept: the two side effects that were actually useful —
 *   - mycelium.updateActivity(): cross-terminal awareness ("terminal X
 *     is editing file Y right now")
 *   - file-touches.recordTouch(): conflict detection for concurrent
 *     edits across terminals
 *
 * Both are stateless per-edit, do not accumulate, and do not block.
 */

const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();

// Infrastructure deps — degrade gracefully on a fresh fork
let updateActivity: any, recordTouch: any, getTerminalId: any;
try {
  updateActivity = require(path.resolve(__dirname, '..', 'lib', 'mycelium.ts')).updateActivity;
  recordTouch = require(path.resolve(__dirname, '..', 'lib', 'file-touches.ts')).recordTouch;
  getTerminalId = require(path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')).getTerminalId;
} catch {
  updateActivity = () => {};
  recordTouch = () => {};
  getTerminalId = () => 'unknown';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData: any;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath: string = toolInput.file_path || '';
  if (!filePath) process.exit(0);

  // Mycelium activity + cross-terminal touch recording (side effects only,
  // no state accumulation, no blocking).
  try {
    let relPath = filePath;
    if (filePath.startsWith(KEEL_DIR + '/')) relPath = filePath.slice(KEEL_DIR.length + 1);
    const terminalId = getTerminalId();
    updateActivity(terminalId, `editing ${relPath.split('/').pop()}`);
    recordTouch(relPath, terminalId);
  } catch { /* best-effort */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
