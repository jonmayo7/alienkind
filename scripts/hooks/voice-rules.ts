#!/usr/bin/env node
/**
 * voice-rules.ts — PreToolUse Edit/Write blocker driven by per-clone
 * pattern file.
 *
 * The tier-3 → tier-1 upgrade named in the 2026-04-20 Conn × Kael bench
 * task 07: loaded identity rules drift under pressure. Moving the
 * enforcement from auto-memory prompt to PreToolUse code means the rule
 * holds regardless of context pressure.
 *
 * Pattern source: .voice-rules.local at the repo root (gitignored,
 * per-clone). One regex per line. Lines starting with # are skipped.
 * No file = no enforcement, hook exits 0 silently.
 *
 * Enable (once per clone):
 *   git config core.hooksPath .githooks   # already done for commit-msg
 *   Register this hook in .claude/settings.local.json PreToolUse Edit
 *   and Write matchers (see settings.local.json.example).
 *
 * Fires on: PreToolUse (Edit, Write)
 * Exit: 2 if a pattern matches the content being written; 0 otherwise.
 */

const fs = require('fs');
const path = require('path');

const input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
const toolName = input.tool_name;

if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const content: string =
  toolName === 'Edit'
    ? input.tool_input?.new_string || ''
    : input.tool_input?.content || '';

if (!content) process.exit(0);

// Repo root is two levels up from scripts/hooks/
const rulesFile = path.resolve(__dirname, '..', '..', '.voice-rules.local');

if (!fs.existsSync(rulesFile)) process.exit(0);

const lines = fs.readFileSync(rulesFile, 'utf-8').split(/\r?\n/);
const patterns: Array<{ re: RegExp; raw: string }> = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('#')) continue;
  try {
    patterns.push({ re: new RegExp(trimmed), raw: trimmed });
  } catch {
    // malformed pattern — skip silently, don't let bad regex break the gate
  }
}

for (const { re, raw } of patterns) {
  if (re.test(content)) {
    console.error(`BLOCKED — voice-rules violation. Pattern: /${raw}/`);
    console.error(`Content matched in ${toolName} — rewrite without it.`);
    console.error(`Patterns live in .voice-rules.local (gitignored, per-clone).`);
    process.exit(2);
  }
}

process.exit(0);
