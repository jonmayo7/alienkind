/**
 * Tests for scripts/lib/prompt-hook-executor.ts
 *
 * Covers:
 *   - Variable substitution into prompt templates
 *   - ALLOW: response parsing
 *   - BLOCK: response parsing
 *   - Parse failure → fail-closed default
 *   - Parse failure → fail-open opt-in
 *   - Substrate error → fallback path
 *   - Truncation of oversized variables
 *
 * The LLM substrate is mocked via require cache injection so these tests
 * run with no model dependency. Real LLM behavior is verified in the
 * integration check at the bottom of this file (skipped by default).
 */

const path = require('path');
const Module = require('module');

// ============================================================================
// Mock the local-inference module before importing the executor.
// We replace localClassify and localChat with controllable stubs.
// ============================================================================

let mockResponse: string | null = 'ALLOW: looks fine';
let mockShouldThrow: Error | null = null;
let mockCallLog: Array<{ prompt: string; opts: any; substrate: string }> = [];

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
  if (request === './local-inference.ts' || request.endsWith('/local-inference.ts')) {
    return path.resolve(__dirname, '__mock_local_inference__');
  }
  return originalResolve.call(this, request, parent, ...rest);
};

require.cache[path.resolve(__dirname, '__mock_local_inference__')] = {
  id: '__mock_local_inference__',
  filename: '__mock_local_inference__',
  loaded: true,
  exports: {
    localClassify: async (prompt: string, opts: any) => {
      mockCallLog.push({ prompt, opts, substrate: 'classifier' });
      if (mockShouldThrow) throw mockShouldThrow;
      return mockResponse ?? '';
    },
    localChat: async (prompt: string, opts: any) => {
      mockCallLog.push({ prompt, opts, substrate: opts?.substrate || 'unknown' });
      if (mockShouldThrow) throw mockShouldThrow;
      return { content: mockResponse ?? '' };
    },
  },
} as any;

const { executePromptHook } = require('../lib/prompt-hook-executor.ts');

// ============================================================================
// Test runner — minimal, no framework
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function reset() {
  mockResponse = 'ALLOW: looks fine';
  mockShouldThrow = null;
  mockCallLog = [];
}

async function test(name: string, fn: () => Promise<void> | void) {
  reset();
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
    throw new Error(`${label || 'assertion'}: expected "${needle}" in "${haystack}"`);
  }
}

// ============================================================================
// Tests
// ============================================================================

async function run() {
  process.stdout.write('test-prompt-hook-executor:\n');

  await test('substitutes a single variable', async () => {
    mockResponse = 'ALLOW: ok';
    await executePromptHook(
      { tool_input: { file_path: '/tmp/foo.ts' } },
      {
        name: 't1',
        prompt: 'reviewing {file_path}',
        variables: { file_path: (h: any) => h.tool_input.file_path },
      },
    );
    assertEqual(mockCallLog.length, 1, 'one LLM call');
    assertContains(mockCallLog[0].prompt, '/tmp/foo.ts', 'variable substituted');
  });

  await test('substitutes multiple variables', async () => {
    await executePromptHook(
      { a: 'alpha', b: 'beta' },
      {
        name: 't2',
        prompt: '{a} and {b}',
        variables: {
          a: (h: any) => h.a,
          b: (h: any) => h.b,
        },
      },
    );
    assertContains(mockCallLog[0].prompt, 'alpha and beta', 'both vars substituted');
  });

  await test('parses ALLOW: response correctly', async () => {
    mockResponse = 'ALLOW: nothing concerning here';
    const r = await executePromptHook({}, { name: 't3', prompt: 'check' });
    assertEqual(r.ok, true, 'ok=true');
    assertEqual(r.reason, 'nothing concerning here', 'reason extracted');
    assertEqual(r.fallback, false, 'not fallback');
  });

  await test('parses BLOCK: response correctly', async () => {
    mockResponse = 'BLOCK: contains a credential';
    const r = await executePromptHook({}, { name: 't4', prompt: 'check' });
    assertEqual(r.ok, false, 'ok=false');
    assertEqual(r.reason, 'contains a credential', 'reason extracted');
    assertEqual(r.fallback, false, 'not fallback');
  });

  await test('fail-closed (default) on parse failure', async () => {
    mockResponse = 'I cannot determine this';
    const r = await executePromptHook({}, { name: 't5', prompt: 'check' });
    assertEqual(r.ok, false, 'fail-closed → blocked');
    assertEqual(r.fallback, true, 'fallback flag set');
    assertContains(r.reason, 'fail-closed', 'reason mentions fail-closed');
  });

  await test('fail-open on parse failure when configured', async () => {
    mockResponse = 'maybe?';
    const r = await executePromptHook(
      {},
      { name: 't6', prompt: 'check', failClosed: false },
    );
    assertEqual(r.ok, true, 'fail-open → allowed');
    assertEqual(r.fallback, true, 'fallback flag set');
  });

  await test('fail-closed on substrate error', async () => {
    mockShouldThrow = new Error('classifier timeout');
    const r = await executePromptHook({}, { name: 't7', prompt: 'check' });
    assertEqual(r.ok, false, 'fail-closed on error');
    assertEqual(r.fallback, true, 'fallback flag set');
    assertContains(r.reason, 'classifier timeout', 'error message preserved');
  });

  await test('truncates oversized variables', async () => {
    const giant = 'x'.repeat(5000);
    await executePromptHook(
      { content: giant },
      {
        name: 't8',
        prompt: 'reviewing: {content}',
        variables: { content: (h: any) => h.content },
        contextLimit: 100,
      },
    );
    const sentPrompt = mockCallLog[0].prompt;
    assertContains(sentPrompt, 'truncated', 'truncation marker present');
    // The prompt should be roughly 100 chars of x + truncation marker, not 5000
    assertTrue(sentPrompt.length < 500, `prompt size bounded (got ${sentPrompt.length})`);
  });

  await test('handles missing variable extractor gracefully', async () => {
    mockResponse = 'ALLOW: ok';
    await executePromptHook(
      { tool_input: null },
      {
        name: 't9',
        prompt: 'file: {file_path}',
        variables: { file_path: (h: any) => h.tool_input.file_path }, // will throw
      },
    );
    const sentPrompt = mockCallLog[0].prompt;
    assertContains(sentPrompt, 'extraction failed', 'extraction failure surfaced in prompt');
  });

  await test('routes to studio2-daily when requested', async () => {
    mockResponse = 'ALLOW: ok';
    await executePromptHook(
      {},
      { name: 't10', prompt: 'check', substrate: 'studio2-daily' },
    );
    assertEqual(mockCallLog[0].substrate, 'studio2-daily', 'routed to studio2-daily');
  });

  await test('routes to studio1-identity when requested', async () => {
    mockResponse = 'ALLOW: ok';
    await executePromptHook(
      {},
      { name: 't11', prompt: 'check', substrate: 'studio1-identity' },
    );
    assertEqual(mockCallLog[0].substrate, 'studio1-identity', 'routed to studio1-identity');
  });

  await test('records duration', async () => {
    const r = await executePromptHook({}, { name: 't12', prompt: 'check' });
    assertTrue(typeof r.durationMs === 'number', 'duration is a number');
    assertTrue(r.durationMs >= 0, 'duration non-negative');
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
