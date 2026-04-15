#!/usr/bin/env node

/**
 * Worktree — Thin wrapper for git worktree isolation.
 *
 * Provides create/list/remove/run operations for isolated git worktrees.
 * Used by daemon jobs, working groups, and the Agent tool for parallel
 * execution without branch conflicts.
 *
 * Pattern parity: Letta Code's git worktree support for parallel agents.
 * This wrapper generalizes what dependency-updater.ts does inline.
 *
 * Worktrees live under .keel/worktrees/<name>/ — separate from Claude Code's
 * .claude/worktrees/ (managed by the Agent tool natively).
 *
 * Usage:
 *   npx tsx scripts/lib/worktree.ts create my-task             # from HEAD
 *   npx tsx scripts/lib/worktree.ts create my-task --branch fix # from branch
 *   npx tsx scripts/lib/worktree.ts list                        # list all
 *   npx tsx scripts/lib/worktree.ts remove my-task              # cleanup
 *   npx tsx scripts/lib/worktree.ts run my-task "npm test"      # execute in worktree
 *   npx tsx scripts/lib/worktree.ts prune                       # remove stale worktrees
 *
 * Programmatic:
 *   import { createWorktree, removeWorktree, listWorktrees, runInWorktree } from './worktree.ts';
 *
 * Readers: daemon jobs, working groups, dependency-updater, keel-cycle.
 * Writers: stateless — operates on git worktree primitives.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const WORKTREE_BASE = path.join(KEEL_DIR, '.keel', 'worktrees');

// Ensure the base directory exists
function ensureBase(): void {
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });

  // Add .keel/worktrees/ to .gitignore if not already there
  const gitignorePath = path.join(KEEL_DIR, '.gitignore');
  try {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignore.includes('.keel/worktrees')) {
      fs.appendFileSync(gitignorePath, '\n# Worktree isolation\n.keel/worktrees/\n');
    }
  } catch {
    // .gitignore doesn't exist or can't be read — not critical
  }
}

function git(cmd: string, opts?: { cwd?: string; ignoreError?: boolean }): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: opts?.cwd || KEEL_DIR,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
  } catch (err: any) {
    if (opts?.ignoreError) return '';
    throw new Error(`git ${cmd} failed: ${err.stderr || err.message}`);
  }
}

function shell(cmd: string, opts?: { cwd?: string; timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: opts?.cwd || KEEL_DIR,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts?.timeout || 120000,
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      exitCode: err.status || 1,
    };
  }
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  commit: string;
  createdAt: string;
  exists: boolean;
}

export interface WorktreeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  worktreePath: string;
}

/**
 * Create a new worktree for isolated work.
 *
 * @param name - Human-readable name (e.g., 'dep-update', 'feature-x')
 * @param opts.branch - Branch to check out (default: detached HEAD)
 * @param opts.newBranch - Create a new branch with this name
 * @param opts.from - Start point (commit/branch/tag, default: HEAD)
 */
export function createWorktree(
  name: string,
  opts?: { branch?: string; newBranch?: string; from?: string },
): WorktreeInfo {
  ensureBase();

  const worktreePath = path.join(WORKTREE_BASE, name);

  // Path traversal protection
  if (!path.resolve(worktreePath).startsWith(path.resolve(WORKTREE_BASE))) {
    throw new Error('Invalid worktree name — path traversal detected');
  }

  // Branch/ref name validation — reject shell metacharacters
  const validRef = /^[a-zA-Z0-9._\/-]+$/;
  for (const ref of [name, opts?.branch, opts?.newBranch, opts?.from].filter(Boolean) as string[]) {
    if (!validRef.test(ref)) {
      throw new Error(`Invalid ref name '${ref}' — only alphanumeric, dot, underscore, slash, and hyphen allowed`);
    }
  }

  // Check if already exists
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree '${name}' already exists at ${worktreePath}`);
  }

  const from = opts?.from || 'HEAD';

  if (opts?.newBranch) {
    git(`worktree add -b ${opts.newBranch} "${worktreePath}" ${from}`);
  } else if (opts?.branch) {
    git(`worktree add "${worktreePath}" ${opts.branch}`);
  } else {
    git(`worktree add "${worktreePath}" ${from} --detach`);
  }

  // Write metadata
  const commit = git('rev-parse HEAD', { cwd: worktreePath });
  const branch = git('rev-parse --abbrev-ref HEAD', { cwd: worktreePath });
  const meta = {
    name,
    createdAt: new Date().toISOString(),
    from,
    branch: opts?.newBranch || opts?.branch || 'detached',
    commit,
  };
  fs.writeFileSync(path.join(worktreePath, '.keel-worktree.json'), JSON.stringify(meta, null, 2));

  return {
    name,
    path: worktreePath,
    branch: branch === 'HEAD' ? 'detached' : branch,
    commit,
    createdAt: meta.createdAt,
    exists: true,
  };
}

/**
 * List all managed worktrees.
 */
export function listWorktrees(): WorktreeInfo[] {
  ensureBase();

  const entries: WorktreeInfo[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(WORKTREE_BASE).filter((d: string) => !d.startsWith('.'));
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const worktreePath = path.join(WORKTREE_BASE, dir);
    const stat = fs.statSync(worktreePath);
    if (!stat.isDirectory()) continue;

    let meta: any = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(worktreePath, '.keel-worktree.json'), 'utf8'));
    } catch {}

    const exists = fs.existsSync(path.join(worktreePath, '.git'));
    let commit = meta.commit || '';
    let branch = meta.branch || 'unknown';

    if (exists) {
      try {
        commit = git('rev-parse --short HEAD', { cwd: worktreePath });
        const b = git('rev-parse --abbrev-ref HEAD', { cwd: worktreePath });
        branch = b === 'HEAD' ? 'detached' : b;
      } catch {}
    }

    entries.push({
      name: dir,
      path: worktreePath,
      branch,
      commit,
      createdAt: meta.createdAt || stat.birthtime.toISOString(),
      exists,
    });
  }

  return entries;
}

/**
 * Remove a worktree and clean up.
 */
export function removeWorktree(name: string): void {
  const worktreePath = path.join(WORKTREE_BASE, name);
  if (!path.resolve(worktreePath).startsWith(path.resolve(WORKTREE_BASE))) {
    throw new Error('Invalid worktree name — path traversal detected');
  }
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree '${name}' not found`);
  }

  // Try git worktree remove first (clean path)
  git(`worktree remove "${worktreePath}" --force`, { ignoreError: true });

  // Force-remove directory if git didn't clean it
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // Prune git's worktree references
  git('worktree prune', { ignoreError: true });
}

/**
 * Run a command inside a worktree.
 */
export function runInWorktree(
  name: string,
  command: string,
  opts?: { timeout?: number },
): WorktreeRunResult {
  const worktreePath = path.join(WORKTREE_BASE, name);
  if (!path.resolve(worktreePath).startsWith(path.resolve(WORKTREE_BASE))) {
    throw new Error('Invalid worktree name — path traversal detected');
  }
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree '${name}' not found`);
  }

  const result = shell(command, {
    cwd: worktreePath,
    timeout: opts?.timeout || 120000,
  });

  return { ...result, worktreePath };
}

/**
 * Prune stale worktrees (older than maxAgeMs or missing .git).
 */
export function pruneWorktrees(maxAgeMs: number = 24 * 60 * 60 * 1000): string[] {
  const pruned: string[] = [];
  const worktrees = listWorktrees();

  for (const wt of worktrees) {
    const age = Date.now() - new Date(wt.createdAt).getTime();
    if (!wt.exists || age > maxAgeMs) {
      try {
        removeWorktree(wt.name);
        pruned.push(wt.name);
      } catch {}
    }
  }

  // Also prune git's internal references
  git('worktree prune', { ignoreError: true });

  return pruned;
}

// === CLI ===
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'create': {
      const name = args[1];
      if (!name) { console.error('Usage: worktree create <name> [--branch <branch>] [--new-branch <branch>] [--from <ref>]'); process.exit(1); }
      const branchIdx = args.indexOf('--branch');
      const newBranchIdx = args.indexOf('--new-branch');
      const fromIdx = args.indexOf('--from');
      const info = createWorktree(name, {
        branch: branchIdx > 0 ? args[branchIdx + 1] : undefined,
        newBranch: newBranchIdx > 0 ? args[newBranchIdx + 1] : undefined,
        from: fromIdx > 0 ? args[fromIdx + 1] : undefined,
      });
      console.log(`Created worktree '${info.name}' at ${info.path} (${info.branch} @ ${info.commit})`);
      break;
    }

    case 'list': {
      const worktrees = listWorktrees();
      if (worktrees.length === 0) {
        console.log('No managed worktrees.');
      } else {
        console.log('Managed worktrees:');
        for (const wt of worktrees) {
          const status = wt.exists ? '' : ' [STALE]';
          console.log(`  ${wt.name} — ${wt.branch} @ ${wt.commit} (${wt.createdAt})${status}`);
        }
      }
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) { console.error('Usage: worktree remove <name>'); process.exit(1); }
      removeWorktree(name);
      console.log(`Removed worktree '${name}'.`);
      break;
    }

    case 'run': {
      const name = args[1];
      const cmd = args.slice(2).join(' ');
      if (!name || !cmd) { console.error('Usage: worktree run <name> <command...>'); process.exit(1); }
      const result = runInWorktree(name, cmd);
      if (result.stdout) process.stdout.write(result.stdout + '\n');
      if (result.stderr) process.stderr.write(result.stderr + '\n');
      process.exit(result.exitCode);
    }

    case 'prune': {
      const pruned = pruneWorktrees();
      if (pruned.length === 0) {
        console.log('No stale worktrees to prune.');
      } else {
        console.log(`Pruned ${pruned.length} worktree(s): ${pruned.join(', ')}`);
      }
      break;
    }

    default:
      console.log(`Usage: worktree <create|list|remove|run|prune> [args...]

Commands:
  create <name> [--branch <b>] [--new-branch <b>] [--from <ref>]
    Create an isolated worktree. Default: detached HEAD.

  list
    List all managed worktrees with status.

  remove <name>
    Remove a worktree and clean up git references.

  run <name> <command...>
    Execute a command inside a worktree. Exits with command's exit code.

  prune
    Remove stale worktrees (>24h old or missing .git).`);
      break;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`worktree error: ${err?.message || err}`);
    process.exit(1);
  });
}

module.exports = { createWorktree, listWorktrees, removeWorktree, runInWorktree, pruneWorktrees };
