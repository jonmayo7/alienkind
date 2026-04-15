/**
 * Tests for scripts/lib/portable.ts
 *
 * Verifies the portability layer that makes hooks work on any machine:
 *   - Repo root resolution (finds root from anywhere)
 *   - Config loading (missing config = empty, not crash)
 *   - Storage detection (Supabase → SQLite → file fallback)
 *   - tryStorage graceful degradation (errors → fallback, not crash)
 *   - tryClassifier graceful degradation (timeout/error → fallback)
 *   - Capability status generation (structured, has all expected fields)
 *   - Capability status formatting (human-readable markdown)
 *   - Path resolution (relative to repo root)
 */

const path = require('path');

const {
  resolveRepoRoot,
  resolvePath,
  loadConfig,
  resolveConfig,
  detectStorage,
  tryStorage,
  writeLocalFallback,
  readLocalFallback,
  tryClassifier,
  getCapabilityStatus,
  formatCapabilityStatus,
} = require('../scripts/lib/portable.ts');

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

function assertEqual(actual: any, expected: any, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTrue(value: any, label: string) {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
}

function assertContains(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) throw new Error(`${label}: expected "${needle}" in "${haystack.slice(0, 200)}"`);
}

async function run() {
  process.stdout.write('test-portable:\n');

  // --- Repo root ---
  await test('resolves repo root to a directory with .git', () => {
    const root = resolveRepoRoot();
    assertTrue(root.length > 0, 'root is non-empty');
    const fs = require('fs');
    assertTrue(
      fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'CLAUDE.md')),
      'root has .git or CLAUDE.md',
    );
  });

  await test('resolvePath returns absolute path', () => {
    const p = resolvePath('soul/character.md');
    assertTrue(path.isAbsolute(p), 'path is absolute');
    assertContains(p, 'soul/character.md', 'contains relative path');
  });

  // --- Config ---
  await test('loadConfig returns object (even if file missing)', () => {
    const config = loadConfig();
    assertTrue(typeof config === 'object', 'config is object');
  });

  await test('resolveConfig returns default when key missing', () => {
    const val = resolveConfig('nonexistent_key_12345', 42);
    assertEqual(val, 42, 'default returned');
  });

  // --- Storage ---
  await test('detectStorage returns a valid backend', () => {
    const backend = detectStorage();
    assertTrue(
      ['supabase', 'sqlite', 'file', 'none'].includes(backend),
      `backend "${backend}" is valid`,
    );
  });

  // --- tryStorage ---
  await test('tryStorage returns result on success', async () => {
    const result = await tryStorage(async () => 'hello', 'fallback', 'test');
    assertEqual(result, 'hello', 'success path');
  });

  await test('tryStorage returns fallback on error', async () => {
    const result = await tryStorage(
      async () => { throw new Error('db down'); },
      'fallback',
      'test',
    );
    assertEqual(result, 'fallback', 'fallback path');
  });

  await test('tryStorage returns fallback on reject', async () => {
    const result = await tryStorage(
      () => Promise.reject(new Error('timeout')),
      'safe-default',
      'test',
    );
    assertEqual(result, 'safe-default', 'reject fallback');
  });

  // --- Local fallback storage ---
  await test('writeLocalFallback + readLocalFallback roundtrip', () => {
    const testFile = `test-portable-${Date.now()}.jsonl`;
    writeLocalFallback(testFile, { test: true, ts: Date.now() });
    writeLocalFallback(testFile, { test: true, ts: Date.now() + 1 });
    const entries = readLocalFallback(testFile);
    assertEqual(entries.length, 2, 'two entries');
    assertTrue(entries[0].test === true, 'data preserved');

    // Cleanup
    const fs = require('fs');
    const filePath = path.join(resolveRepoRoot(), '.partner', 'state', testFile);
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  });

  await test('readLocalFallback returns empty array for missing file', () => {
    const entries = readLocalFallback('nonexistent-file-12345.jsonl');
    assertEqual(entries.length, 0, 'empty array');
  });

  // --- tryClassifier ---
  await test('tryClassifier returns fallback when no model available', async () => {
    // This test assumes no classifier is running on port 8005 in the test env.
    // If one IS running (which it might be on Keel's machine), it returns a real response.
    // Either way, the function should not throw.
    const result = await tryClassifier('test prompt', 'SAFE', 'test');
    assertTrue(typeof result === 'string', 'returns a string');
    assertTrue(result.length > 0, 'non-empty result');
  });

  // --- Capability status ---
  await test('getCapabilityStatus returns structured report', async () => {
    const status = await getCapabilityStatus();
    assertTrue(status.timestamp, 'has timestamp');
    assertTrue(Array.isArray(status.capabilities), 'has capabilities array');
    assertTrue(status.capabilities.length >= 5, 'at least 5 capabilities probed');
    assertTrue(typeof status.summary === 'string', 'has summary');
    assertTrue(status.summary.length > 0, 'summary non-empty');
  });

  await test('each capability has required fields', async () => {
    const status = await getCapabilityStatus();
    for (const cap of status.capabilities) {
      assertTrue(cap.name, `capability has name: ${JSON.stringify(cap)}`);
      assertTrue(
        ['active', 'degraded', 'unavailable'].includes(cap.status),
        `status is valid: ${cap.status}`,
      );
      assertTrue(cap.detail, `has detail: ${cap.name}`);
      // upgrade is optional (only for degraded/unavailable)
      if (cap.status !== 'active') {
        assertTrue(cap.upgrade, `degraded/unavailable capability has upgrade hint: ${cap.name}`);
      }
    }
  });

  await test('formatCapabilityStatus produces markdown', async () => {
    const status = await getCapabilityStatus();
    const md = formatCapabilityStatus(status);
    assertContains(md, '## Partner Capability Status', 'has header');
    assertContains(md, 'Identity kernel', 'mentions identity');
    assertContains(md, 'Storage', 'mentions storage');
    // Should have icons
    assertTrue(md.includes('✓') || md.includes('⚠') || md.includes('✗'), 'has status icons');
  });

  await test('capability status includes storage backend type', async () => {
    const status = await getCapabilityStatus();
    assertTrue(
      ['supabase', 'sqlite', 'file', 'none'].includes(status.storage),
      `storage backend valid: ${status.storage}`,
    );
  });

  // --- Summary ---
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch(err => {
  process.stderr.write(`test runner crashed: ${err?.message || err}\n`);
  process.exit(1);
});
