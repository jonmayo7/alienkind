#!/usr/bin/env node

/**
 * Build Cycle: READ tracking — PostToolUse hook for Read.
 *
 * Fires after every file read. Tracks which files were read this session
 * in the build cycle tracking file. Specifically flags when critical
 * context files are consulted (WIRING_MANIFEST).
 *
 * This enables READ stage enforcement: other hooks can check whether
 * required context was read before code modifications.
 *
 * Fires on: PostToolUse (Read)
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
const ALIENKIND_DIR = resolveRepoRoot();

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';

  if (!filePath) process.exit(0);

  // Get relative path from ALIENKIND_DIR
  let relPath = filePath;
  if (filePath.startsWith(ALIENKIND_DIR + '/')) {
    relPath = filePath.slice(ALIENKIND_DIR.length + 1);
  }

  // Session-level tracking file
  const terminalId = process.env.ALIENKIND_TERMINAL_ID || hookData.session_id || process.ppid || 'unknown';
  const trackFile = `/tmp/alienkind-build-cycle-${terminalId}.json`;

  let tracking = {
    codeFiles: [],
    integrateDocs: [],
    filesRead: [],
    readEvidence: { wiringManifest: false },
    verifyEvidence: { syntax: false, test: false },
  };

  try {
    tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
  } catch { /* first read this session — will create tracking file */ }

  // Ensure new fields exist (backward compat with older tracking files)
  if (!Array.isArray(tracking.filesRead)) tracking.filesRead = [];
  if (!tracking.readEvidence) tracking.readEvidence = { wiringManifest: false };

  // Track the file read (cap at 50 to avoid unbounded growth)
  if (!tracking.filesRead.includes(relPath) && tracking.filesRead.length < 50) {
    tracking.filesRead.push(relPath);
  }

  // Flag critical context reads
  if (relPath === 'config/WIRING_MANIFEST.md') {
    tracking.readEvidence.wiringManifest = true;
  }

  // Write tracking state
  try {
    fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
  } catch { /* best effort */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
