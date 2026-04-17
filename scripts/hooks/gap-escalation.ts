#!/usr/bin/env node

/**
 * Gap Escalation — PostToolUse hook for Edit and Write.
 *
 * Detects the "documentation-satisfies-completion" trap: when the same gap
 * keyword appears in consecutive operator cycle entries (### Operator Cycle
 * or "I checked at" lines) in a daily file without a corresponding code edit
 * in the intervening period.
 *
 * After 3+ mentions of the same gap with no code edits between them,
 * outputs an escalation nudge: act now or explicitly defer.
 *
 * This is a nudge, NOT a gate — always exits 0.
 *
 * Fires on: PostToolUse (Edit, Write)
 * Targets: memory/daily/*.md files only
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

// Gap phrases that indicate a known issue is being re-documented without action.
// Each entry is [regex pattern, human-readable label].
// Patterns are case-insensitive and match within operator cycle text blocks.
const GAP_PATTERNS = [
  [/still blank/i, 'still blank'],
  [/still unwritten/i, 'still unwritten'],
  [/still needs to be written/i, 'still needs writing'],
  [/still needs (?:a )?terminal session/i, 'needs terminal session'],
  [/needs terminal session/i, 'needs terminal session'],
  [/still needs prose/i, 'still needs prose'],
  [/still unaddressed/i, 'still unaddressed'],
  [/deadline today/i, 'deadline today'],
  [/sections? still blank/i, 'sections still blank'],
  [/both sections? (?:still )?blank/i, 'sections still blank'],
  [/still pending/i, 'still pending'],
  [/not yet (?:written|built|shipped|implemented|wired|fixed)/i, 'not yet done'],
  [/still (?:broken|failing|down)/i, 'still broken'],
  [/\bstill empty\b/i, 'still empty'],
  [/\bnever prioritized\b/i, 'never prioritized'],
  [/same (?:gap|issue|problem|bug) (?:as |from )?(?:last|yesterday|earlier)/i, 'recurring gap'],
];

// Directories whose edits count as "action taken" (code, config, scripts)
const CODE_DIRS = ['scripts/', 'config/', '.claude/'];

function isDaily(filePath) {
  const rel = filePath.startsWith(ALIENKIND_DIR + '/')
    ? filePath.slice(ALIENKIND_DIR.length + 1)
    : filePath;
  return /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(rel);
}

/**
 * Extract keel cycle text blocks from daily file content.
 * Returns an array of { header, text } objects.
 *
 * Keel cycle entries are:
 *   - Lines starting with "### Keel Cycle" (or legacy "### Operator Cycle")
 *   - Lines starting with "I checked at"
 *
 * For "### Keel Cycle" headers, the text block runs until the next ### or ##.
 * For "I checked at" lines, the text is the full line (they're single-line entries).
 */
function extractKeelCycleEntries(content) {
  const lines = content.split('\n');
  const entries = [];
  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "I checked at" — single line entry
    if (/^I checked at/i.test(line.trim())) {
      // If we had a running block, close it first
      if (currentBlock) {
        entries.push(currentBlock);
        currentBlock = null;
      }
      entries.push({ header: line.trim(), text: line.trim() });
      continue;
    }

    // "### Keel Cycle" or legacy "### Operator Cycle" — multi-line block
    if (/^### (?:Keel|Operator) Cycle/i.test(line.trim())) {
      if (currentBlock) {
        entries.push(currentBlock);
      }
      currentBlock = { header: line.trim(), text: '' };
      continue;
    }

    // If we're inside a Keel Cycle block, accumulate text
    if (currentBlock) {
      // End the block on next ## or ### heading
      if (/^#{2,3}\s/.test(line.trim()) && !/^### (?:Keel|Operator) Cycle/i.test(line.trim())) {
        entries.push(currentBlock);
        currentBlock = null;
      } else {
        currentBlock.text += line + '\n';
      }
    }
  }

  // Close any trailing block
  if (currentBlock) {
    entries.push(currentBlock);
  }

  return entries;
}

/**
 * Scan entries for repeated gap patterns and return escalation messages.
 * A gap is "repeated" if it appears in 3+ entries with the same normalized label.
 *
 * We track code edits via the session tracking file. If code was edited during
 * this session, we reset the gap counter (someone took action).
 */
function detectRepeatedGaps(entries, codeEditedThisSession) {
  // Count how many consecutive entries (from the end) mention each gap
  // We scan backwards to find the current streak
  const gapStreaks = new Map(); // label -> count of consecutive mentions from latest

  // Build a per-gap occurrence list (indices into entries array)
  const gapOccurrences = new Map(); // label -> [indices]

  for (let i = 0; i < entries.length; i++) {
    const text = entries[i].text;
    for (const [pattern, label] of GAP_PATTERNS) {
      if (pattern.test(text)) {
        if (!gapOccurrences.has(label)) {
          gapOccurrences.set(label, []);
        }
        gapOccurrences.get(label).push(i);
      }
    }
  }

  const escalations = [];

  for (const [label, indices] of gapOccurrences) {
    if (indices.length < 3) continue;

    // Check for consecutive streak ending at the latest mention
    // A "consecutive" means appearing in entries without too large a gap
    // (we count total occurrences, not strict adjacency — the pattern is
    // "you mentioned this N times total in operator cycles")
    const count = indices.length;

    // If code was edited this session, the latest mention might be post-fix.
    // Only escalate if no code edit happened (the whole point: documenting without acting).
    if (codeEditedThisSession) continue;

    escalations.push({ label, count });
  }

  return escalations;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';

  if (!filePath) process.exit(0);

  // Only fire for daily memory files
  if (!isDaily(filePath)) process.exit(0);

  // Read the daily file
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    process.exit(0);
  }

  // Check if code was edited this session (via build-cycle tracking file)
  const sessionId = hookData.session_id || process.ppid || 'unknown';
  const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;
  let codeEditedThisSession = false;
  try {
    const tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    codeEditedThisSession = Array.isArray(tracking.codeFiles) && tracking.codeFiles.length > 0;
  } catch { /* no tracking file = no code edits */ }

  // Extract operator cycle entries
  const entries = extractKeelCycleEntries(content);
  if (entries.length < 3) process.exit(0);

  // Detect repeated gaps
  const escalations = detectRepeatedGaps(entries, codeEditedThisSession);

  if (escalations.length > 0) {
    console.log('');
    console.log('GAP ESCALATION — documentation-satisfies-completion detected:');
    for (const { label, count } of escalations) {
      console.log(`  "${label}" mentioned ${count} times in operator cycles with no code edit.`);
      console.log(`  You identified this gap ${count} times without acting. Either act now or explicitly defer with a reason.`);
    }
    console.log('');
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
