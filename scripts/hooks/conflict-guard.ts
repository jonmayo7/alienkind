#!/usr/bin/env node

/**
 * Conflict Guard — PreToolUse hook for Edit and Write.
 *
 * Checks if another terminal recently modified the file about to be edited.
 * Outputs a WARNING (not a block) so Keel can coordinate.
 *
 * Fires on: PreToolUse (Edit, Write)
 * Writers: none (read-only check against file-touches.json)
 * Readers: this hook
 */

const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}

// Infrastructure deps — degrade gracefully on a fresh fork
let getTerminalId: any;
try {
  getTerminalId = require(path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')).getTerminalId;
} catch {
  getTerminalId = () => 'unknown';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';
  if (!filePath) process.exit(0);

  // MUST use getTerminalId() — raw pid differs from keel.sh-assigned ID.
  const nodeId = getTerminalId();

  try {
    const { checkConflict } = require(path.resolve(__dirname, '..', 'lib', 'file-touches.ts'));
    const conflict = checkConflict(nodeId, filePath);

    if (conflict) {
      const ageMin = Math.round(conflict.ageMs / 60000);
      const fileName = filePath.split('/').pop();
      console.log('');
      console.log(`FILE CONFLICT — ${fileName}`);
      console.log(`  ${conflict.otherNodeId} ${conflict.operation}ed this file ${ageMin}m ago`);
      console.log(`  Coordinate before editing to avoid overwriting their changes.`);
      console.log('');
    }

    // Related-file conflict detection (mycelium v2)
    // Uses dynamic import graph — relationships computed from code, not a static table.
    const { getAllTouches } = require(path.resolve(__dirname, '..', 'lib', 'file-touches.ts'));
    const allTouches = getAllTouches();
    const ALIENKIND_DIR = resolveRepoRoot();
    let relPath = filePath;
    if (filePath.startsWith(ALIENKIND_DIR + '/')) relPath = filePath.slice(ALIENKIND_DIR.length + 1);

    // Get related files from import graph (dynamic — parsed from require/import statements)
    let relatedPaths: string[] = [];
    try {
      const { getRelatedFiles } = require(path.resolve(__dirname, '..', 'lib', 'import-graph.ts'));
      relatedPaths = getRelatedFiles(relPath);
    } catch { /* import graph unavailable — skip related check */ }

    // Also check non-code relationships (identity ↔ CLAUDE.md)
    const EXTRA_RELATIONSHIPS: Record<string, string[]> = {
      'identity/harness.md': ['CLAUDE.md'],
      'CLAUDE.md': ['identity/harness.md', 'identity/character.md'],
      'scripts/telegram-listener.ts': ['scripts/discord-listener.ts'],
      'scripts/discord-listener.ts': ['scripts/telegram-listener.ts'],
    };
    relatedPaths.push(...(EXTRA_RELATIONSHIPS[relPath] || []));

    for (const touch of allTouches) {
      if (touch.nodeId === nodeId) continue;
      const touchAge = Date.now() - touch.timestamp;
      if (touchAge > 15 * 60 * 1000) continue;

      let touchRelPath = touch.filePath;
      if (touchRelPath.startsWith(ALIENKIND_DIR + '/')) touchRelPath = touchRelPath.slice(ALIENKIND_DIR.length + 1);

      if (relatedPaths.includes(touchRelPath)) {
        const ageMin = Math.round(touchAge / 60000);
        console.log('');
        console.log(`RELATED FILE ACTIVITY — ${path.basename(touchRelPath)}`);
        console.log(`  You're editing: ${relPath}`);
        console.log(`  ${touch.nodeId} edited related file ${touchRelPath} ${ageMin}m ago`);
        console.log(`  These files are connected via import graph. Changes may need coordination.`);
        console.log('');
        break;
      }
    }
  } catch {
    // Never block — conflict detection is advisory
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
