#!/usr/bin/env node
/**
 * Full Keel Gate — Tier 1 Blocking Hook
 *
 * BLOCKS any code edit that introduces lightweight mode, dead invocation patterns
 * (invokeCommunity, invokeLight), or community-tier invocations in production
 * scripts. [HUMAN] is the sole authority on deviations from full Keel invocation.
 *
 * Event: PreToolUse (Edit, Write)
 * Enforcement: exit 2 = hard block
 *
 * Authorized by [HUMAN]: 2026-03-30
 * "I am the sole source of approving authority on what level is being invoked."
 */

const fs = require('fs');
const path = require('path');

const TOOL_NAME = process.env.CLAUDE_TOOL_NAME || '';
const FILE_PATH = process.env.CLAUDE_FILE_PATH || '';

// Only check Edit and Write on .ts files in scripts/
if (!['Edit', 'Write'].includes(TOOL_NAME)) process.exit(0);
if (!FILE_PATH.includes('scripts/') || !FILE_PATH.endsWith('.ts')) process.exit(0);

// Skip test files — they may reference these patterns for testing
const basename = path.basename(FILE_PATH);
if (basename.startsWith('test-')) process.exit(0);

// Skip the invoke-keel.ts definition file itself (contains the function definitions)
if (basename === 'invoke-keel.ts') process.exit(0);

// Read the new content being written/edited
const input = process.env.CLAUDE_TOOL_INPUT || '';

// Patterns that indicate lightweight/community mode usage
const BLOCKED_PATTERNS = [
  { pattern: /lightweight\s*:\s*true/i, name: 'lightweight: true' },
  { pattern: /invokeCommunity\s*\(/i, name: 'invokeCommunity()' },
  { pattern: /complexity\s*:\s*['"]community['"]/i, name: "complexity: 'community'" },
  { pattern: /complexity\s*:\s*['"]light['"]/i, name: "complexity: 'light'" },
  { pattern: /complexity\s*:\s*['"]medium['"]/i, name: "complexity: 'medium'" },
];

for (const { pattern, name } of BLOCKED_PATTERNS) {
  if (pattern.test(input)) {
    console.error(`
============================================
  FULL KEEL GATE — BLOCKED
============================================

  Attempted: ${name}
  File: ${FILE_PATH}

  EVERY invokeKeel call must use full Keel:
    complexity: 'heavy'
    injectIdentity: true

  Lightweight, community, and any non-full-Keel
  invocation is PROHIBITED without [HUMAN]'s explicit
  approval in this session.

  [HUMAN] is the sole authority on invocation level.
  Authorized: 2026-03-30

============================================
`);
    process.exit(2);
  }
}
