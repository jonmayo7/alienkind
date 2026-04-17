#!/usr/bin/env node

/**
 * Handoff Intercept — UserPromptSubmit hook.
 *
 * Detects `/handoff` and runs chain-handoff.ts directly, bypassing the model entirely.
 * Zero thinking time. The hook captures all 10 dimensions, writes the handoff file +
 * chain marker, spawns a background kill to terminate the session, and exits 2
 * to block the message from reaching the model.
 *
 * Flow: /handoff → hook fires → chain-handoff.ts runs (~3s) → session killed → keel.sh chains
 * Old:  /handoff → Skill loads → model thinks 10s → bash runs → chain-handoff.ts → session killed
 *
 * Fires on: UserPromptSubmit
 * Exit 0: not a handoff command, pass through
 * Exit 2: handoff intercepted, message blocked from model
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const ALIENKIND_DIR = resolveRepoRoot();

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const prompt = (hookData.prompt || '').trim();

  // Only intercept exact /handoff command
  if (prompt !== '/handoff') {
    process.exit(0);
  }

  // --- Run chain-handoff.ts synchronously (captures all 10 dimensions) ---
  try {
    const output = execSync(
      `node "${path.join(ALIENKIND_DIR, 'scripts', 'chain', 'chain-handoff.ts')}" --auto --restart --trigger manual`,
      {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, ALIENKIND_DIR },
        cwd: ALIENKIND_DIR,
      }
    );
    // Print the chain-handoff output so the human sees dimension capture
    if (output.trim()) {
      process.stderr.write(output);
    }
  } catch (err) {
    // If chain-handoff fails, still let the message through to the model as fallback
    process.stderr.write(`Handoff intercept: chain-handoff failed, falling back to model. ${err.message || err}\n`);
    process.exit(0);
  }

  // Block the message from reaching the model — handoff is already written,
  // and --restart has spawned a background kill to terminate the session.
  console.log('Baton passing now.');
  process.exit(2);
}

main().catch(() => process.exit(0));
