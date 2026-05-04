#!/usr/bin/env npx tsx

/**
 * build-cycle — PostToolUse hook for Edit and Write.
 *
 * Records every file write to the file-touches index so other terminals
 * can detect conflicts before clobbering each other.
 *
 * Pairs with conflict-guard (PreToolUse) — together they form the
 * multi-terminal coherence layer.
 *
 * Fires on: PostToolUse (Edit, Write).
 */

const path = require('path');

let getTerminalId: () => string;
let recordTouch: any;
try {
  const ft = require(path.resolve(__dirname, '..', 'lib', 'file-touches.ts'));
  getTerminalId = ft.getTerminalId;
  recordTouch = ft.recordTouch;
} catch {
  getTerminalId = () => 'unknown';
  recordTouch = () => {};
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';
  const toolName = (hookData.tool_name || hookData.name || '').toLowerCase();
  if (!filePath) process.exit(0);

  const operation: 'edit' | 'write' =
    toolName === 'write' ? 'write' :
    toolName === 'edit' ? 'edit' :
    'edit';

  try {
    recordTouch(getTerminalId(), filePath, operation);
  } catch {
    // Schema violations re-throw, but we never block the tool call
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
