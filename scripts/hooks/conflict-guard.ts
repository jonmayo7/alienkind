#!/usr/bin/env npx tsx

/**
 * Conflict Guard — PreToolUse hook for Edit and Write.
 *
 * Checks if another terminal recently modified the file about to be edited.
 * Outputs a WARNING (not a block) so terminals can coordinate before clobbering.
 *
 * Multi-terminal coherence: when two Claude Code sessions, a daemon, and a
 * channel listener all run against the same partner, this hook prevents
 * silent overwrites. The partner-as-architecture only works if everyone
 * touching it is aware of everyone else.
 *
 * Fires on: PreToolUse (Edit, Write).
 */

const path = require('path');

let getTerminalId: () => string;
let checkConflict: any;
try {
  const ft = require(path.resolve(__dirname, '..', 'lib', 'file-touches.ts'));
  getTerminalId = ft.getTerminalId;
  checkConflict = ft.checkConflict;
} catch {
  getTerminalId = () => 'unknown';
  checkConflict = () => null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';
  if (!filePath) process.exit(0);

  const nodeId = getTerminalId();

  try {
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
  } catch {
    // Never block — conflict detection is advisory
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
