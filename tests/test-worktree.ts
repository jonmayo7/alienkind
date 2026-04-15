/**
 * Tests for scripts/lib/worktree.ts
 *
 * Covers:
 *   - Create worktree (detached HEAD)
 *   - Create worktree with new branch
 *   - List worktrees
 *   - Run command in worktree
 *   - Remove worktree
 *   - Prune stale worktrees
 *   - Error on duplicate name
 *   - Error on missing worktree
 *
 * These tests create real git worktrees and clean up after themselves.
 */

const { createWorktree, listWorktrees, removeWorktree, runInWorktree, pruneWorktrees } = require('../lib/worktree.ts');
const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const WORKTREE_BASE = path.join(KEEL_DIR, '.keel', 'worktrees');

let passed = 0;
let failed = 0;
const failures: string[] = [];
const createdWorktrees: string[] = [];

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

function cleanup() {
  for (const name of createdWorktrees) {
    try { removeWorktree(name); } catch {}
  }
}

async function run() {
  process.stdout.write('test-worktree:\n');

  const testName = `test-wt-${Date.now()}`;

  await test('create worktree (detached HEAD)', () => {
    const info = createWorktree(testName);
    createdWorktrees.push(testName);
    assertEqual(info.name, testName, 'name matches');
    assertTrue(info.path.includes(testName), 'path contains name');
    assertEqual(info.branch, 'detached', 'branch is detached');
    assertTrue(info.commit.length > 6, 'commit hash present');
    assertTrue(info.exists, 'exists flag');
    assertTrue(fs.existsSync(info.path), 'directory exists on disk');
    assertTrue(fs.existsSync(path.join(info.path, '.git')), '.git exists');
    assertTrue(fs.existsSync(path.join(info.path, '.keel-worktree.json')), 'metadata file exists');
  });

  await test('list includes created worktree', () => {
    const list = listWorktrees();
    const found = list.find((wt: any) => wt.name === testName);
    assertTrue(found, 'worktree found in list');
    assertEqual(found.name, testName, 'name matches');
    assertTrue(found.exists, 'exists flag');
  });

  await test('run command in worktree', () => {
    const result = runInWorktree(testName, 'echo hello-from-worktree');
    assertEqual(result.exitCode, 0, 'exit code 0');
    assertTrue(result.stdout.includes('hello-from-worktree'), 'output matches');
    assertTrue(result.worktreePath.includes(testName), 'worktree path in result');
  });

  await test('run git command in worktree', () => {
    const result = runInWorktree(testName, 'git log --oneline -1');
    assertEqual(result.exitCode, 0, 'exit code 0');
    assertTrue(result.stdout.length > 5, 'git log has output');
  });

  await test('worktree is isolated from main', () => {
    // Create a file in the worktree — it should NOT appear in main
    const wtPath = path.join(WORKTREE_BASE, testName);
    fs.writeFileSync(path.join(wtPath, '_test_isolation_marker.txt'), 'isolated');
    assertTrue(!fs.existsSync(path.join(KEEL_DIR, '_test_isolation_marker.txt')), 'marker not in main');
  });

  await test('error on duplicate name', () => {
    let threw = false;
    try {
      createWorktree(testName);
    } catch (err: any) {
      threw = true;
      assertTrue(err.message.includes('already exists'), 'error mentions already exists');
    }
    assertTrue(threw, 'should have thrown');
  });

  await test('remove worktree', () => {
    removeWorktree(testName);
    createdWorktrees.splice(createdWorktrees.indexOf(testName), 1);
    assertTrue(!fs.existsSync(path.join(WORKTREE_BASE, testName)), 'directory removed');
    const list = listWorktrees();
    const found = list.find((wt: any) => wt.name === testName);
    assertTrue(!found, 'not in list after removal');
  });

  await test('error on removing nonexistent worktree', () => {
    let threw = false;
    try {
      removeWorktree('nonexistent-worktree-xyz');
    } catch (err: any) {
      threw = true;
      assertTrue(err.message.includes('not found'), 'error mentions not found');
    }
    assertTrue(threw, 'should have thrown');
  });

  const branchTestName = `test-wt-branch-${Date.now()}`;
  await test('create worktree with new branch', () => {
    const branchName = `test-branch-${Date.now()}`;
    const info = createWorktree(branchTestName, { newBranch: branchName });
    createdWorktrees.push(branchTestName);
    assertEqual(info.branch, branchName, 'branch matches');
    assertTrue(info.exists, 'exists');

    // Verify branch exists in worktree
    const result = runInWorktree(branchTestName, 'git rev-parse --abbrev-ref HEAD');
    assertEqual(result.stdout, branchName, 'git confirms branch');

    // Cleanup
    removeWorktree(branchTestName);
    createdWorktrees.splice(createdWorktrees.indexOf(branchTestName), 1);

    // Delete the test branch from main repo
    try {
      const { execSync } = require('child_process');
      execSync(`git branch -D ${branchName}`, { cwd: KEEL_DIR, stdio: 'pipe' });
    } catch {}
  });

  const pruneTestName = `test-wt-prune-${Date.now()}`;
  await test('prune removes stale worktrees', () => {
    const info = createWorktree(pruneTestName);
    createdWorktrees.push(pruneTestName);

    // Prune with 0ms max age — everything is stale
    const pruned = pruneWorktrees(0);
    assertTrue(pruned.includes(pruneTestName), 'test worktree was pruned');
    assertTrue(!fs.existsSync(info.path), 'directory removed after prune');
    createdWorktrees.splice(createdWorktrees.indexOf(pruneTestName), 1);
  });

  await test('error on run in nonexistent worktree', () => {
    let threw = false;
    try {
      runInWorktree('nonexistent-worktree-xyz', 'echo test');
    } catch (err: any) {
      threw = true;
      assertTrue(err.message.includes('not found'), 'error mentions not found');
    }
    assertTrue(threw, 'should have thrown');
  });

  // Final cleanup
  cleanup();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  cleanup();
  process.stderr.write(`test runner crashed: ${err?.message || err}\n`);
  process.exit(1);
});
