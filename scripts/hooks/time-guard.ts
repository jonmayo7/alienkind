#!/usr/bin/env node

/**
 * Time Awareness Guard — PreToolUse hook for Edit and Write.
 *
 * Two enforcement layers:
 *
 * 1. DAY-OF-WEEK CHECK (blocking): When new content states "today is Sunday"
 *    or "It's Monday" or "Day: Wednesday" or similar day-of-week claims,
 *    validate against the actual current day. BLOCKS (exit 2) on mismatch —
 *    wrong day names are definitively incorrect and should never be written.
 *
 * 2. TIMESTAMP CHECK (warning): When new content contains a timestamp with
 *    a timezone marker (e.g., "10:30 CST"), check whether `date` was run
 *    recently. If not, warn that the timestamp may be incorrect.
 *
 * Gap closed: f6ab4252 — "time-awareness gap" where wrong day of week was
 * written to memory files. Now code-enforced, not prompt-dependent.
 *
 * Fires on: PreToolUse (Edit, Write)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();

// Memory files where timestamps matter
const MEMORY_PATTERNS = [
  /^memory\/daily\//,
  /^memory\/session-state\.md$/,
  /^memory\/sotu-execution-list\.md$/,
  /^BUILD_LOG\.md$/,
];

// Broader set — day-of-week errors matter in all prose we write
const PROSE_PATTERNS = [
  /^memory\//,
  /^identity\//,
  /^BUILD_LOG\.md$/,
  /^output\//,
];

// Timestamp pattern: HH:MM followed by timezone or AM/PM
const TIMESTAMP_RE = /\b\d{1,2}:\d{2}\s*(?:CST|CDT|UTC|EST|EDT|PST|PDT|AM|PM)\b/i;

// Day-of-week names
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Build regex patterns that match assertive day-of-week claims.
 * These are statements about what day it currently IS — not historical
 * or future references ("last Monday", "every Tuesday", "next Friday").
 */
function buildDayAssertionPattern(day) {
  return new RegExp(
    '(?:' +
      // "today is Monday" / "today's Monday"
      `today(?:'s| is)\\s+${day}` +
      '|' +
      // "It's Monday" / "It is Monday"
      `[Ii]t(?:'s| is)\\s+${day}` +
      '|' +
      // "Day: Monday" (grounding script output format)
      `Day:\\s*${day}` +
      '|' +
      // "this Monday" (referring to the current instance of this day)
      `[Tt]his\\s+${day}` +
      '|' +
      // "Happy Monday" / "Good Monday" — greeting for today
      `(?:Happy|Good)\\s+${day}` +
      '|' +
      // ISO date + day: "2026-04-07 (Monday)" or "2026-04-07 Monday"
      `\\d{4}-\\d{2}-\\d{2}\\s*\\(?${day}\\)?` +
      '|' +
      // "Monday, April 7" at start of line — date header
      `^\\s*${day},\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)` +
    ')',
    'im'
  );
}

const DAY_ASSERTION_PATTERNS = DAY_NAMES.map(buildDayAssertionPattern);

// Staleness window: 15 minutes
const STALENESS_WINDOW_SEC = 900;

function isMemoryFile(relPath) {
  return MEMORY_PATTERNS.some(p => p.test(relPath));
}

function isProseFile(relPath) {
  return PROSE_PATTERNS.some(p => p.test(relPath));
}

function hasTimestamp(text) {
  if (!text) return false;
  return TIMESTAMP_RE.test(text);
}

/**
 * Check if text asserts a specific day of the week.
 * Returns the asserted day name if found, null otherwise.
 */
function findAssertedDay(text) {
  if (!text) return null;
  for (let i = 0; i < DAY_NAMES.length; i++) {
    if (DAY_ASSERTION_PATTERNS[i].test(text)) {
      return DAY_NAMES[i];
    }
  }
  return null;
}

/**
 * Get the actual current day name using system date command.
 * Ground truth — never trust the model's belief about what day it is.
 */
function getActualDay() {
  try {
    return execSync("TZ='${TZ:-UTC}' date '+%A'", { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getNewContent(hookData) {
  const toolInput = hookData.tool_input || hookData.input || {};
  const toolName = hookData.tool_name || hookData.name || '';

  if (toolName === 'Edit' || toolName === 'edit') {
    return toolInput.new_string || '';
  } else if (toolName === 'Write' || toolName === 'write') {
    return toolInput.content || '';
  }
  return '';
}

function getHeaderContent(hookData) {
  const toolInput = hookData.tool_input || hookData.input || {};
  const toolName = hookData.tool_name || hookData.name || '';

  if (toolName === 'Edit' || toolName === 'edit') {
    return toolInput.new_string || '';
  } else if (toolName === 'Write' || toolName === 'write') {
    const content = toolInput.content || '';
    const lines = content.split('\n');
    const headerLines = lines.filter(l =>
      /^#+\s/.test(l) ||
      /^\*\*\[/.test(l) ||
      /^- \*\*\[/.test(l) ||
      /^Last updated:/.test(l)
    );
    return headerLines.join('\n');
  }
  return '';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';

  if (!filePath) process.exit(0);

  // Get relative path
  let relPath = filePath;
  if (filePath.startsWith(KEEL_DIR + '/')) {
    relPath = filePath.slice(KEEL_DIR.length + 1);
  }

  const isProse = isProseFile(relPath);
  const isMemory = isMemoryFile(relPath);

  if (!isProse && !isMemory) process.exit(0);

  const fullContent = getNewContent(hookData);

  // ── Layer 1: Day-of-Week Validation (BLOCKING) ──
  if (isProse) {
    const assertedDay = findAssertedDay(fullContent);
    if (assertedDay) {
      const actualDay = getActualDay();
      if (actualDay && assertedDay !== actualDay) {
        console.log('');
        console.log('DAY-OF-WEEK BLOCK — Content claims wrong day.');
        console.log(`  File: ${relPath}`);
        console.log(`  Written: "${assertedDay}"`);
        console.log(`  Actual:  "${actualDay}"`);
        console.log('  Run \`TZ="${TZ:-UTC}" date "+%A"\` and correct the day name.');
        console.log('');
        process.exit(2);
      }
    }
  }

  // ── Layer 2: Timestamp Staleness Warning (advisory) ──
  if (isMemory) {
    const headerContent = getHeaderContent(hookData);
    if (hasTimestamp(headerContent)) {
      const sessionId = hookData.session_id || process.ppid || 'unknown';
      const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;

      let tracking;
      try {
        tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
      } catch {
        tracking = {};
      }

      const dateEvidence = tracking.dateEvidence || 0;
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - dateEvidence;

      if (dateEvidence === 0) {
        console.log('');
        console.log('TIMESTAMP WARNING — Writing a timestamp without checking the time.');
        console.log(`File: ${relPath}`);
        console.log('Run \`date\` before writing timestamps to memory files.');
        console.log('No date command detected this session.');
        console.log('');
      } else if (elapsed > STALENESS_WINDOW_SEC) {
        const minAgo = Math.floor(elapsed / 60);
        console.log('');
        console.log(`TIMESTAMP WARNING — Last time check was ${minAgo} minutes ago.`);
        console.log(`File: ${relPath}`);
        console.log('Run \`date\` to refresh before writing timestamps.');
        console.log('');
      }
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = { findAssertedDay, getActualDay, DAY_NAMES, DAY_ASSERTION_PATTERNS, isProseFile, isMemoryFile, hasTimestamp, buildDayAssertionPattern };
}
