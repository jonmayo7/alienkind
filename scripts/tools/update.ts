#!/usr/bin/env npx tsx

/**
 * AlienKind Updater — pull latest kernel, preserve user state.
 *
 * Usage:
 *   npm run update
 *   npx tsx scripts/tools/update.ts
 *
 * What it does:
 *   1. Stashes any local changes (identity edits, etc.)
 *   2. git pull --ff-only from origin
 *   3. Pops the stash back
 *   4. npm install (only if package.json changed)
 *   5. Reports what changed
 *
 * Safe to run any time. Fails closed if there are conflicts.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function info(msg: string) { console.log(`${C.cyan}[info]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`${C.green}[ok]${C.reset}   ${msg}`); }
function warn(msg: string) { console.log(`${C.yellow}[warn]${C.reset} ${msg}`); }
function fail(msg: string) { console.error(`${C.red}[fail]${C.reset} ${msg}`); }

function git(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  console.log(`\n  ${C.bold}👽 AlienKind Update${C.reset}\n`);

  // Sanity: are we in a git repo?
  if (!git('rev-parse', '--git-dir').ok) {
    fail('Not a git repository — cannot update. (Did you clone, or unzip a release?)');
    process.exit(1);
  }

  // Capture the pre-pull HEAD so we can show what changed
  const beforeHead = git('rev-parse', 'HEAD').stdout.trim().slice(0, 7);

  // Stash local changes if dirty
  const status = git('status', '--porcelain').stdout.trim();
  let stashed = false;
  if (status) {
    info('Stashing local changes (identity edits, etc.)...');
    const stashResult = git('stash', 'push', '-u', '-m', `alienkind-update-${Date.now()}`);
    if (!stashResult.ok) {
      fail(`Stash failed: ${stashResult.stderr}`);
      process.exit(1);
    }
    stashed = true;
    ok('Local changes stashed');
  }

  // Pull
  info('Pulling latest from origin...');
  const pullResult = git('pull', '--ff-only', 'origin', 'main');
  if (!pullResult.ok) {
    fail(`Pull failed: ${pullResult.stderr.split('\n')[0] || 'unknown error'}`);
    if (stashed) {
      warn('Restoring your stashed changes...');
      git('stash', 'pop');
    }
    process.exit(1);
  }

  const afterHead = git('rev-parse', 'HEAD').stdout.trim().slice(0, 7);
  if (beforeHead === afterHead) {
    ok(`Already at latest (${afterHead})`);
  } else {
    ok(`Updated ${beforeHead} → ${afterHead}`);
    // Show the changelog
    const log = git('log', '--oneline', `${beforeHead}..${afterHead}`).stdout.trim();
    if (log) {
      console.log('');
      console.log(`  ${C.bold}New commits:${C.reset}`);
      log.split('\n').forEach((l) => console.log(`    ${C.dim}${l}${C.reset}`));
    }
  }

  // Pop stash
  if (stashed) {
    info('Restoring your local changes...');
    const popResult = git('stash', 'pop');
    if (!popResult.ok) {
      warn(`Stash pop had conflicts: ${popResult.stderr.split('\n')[0]}`);
      console.log(`  ${C.dim}Your changes are still in the stash. Resolve manually with 'git stash list' / 'git stash pop'.${C.reset}`);
    } else {
      ok('Local changes restored');
    }
  }

  // npm install only if package.json changed
  if (beforeHead !== afterHead) {
    const pkgChanged = git('diff', '--name-only', `${beforeHead}..${afterHead}`).stdout.includes('package.json');
    if (pkgChanged) {
      info('package.json changed — running npm install...');
      const npmResult = spawnSync('npm', ['install', '--silent'], { cwd: ROOT, stdio: 'inherit' });
      if (npmResult.status === 0) ok('Dependencies updated');
      else warn('npm install had issues — check output above');
    }
  }

  console.log('');
  ok('Update complete.');
  console.log('');
}

main().catch((err: any) => {
  fail(err.message || String(err));
  process.exit(1);
});
