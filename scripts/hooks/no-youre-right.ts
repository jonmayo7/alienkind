/**
 * no-youre-right.ts — Blocks "You're right" from Keel's output.
 *
 * Chris Voss distinction: "you're right" = dismissal. "That's right" = breakthrough.
 * the human catches this immediately. 122+ learning-ledger corrections confirm it's wired
 * at the trigger level. Prompt instructions failed. This hook enforces.
 *
 * Event: PreToolUse (Edit, Write)
 * Action: BLOCK if new_string or content contains "You're right" or "you're right"
 *
 * Readers: Claude Code hook system
 * Writers: none
 */

import * as fs from 'fs';

const input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
const toolName = input.tool_name;

if (toolName !== 'Edit' && toolName !== 'Write') {
  process.exit(0);
}

const content = toolName === 'Edit'
  ? (input.tool_input?.new_string || '')
  : (input.tool_input?.content || '');

// Case-insensitive check for "you're right" (including curly quotes)
const patterns = [
  /\byou[''\u2019]re right\b/i,
  /\byoure right\b/i,
];

for (const pattern of patterns) {
  if (pattern.test(content)) {
    console.error(`BLOCKED — "You're right" detected. This is dismissal, not acknowledgment.`);
    console.error(`Use "that's right" or just make the point directly.`);
    console.error(`Ref: Chris Voss, character.md, 122+ learning-ledger corrections.`);
    process.exit(2);
  }
}

process.exit(0);
