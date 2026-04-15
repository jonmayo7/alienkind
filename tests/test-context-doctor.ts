/**
 * Tests for scripts/tools/context-doctor.ts
 *
 * Covers:
 *   - Boot file measurement (identity files exist and have size)
 *   - Hook parsing from settings.local.json
 *   - Diagnostic report structure
 *   - Suggestion generation thresholds
 *   - Brief and JSON output modes
 *   - Token estimation math
 */

const path = require('path');

const { runDiagnostic, formatReport } = require('../scripts/tools/context-doctor.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err?.message || err}`);
    process.stdout.write(`  ✗ ${name}\n    ${err?.message || err}\n`);
  }
}

function assertEqual(actual: any, expected: any, label?: string) {
  if (actual !== expected) {
    throw new Error(`${label || 'assertion'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: any, label?: string) {
  if (!value) throw new Error(`${label || 'assertion'}: expected truthy, got ${JSON.stringify(value)}`);
}

function assertContains(haystack: string, needle: string, label?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label || 'assertion'}: expected "${needle}" in "${haystack.slice(0, 200)}..."`);
  }
}

async function run() {
  process.stdout.write('test-context-doctor:\n');

  // Get the report once — all tests operate on the same snapshot
  const report = runDiagnostic();

  await test('report has required fields', () => {
    assertTrue(report.timestamp, 'timestamp');
    assertEqual(report.contextLimitTokens, 1_000_000, 'context limit');
    assertTrue(Array.isArray(report.bootFiles), 'bootFiles is array');
    assertTrue(Array.isArray(report.hooks), 'hooks is array');
    assertTrue(typeof report.totalBootTokens === 'number', 'totalBootTokens');
    assertTrue(typeof report.totalBootPct === 'number', 'totalBootPct');
    assertTrue(typeof report.summary === 'string', 'summary');
    assertTrue(Array.isArray(report.suggestions), 'suggestions');
  });

  await test('boot files include CLAUDE.md', () => {
    const claudeMd = report.bootFiles.find((f: any) => f.path === 'CLAUDE.md');
    assertTrue(claudeMd, 'CLAUDE.md found');
    assertTrue(claudeMd.bytes > 1000, 'CLAUDE.md has content');
    assertEqual(claudeMd.category, 'boot', 'category is boot');
  });

  await test('boot files include identity kernel @imports', () => {
    const kernelFiles = report.bootFiles.filter((f: any) => f.category === 'identity');
    assertTrue(kernelFiles.length >= 4, `at least 4 identity files (got ${kernelFiles.length})`);

    const names = kernelFiles.map((f: any) => f.path);
    assertTrue(names.some((n: string) => n.includes('character.md')), 'character.md');
    assertTrue(names.some((n: string) => n.includes('commitments.md')), 'commitments.md');
    assertTrue(names.some((n: string) => n.includes('orientation.md')), 'orientation.md');
    assertTrue(names.some((n: string) => n.includes('harness.md')), 'harness.md');
  });

  await test('token estimation is reasonable', () => {
    // Total boot should be between 10K and 200K tokens (sanity check)
    assertTrue(report.totalBootTokens > 10000, `boot tokens > 10K (got ${report.totalBootTokens})`);
    assertTrue(report.totalBootTokens < 200000, `boot tokens < 200K (got ${report.totalBootTokens})`);
  });

  await test('boot percentage is under 20%', () => {
    // Boot cost should never exceed 20% of context — that would be a critical issue
    assertTrue(report.totalBootPct < 20, `boot pct < 20% (got ${report.totalBootPct.toFixed(1)}%)`);
  });

  await test('hooks are parsed from settings', () => {
    assertTrue(report.hooks.length > 0, 'at least one hook group');
    const events = report.hooks.map((h: any) => h.event);
    assertTrue(events.includes('SessionStart'), 'SessionStart hooks found');
    assertTrue(events.includes('PreToolUse'), 'PreToolUse hooks found');
  });

  await test('hook count matches expected range', () => {
    const total = report.hooks.reduce((s: number, h: any) => s + h.count, 0);
    assertTrue(total >= 10, `at least 10 hooks (got ${total})`);
    assertTrue(total < 200, `fewer than 200 hooks (got ${total})`);
  });

  await test('suggestions are generated', () => {
    assertTrue(report.suggestions.length > 0, 'at least one suggestion');
    assertTrue(typeof report.suggestions[0] === 'string', 'suggestion is string');
  });

  await test('summary is concise', () => {
    assertTrue(report.summary.length < 500, `summary < 500 chars (got ${report.summary.length})`);
    assertContains(report.summary, 'Boot cost', 'summary mentions boot cost');
    assertContains(report.summary, 'hook scripts', 'summary mentions hooks');
  });

  await test('formatReport produces markdown', () => {
    const output = formatReport(report);
    assertContains(output, '## Context Doctor', 'has title');
    assertContains(output, '### Boot Files', 'has boot files section');
    assertContains(output, '### Hooks', 'has hooks section');
    assertContains(output, '### Suggestions', 'has suggestions section');
    assertContains(output, '|', 'has table formatting');
  });

  await test('each boot file has valid structure', () => {
    for (const f of report.bootFiles) {
      assertTrue(typeof f.path === 'string' && f.path.length > 0, `${f.label} has path`);
      assertTrue(typeof f.bytes === 'number' && f.bytes > 0, `${f.label} has bytes`);
      assertTrue(typeof f.tokens === 'number' && f.tokens > 0, `${f.label} has tokens`);
      assertTrue(['identity', 'boot', 'daily', 'state', 'hook-config'].includes(f.category), `${f.label} has valid category`);
      // Token count should be roughly bytes/4
      const ratio = f.tokens / (f.bytes / 4);
      assertTrue(ratio > 0.9 && ratio < 1.2, `${f.label} token ratio reasonable (${ratio.toFixed(2)})`);
    }
  });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  process.stderr.write(`test runner crashed: ${err?.message || err}\n`);
  process.exit(1);
});
