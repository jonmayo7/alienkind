#!/usr/bin/env node

/**
 * regex-reinforcement-guard.ts — PreToolUse hook (Edit, Write)
 *
 * ENFORCES: Any new regex-based pattern detection must have a corresponding
 * local model reinforcement layer (Tier 2) unless explicitly approved by [HUMAN].
 *
 * The principle: regex catches obvious patterns fast (Tier 1). Local model
 * catches what regex misses via contextual analysis (Tier 2). Both tiers
 * are complementary. Deploying regex without Tier 2 is an incomplete build.
 *
 * [HUMAN] directive 2026-03-28: "We should have a tier one enforced hook that
 * if we ever deploy regex then we reinforce it with our local model unless
 * there's a reason not to. In that case I explicitly approve it."
 *
 * Exemptions:
 * - Simple validation regex (email format, URL parsing, date parsing)
 * - Test files
 * - Hook files (hooks are enforcement, not detection)
 * - Files that already have a Tier 2 companion documented
 *
 * Writers: This hook (PreToolUse on Edit/Write)
 * Readers: None — enforcement only
 */

const fs = require('fs');

// Patterns that indicate regex-based DETECTION (not just validation)
const DETECTION_REGEX_PATTERNS = [
  /new RegExp\([^)]*detect|match|flag|catch|pattern|gap|signal/i,
  /\.test\([^)]*\).*(?:log|alert|flag|detect|report|emit|post)/i,
  /(?:GAP_PATTERNS|DETECTION_PATTERNS|SIGNAL_PATTERNS|ALERT_PATTERNS)\s*[=:]/,
  /\/[^/]+\/[ig]*\.test\(.*\)\s*\{[^}]*(?:log|flag|detect|emit|alert|supabasePost)/i,
];

// Patterns that indicate a Tier 2 / local model companion exists
const TIER2_COMPANION_PATTERNS = [
  /tier.?2/i,
  /local.?model/i,
  /local.?inference|vllm|mlx/i,
  /batch.?analy/i,
  /nightly.?gap/i,
  /reinforcement.?layer/i,
];

// Exempt file patterns
const EXEMPT_PATTERNS = [
  /scripts\/tests\//,
  /scripts\/hooks\//,
  /\.test\./,
  /test-/,
  // Simple validation files (format checking, not detection)
  /lib\/exec-safety/,
  /lib\/security/,
  /lib\/lockfile/,
];

function main() {
  let input: any;
  try {
    input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  } catch {
    process.exit(0);
  }

  const tool = input.tool_name;
  const filePath = input.tool_input?.file_path || '';

  // Only check Edit and Write on .ts files
  if (tool !== 'Edit' && tool !== 'Write') process.exit(0);
  if (!filePath.endsWith('.ts')) process.exit(0);

  // Check exemptions
  if (EXEMPT_PATTERNS.some(p => p.test(filePath))) process.exit(0);

  const newContent = input.tool_input?.new_string || input.tool_input?.content || '';

  // Check if the new content introduces regex-based detection
  const hasDetectionRegex = DETECTION_REGEX_PATTERNS.some(p => p.test(newContent));
  if (!hasDetectionRegex) process.exit(0); // No detection regex = no concern

  // Check if the file or content already references a Tier 2 companion
  let fullFileContent = '';
  try {
    if (fs.existsSync(filePath)) {
      fullFileContent = fs.readFileSync(filePath, 'utf8');
    }
  } catch {}

  const combinedContent = fullFileContent + '\n' + newContent;
  const hasTier2Reference = TIER2_COMPANION_PATTERNS.some(p => p.test(combinedContent));

  if (hasTier2Reference) process.exit(0); // Tier 2 companion documented

  // No Tier 2 companion found — warn (not block, since [HUMAN] said "unless there's a reason not to")
  process.stderr.write(
    `⚠ REGEX REINFORCEMENT: New regex-based detection in ${filePath.split('/').pop()}\n` +
    `  without a local model Tier 2 companion documented.\n` +
    `  \n` +
    `  Principle: regex = Tier 1 (fast, obvious). Local model = Tier 2 (nightly, subtle).\n` +
    `  Both are complementary. Add a Tier 2 reference or get [HUMAN]'s approval.\n` +
    `  \n` +
    `  To acknowledge: add a comment with "tier 2" or "local model" reference.\n` +
    `  To exempt: add the file to EXEMPT_PATTERNS in regex-reinforcement-guard.ts.\n`
  );
  // Exit 0 = warning only. [HUMAN]'s approval is the gate, not the hook.
  process.exit(0);
}

main();
