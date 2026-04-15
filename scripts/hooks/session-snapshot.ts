#!/usr/bin/env node

/**
 * Session Snapshot — Stop hook.
 *
 * On session end (or after high response counts), automatically captures
 * a point-in-time snapshot of the structured state + git state.
 *
 * This is tier-1: runs automatically regardless of whether Keel remembered
 * to update state. Captures what code CAN capture (files modified, git diff,
 * timing). The semantic layer (threads, decisions, relational state) comes
 * from structured-state.json which Keel updates during the session.
 *
 * Fires on: Stop event (every assistant response)
 * Snapshots on: response 5 (early capture), then every 15th response, and session end
 */

const fs = require('fs');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const counterFile = `/tmp/keel-snapshot-counter-${sessionId}`;
  const stopReason = hookData.stop_hook_reason || hookData.reason || '';

  let count = 0;
  try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  count++;
  fs.writeFileSync(counterFile, String(count));

  // Determine if we should snapshot
  const isSessionEnd = stopReason === 'session_end' || stopReason === 'user_exit';
  const isEarlyCapture = count === 5;
  const isPeriodicCapture = count > 0 && count % 15 === 0;

  if (!isSessionEnd && !isEarlyCapture && !isPeriodicCapture) {
    process.exit(0);
  }

  try {
    const { saveSnapshot, updateState, captureAutoSnapshot, writeSessionStateMd } = require(path.join(KEEL_DIR, 'scripts', 'lib', 'persistence.ts'));

    // Auto-update the session markers
    const auto = captureAutoSnapshot();
    updateState({
      session_markers: {
        started: '', // preserve existing
        last_updated: auto.last_updated,
        files_modified: auto.files_modified,
        tasks_completed: [], // preserve existing
      },
    });

    const label = isSessionEnd ? 'session-end' : isEarlyCapture ? 'early-capture' : `response-${count}`;
    const snapshotPath = await saveSnapshot(label);

    // session-state.md generation disabled — structured-state.json is the source of truth.
    // session-state.md was a generated view that caused stale reads. Daily files + structured-state.json
    // are now the canonical state documents. session-state.md is no longer maintained.
    // writeSessionStateMd();

    if (isSessionEnd) {
      console.log(`Session snapshot saved: ${path.basename(snapshotPath)}`);
    }
  } catch (err) {
    // Snapshot should never block session — fail silently
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
