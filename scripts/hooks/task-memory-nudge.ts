#!/usr/bin/env node

/**
 * Task Memory Nudge — PostToolUse hook on TodoWrite.
 *
 * When a todo is marked as completed, checks if today's daily memory
 * file was recently updated. If not, outputs an advisory reminder.
 *
 * From CLAUDE.md: "Write events, decisions, learnings to today's daily
 * file immediately" + "After every completed task... one-line entry"
 *
 * This is the W1 conversion from the three-property audit:
 *   - Trigger: TodoWrite call (crisp — tool call is unambiguous)
 *   - Cost: <5ms (file stat)
 *   - Feedback: immediate advisory
 *
 * Fires on: PostToolUse (TodoWrite)
 * Output: advisory reminder when task completed but daily file stale
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
const STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function getDailyFilePath(): string {
  const today = new Date().toISOString().split('T')[0];
  return path.join(KEEL_DIR, 'memory', 'daily', `${today}.md`);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  // Check if any todo was just marked completed
  const toolInput = hookData.tool_input || {};
  const todos = toolInput.todos || [];

  const hasCompletedTask = todos.some((t: any) => t.status === 'completed');
  if (!hasCompletedTask) process.exit(0);

  // Check daily file staleness
  const dailyFile = getDailyFilePath();
  try {
    const stat = fs.statSync(dailyFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALENESS_THRESHOLD_MS) {
      const ageMin = Math.round(ageMs / 60000);
      console.log(
        `TASK MEMORY NUDGE — You just completed a task, but today's daily file ` +
        `hasn't been updated in ${ageMin}m.\n` +
        'Write a one-line entry documenting what was completed and any decisions made.\n' +
        'CLAUDE.md: "After every completed task — one-line entry to daily file."'
      );
    }
  } catch {
    console.log(
      'TASK MEMORY NUDGE — You just completed a task, but today\'s daily file doesn\'t exist.\n' +
      'Create it and document what was completed.'
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
