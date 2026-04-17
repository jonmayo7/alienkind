#!/usr/bin/env node

/**
 * Verification Guard — PreToolUse hook for Edit and Write.
 *
 * Problem: Keel writes service status claims and schedule claims to memory
 * files based on stale grounding data instead of live checks. "All 4 services
 * running" without running `launchctl list | grep example`. "Keith meeting at
 * 1 PM" without running `google-calendar.ts list`.
 *
 * Solution: When new content written to memory files contains service-status
 * or calendar/schedule keywords, check whether the relevant verification
 * command was run recently. If not, warn.
 *
 * Evidence sources (written by audit-bash.sh PostToolUse):
 *   - serviceEvidence: timestamp of last `launchctl list` call
 *   - calendarEvidence: timestamp of last `google-calendar.ts` call
 *
 * Enforcement level: BLOCKING (exit 2). Warnings are prompts in hook form —
 * under cognitive load, they get ignored. The cost of blocking is one
 * `launchctl` or `google-calendar.ts` call (seconds). The cost of not
 * blocking is false claims written to the permanent record.
 *
 * Fires on: PreToolUse (Edit, Write)
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

// Memory files where verification matters
const MEMORY_PATTERNS = [
  /^memory\/daily\//,
  /^memory\/session-state\.md$/,
  /^BUILD_LOG\.md$/,
];

// Service status patterns — specific enough to avoid false positives on "running" alone
const SERVICE_PATTERNS = [
  /\bservices?\s+(running|healthy|stopped|dead|down|up)\b/i,
  /\b(daemon|telegram|discord|caffeinate)\s*(listener)?\s*[\(:]?\s*(running|healthy|PID|stopped)\b/i,
  /\bPID\s+\d+\b/,
  /\bcom\.example\./,
  /\ball\s+\d+\s+services?\b/i,
  /\blaunchd\b/i,
  /\bRUNNING\b/,        // ALL-CAPS "RUNNING" is always a service claim
  /\bUNHEALTHY\b/i,
  /\bHEALTHY\b/,        // ALL-CAPS "HEALTHY"
];

// Calendar/schedule patterns — things that indicate a schedule claim
const CALENDAR_PATTERNS = [
  /\b\d{1,2}:\d{2}\s*(AM|PM)\s*[—–-]\s*/i,  // "1:00 PM — Meeting"
  /\bappointments?\s+(until|from|at)\b/i,      // "appointments until 11:30"
  /\bmeeting\s+(at|with)\b/i,                   // "meeting at 1 PM"
  /\bcalendar\s+(shows?|has|lists?)\b/i,        // "calendar shows..."
  /\bno\s+(conflicts?|events?|meetings?)\b/i,   // "no conflicts"
  /\bscheduled?\s+(for|at)\b/i,                 // "scheduled for 2 PM"
  /\bfree\s+(until|from|at)\b/i,               // "free until 3 PM"
  /\bnext\s+(appointment|meeting|event)\b/i,    // "next meeting"
];

// Completion claim patterns — phrases claiming tests passed or code compiles
// Targets the #1 correction pattern: premature completion claims without evidence
// (9/14 corrections on 2026-03-31 were verify_before_claiming)
const TEST_COMPLETION_PATTERNS = [
  /\ball\s+tests?\s+(pass|passing|clean|green)\b/i,
  /\btests?\s+(pass|passing|clean|green)\b/i,
  /\b(verified|confirmed)\s+(with|via|by)\s+tests?\b/i,
  /\btest\s+suite\s+(clean|passing|green)\b/i,
  /\b\d+\s+tests?\s+pass/i,             // "14 tests pass"
  /\bzero\s+(test\s+)?failures\b/i,
];

const SYNTAX_COMPLETION_PATTERNS = [
  /\b(TypeScript|tsc|TS)\s+(clean|compiles?\s+clean|no\s+errors)\b/i,
  /\bcompiles?\s+clean\b/i,
  /\bno\s+(type|typescript|tsc|compilation)\s+errors?\b/i,
  /\bsyntax\s+(clean|verified|valid)\b/i,
];

// Task completion claim patterns — catch "done", "complete", "all working" etc.
// written to memory files when code was edited but no verification ran.
// Targets the #1 correction cluster: premature_completion_claim_repeated (sev 9)
// and incomplete_audit_repeated (sev 8) from 2026-03-31 self-assessment.
// Only fires when codeFiles were modified this session (context: code work, not docs).
const TASK_COMPLETION_PATTERNS = [
  /\b(?:done|finished|completed?|shipped)\s+(?:with|—|:)\s+/i,   // "done with vectorization", "finished — all clean"
  /\b(?:all|everything)\s+(?:working|clean|fixed|resolved|verified|passing)\b/i,  // "all working", "everything clean"
  /\bfully\s+(?:verified|tested|working|complete|operational)\b/i,  // "fully verified", "fully operational"
  /\bnothing\s+(?:left|remaining|else|missed)\b/i,                  // "nothing left", "nothing missed"
  /\b(?:zero|no)\s+(?:issues?|gaps?|failures?|problems?)\s+(?:remain|left|found)\b/i,  // "zero issues remain"
  /\bverified\s+(?:end.to.end|e2e|complete|working)\b/i,           // "verified end-to-end"
  /\b100%\s+(?:complete|done|verified|working)\b/i,                 // "100% complete"
];

// Staleness windows
const SERVICE_STALENESS_SEC = 300;   // 5 minutes
const CALENDAR_STALENESS_SEC = 600;  // 10 minutes

function isMemoryFile(relPath) {
  return MEMORY_PATTERNS.some(p => p.test(relPath));
}

function matchesPatterns(text, patterns) {
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[0];
  }
  return null;
}

// Check if a match appears inside quotes or code blocks (meta-documentation, not a claim)
function isQuotedContext(text, match) {
  const idx = text.indexOf(match);
  if (idx < 0) return false;
  // Check 30 chars before the match for quote/code markers
  const before = text.slice(Math.max(0, idx - 30), idx);
  if (/["'`]/.test(before.slice(-2))) return true;           // inside quotes
  if (/```/.test(before)) return true;                        // inside code block
  if (/\bwriting\s+["'"]/.test(before)) return true;          // "writing 'tests pass'" pattern
  if (/\bblocks?\s+["'"]/.test(before)) return true;          // "blocks 'tests pass'" pattern
  if (/\bclaim/.test(before)) return true;                    // meta-discussion about claims
  if (/\bpattern/.test(before)) return true;                  // describing patterns
  return false;
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';
  const toolName = hookData.tool_name || hookData.name || '';

  if (!filePath) process.exit(0);

  // Get relative path
  let relPath = filePath;
  if (filePath.startsWith(ALIENKIND_DIR + '/')) {
    relPath = filePath.slice(ALIENKIND_DIR.length + 1);
  }

  // Only enforce on memory files
  if (!isMemoryFile(relPath)) process.exit(0);

  // Get the new content being written
  let newContent = '';
  if (toolName === 'Edit' || toolName === 'edit') {
    newContent = toolInput.new_string || '';
  } else if (toolName === 'Write' || toolName === 'write') {
    newContent = toolInput.content || '';
  }

  if (!newContent) process.exit(0);

  // Load tracking file
  const sessionId = hookData.session_id || process.ppid || 'unknown';
  const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;

  let tracking;
  try {
    tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
  } catch {
    tracking = {};
  }

  const now = Math.floor(Date.now() / 1000);
  const warnings = [];

  // Check service status claims
  const serviceMatch = matchesPatterns(newContent, SERVICE_PATTERNS);
  if (serviceMatch) {
    const serviceEvidence = tracking.serviceEvidence || 0;
    const elapsed = now - serviceEvidence;

    if (serviceEvidence === 0) {
      warnings.push(
        `SERVICE STATUS WARNING — Writing "${serviceMatch}" without checking.` +
        `\n  File: ${relPath}` +
        `\n  Run \`launchctl list | grep example\` before claiming service status.` +
        `\n  No launchctl command detected this session.`
      );
    } else if (elapsed > SERVICE_STALENESS_SEC) {
      warnings.push(
        `SERVICE STATUS WARNING — Last service check was ${formatElapsed(elapsed)} ago.` +
        `\n  File: ${relPath}` +
        `\n  Matched: "${serviceMatch}"` +
        `\n  Run \`launchctl list | grep example\` to refresh.`
      );
    }
  }

  // Check calendar/schedule claims
  const calendarMatch = matchesPatterns(newContent, CALENDAR_PATTERNS);
  if (calendarMatch) {
    const calendarEvidence = tracking.calendarEvidence || 0;
    const elapsed = now - calendarEvidence;

    if (calendarEvidence === 0) {
      warnings.push(
        `CALENDAR WARNING — Writing "${calendarMatch}" without checking.` +
        `\n  File: ${relPath}` +
        `\n  Run \`npx tsx scripts/lib/google-calendar.ts list\` before making schedule claims.` +
        `\n  No calendar command detected this session.`
      );
    } else if (elapsed > CALENDAR_STALENESS_SEC) {
      warnings.push(
        `CALENDAR WARNING — Last calendar check was ${formatElapsed(elapsed)} ago.` +
        `\n  File: ${relPath}` +
        `\n  Matched: "${calendarMatch}"` +
        `\n  Run \`npx tsx scripts/lib/google-calendar.ts list\` to refresh.`
      );
    }
  }

  // Check test completion claims (skip if match is in quoted/meta context)
  const testMatch = matchesPatterns(newContent, TEST_COMPLETION_PATTERNS);
  if (testMatch && !isQuotedContext(newContent, testMatch)) {
    const verifyEvidence = tracking.verifyEvidence || {};
    if (!verifyEvidence.test) {
      warnings.push(
        `TEST CLAIM WARNING — Writing "${testMatch}" without running tests.` +
        `\n  File: ${relPath}` +
        `\n  Run the relevant test (e.g. \`node scripts/tests/test-*.ts\`) before claiming tests pass.` +
        `\n  No test execution detected this session.`
      );
    }
  }

  // Check syntax/compilation claims (skip if match is in quoted/meta context)
  const syntaxMatch = matchesPatterns(newContent, SYNTAX_COMPLETION_PATTERNS);
  if (syntaxMatch && !isQuotedContext(newContent, syntaxMatch)) {
    const verifyEvidence = tracking.verifyEvidence || {};
    if (!verifyEvidence.syntax) {
      warnings.push(
        `SYNTAX CLAIM WARNING — Writing "${syntaxMatch}" without compiling.` +
        `\n  File: ${relPath}` +
        `\n  Run \`npx tsc --noEmit\` or \`node -c <file>\` before claiming clean compilation.` +
        `\n  No syntax check detected this session.`
      );
    }
  }

  // Check task completion claims — only when code was edited this session
  // (avoids false positives on pure documentation/conversation entries)
  const codeFiles = tracking.codeFiles || [];
  if (codeFiles.length > 0) {
    const taskMatch = matchesPatterns(newContent, TASK_COMPLETION_PATTERNS);
    if (taskMatch && !isQuotedContext(newContent, taskMatch)) {
      const verifyEvidence = tracking.verifyEvidence || {};
      const hasAnyVerification = verifyEvidence.test || verifyEvidence.syntax || verifyEvidence.flow;
      if (!hasAnyVerification) {
        warnings.push(
          `TASK COMPLETION WARNING — Writing "${taskMatch}" after editing code but running zero verification.` +
          `\n  File: ${relPath}` +
          `\n  Code modified: ${codeFiles.slice(0, 3).join(', ')}${codeFiles.length > 3 ? ` (+${codeFiles.length - 3} more)` : ''}` +
          `\n  Run at least one: syntax check (\`node -c\`), test (\`node scripts/tests/test-*\`), or flow test.` +
          `\n  Premature completion claims are the #1 trust-erosion pattern. Verify, then claim.`
        );
      }
    }
  }

  // Print warnings and BLOCK if any found
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) {
      console.log(w);
      console.log('');
    }
    console.log('BLOCKED — verify before claiming. Run the check, then retry the write.');
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
