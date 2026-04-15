#!/usr/bin/env node

/**
 * Read Mode Guard — PreToolUse hook for Read.
 *
 * Enforces KEEL_SESSION_MODE restrictions on file reads.
 * Containment Fields — each mode gets 2 of 3 capabilities:
 *
 *   BUILDER mode blocks reads to:
 *     - .env (service keys)
 *     - identity/ (character.md, commitments.md, orientation.md, harness.md, user.md)
 *     - memory/synthesis/clients/ (client data)
 *     - config/daemon-jobs.ts (security policy — mode assignments)
 *     - config/policies/ (OPA policy files)
 *
 *   OPERATOR mode blocks reads to:
 *     - .env (service keys — operators don't need raw key access)
 *
 *   ANALYST mode (or no mode set): allow everything.
 *
 * Fails CLOSED on unparseable JSON input (exit 2, not exit 0).
 *
 * Exit 0 = allow, Exit 2 = block.
 * Fires on: PreToolUse (Read)
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

// Paths blocked per mode
const BUILDER_BLOCKED = [
  '.env',
  'identity/',
  'memory/synthesis/clients/',
  'config/daemon-jobs.ts',
  'config/policies/',
];

const OPERATOR_BLOCKED = [
  '.env',
];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    console.error('BLOCKED: unparseable hook input — failing closed');
    process.exit(2);
  }

  const toolInput = hookData.tool_input || hookData.input || {};
  const toolName = hookData.tool_name || hookData.name || '';

  // Handle Read, Grep, and Glob tools — different input schemas
  let filePath = toolInput.file_path || '';  // Read tool
  if (!filePath && (toolName === 'Grep' || toolName === 'grep')) {
    filePath = toolInput.path || '';  // Grep searches a path
  }
  if (!filePath && (toolName === 'Glob' || toolName === 'glob')) {
    filePath = toolInput.path || '';  // Glob searches a path
  }

  if (!filePath) process.exit(0);

  // Get relative path from KEEL_DIR
  let relPath = filePath;
  if (filePath.startsWith(KEEL_DIR + '/')) {
    relPath = filePath.slice(KEEL_DIR.length + 1);
  }

  // Skip files outside the keel directory
  if (filePath === relPath && !filePath.startsWith(KEEL_DIR)) {
    process.exit(0);
  }

  // Check session mode
  const sessionMode = process.env.KEEL_SESSION_MODE;
  if (!sessionMode || sessionMode === 'analyst') {
    process.exit(0);
  }

  // Determine which paths are blocked for this mode
  let blockedPaths = [];
  if (sessionMode === 'builder') {
    blockedPaths = BUILDER_BLOCKED;
  } else if (sessionMode === 'operator') {
    blockedPaths = OPERATOR_BLOCKED;
  }

  // Check if the relative path matches any blocked path
  for (const blocked of blockedPaths) {
    const isBlocked = blocked.endsWith('/')
      ? relPath.startsWith(blocked)
      : relPath === blocked;

    if (isBlocked) {
      console.error(`BLOCKED by session mode: ${sessionMode} mode cannot read ${relPath}`);
      if (blocked === '.env') {
        console.error('Service keys require analyst mode (interactive terminal with [HUMAN]).');
      } else if (blocked.startsWith('identity/')) {
        console.error('Identity files require analyst mode.');
      } else if (blocked.startsWith('memory/synthesis/clients/')) {
        console.error('Client data requires analyst or operator mode.');
      } else if (blocked === 'config/daemon-jobs.ts') {
        console.error('Security policy (mode assignments) requires analyst mode.');
      } else if (blocked.startsWith('config/policies/')) {
        console.error('OPA policy files require analyst mode.');
      }
      process.exit(2);
    }
  }

  // Allow
  process.exit(0);
}

main().catch(() => {
  console.error('BLOCKED: read-mode-guard crashed — failing closed');
  process.exit(2);
});
