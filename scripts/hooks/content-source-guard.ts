#!/usr/bin/env node

/**
 * Content Source Guard — BLOCKS article writes without source knowledge loaded.
 *
 * PreToolUse hook for Write.
 *
 * When writing to output/drafts/ or output/articles/, requires that foundational
 * source files have been read this session. the human's work is partner-level knowledge,
 * not research material — don't write about what you haven't loaded.
 *
 * Required reads before any article draft:
 *   - memory/synthesis/book-synthesis.md (4 books, methodologies, philosophy)
 *   - memory/project-scopes/tia-pivot-conop.md (TIA framework, AIRE lineage)
 *
 * Uses session tracking from track-read.ts (PostToolUse Read).
 *
 * Exit 0 = allow, Exit 2 = block.
 * Fires on: PreToolUse (Write)
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

// Paths that trigger the guard (relative to ALIENKIND_DIR)
const GUARDED_PREFIXES = [
  'output/drafts/',
  'output/articles/',
];

// Required source files that must be read before writing articles
const REQUIRED_SOURCES = [
  { path: 'memory/synthesis/book-synthesis.md', label: 'Book synthesis (4 books, methodologies, philosophy)' },
  { path: 'memory/project-scopes/tia-pivot-conop.md', label: 'TIA ConOp (AIRE lineage, framework, guardrails)' },
];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { console.error('BLOCKED: unparseable hook input — failing closed'); process.exit(2); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';

  if (!filePath) process.exit(0);

  // Get relative path
  let relPath = filePath;
  if (filePath.startsWith(ALIENKIND_DIR + '/')) {
    relPath = filePath.slice(ALIENKIND_DIR.length + 1);
  }

  // Only guard article output paths
  const isArticleWrite = GUARDED_PREFIXES.some(prefix => relPath.startsWith(prefix));
  if (!isArticleWrite) process.exit(0);

  // Read session tracking (written by track-read.ts)
  const sessionId = hookData.session_id || process.ppid || 'unknown';
  const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;

  let tracking;
  try {
    tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
  } catch {
    tracking = { filesRead: [] };
  }

  const filesRead = tracking.filesRead || [];

  // Check which required sources are missing
  const missing = REQUIRED_SOURCES.filter(src => !filesRead.includes(src.path));

  if (missing.length > 0) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  CONTENT SOURCE GUARD — BLOCKED                             ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    console.error('║  Writing to article drafts requires loading source          ║');
    console.error('║  knowledge first. the human\'s work is partner-level knowledge,   ║');
    console.error('║  not research material.                                     ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    console.error('║  Missing reads:                                             ║');
    for (const src of missing) {
      console.error(`║    ✗ ${src.path}`);
      console.error(`║      ${src.label}`);
    }
    console.error('║                                                              ║');
    console.error('║  Read these files first, then retry the write.               ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(2);
  }

  // All sources loaded — allow
  process.exit(0);
}

main().catch(() => {
  console.error('BLOCKED: content-source-guard crashed — failing closed');
  process.exit(2);
});
