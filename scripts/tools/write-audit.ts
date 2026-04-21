#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * write-audit — flag files written with no known reader.
 *
 * Scans recently-touched files (uncommitted working tree + commits since a
 * reference, or an explicit list) against the rest of the repo. A file is
 * an "orphan" if no other file mentions its relative path or basename.
 *
 * Closes the discipline gap surfaced by the 2026-04-20 Conn × Kael bench
 * (task S02): 8 answer files written under `runs/` with no architectural
 * reason for another instance to read them. AlienKind builds write paths
 * faster than readers. This tool makes the imbalance visible.
 *
 * Usage:
 *   npx tsx scripts/tools/write-audit.ts                  # uncommitted + HEAD~1..HEAD
 *   npx tsx scripts/tools/write-audit.ts --since HEAD~5   # since a ref
 *   npx tsx scripts/tools/write-audit.ts --files a.ts,b.md # explicit list
 *   npx tsx scripts/tools/write-audit.ts --json           # machine-readable
 *   npx tsx scripts/tools/write-audit.ts --strict         # exit 1 on orphans
 *
 * Readers: CI / pre-push gates (via --strict), session wrap-up review,
 *   manual "did I leave junk on disk?" checks.
 *
 * Limitation (v1): "reader" = any file that mentions the path or basename.
 * False positives possible for generic basenames (e.g. README.md) — inspect
 * the flagged readers in --json mode to judge. False negatives possible
 * when a file is referenced only by content (e.g. dynamically loaded at
 * runtime from a pattern); review orphan list with judgment before deleting.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

interface AuditResult {
  file: string;
  readers: string[];
  isOrphan: boolean;
}

// Paths never worth auditing — generated sinks, dependency caches, lockfiles.
const SKIP_PREFIXES = [
  'node_modules/',
  '.git/',
];
const SKIP_SUFFIXES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGit(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function gatherFiles(args: string[]): string[] {
  const filesIdx = args.indexOf('--files');
  if (filesIdx >= 0 && args[filesIdx + 1]) {
    return args[filesIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
  }

  const sinceIdx = args.indexOf('--since');
  const sinceRef = sinceIdx >= 0 && args[sinceIdx + 1] ? args[sinceIdx + 1] : 'HEAD~1';

  const uncommitted = runGit('diff --name-only')
    .split('\n').filter(Boolean);
  const committed = runGit(`diff --name-only ${sinceRef}..HEAD`)
    .split('\n').filter(Boolean);

  return [...new Set([...uncommitted, ...committed])];
}

function shouldSkip(filePath: string): boolean {
  if (SKIP_PREFIXES.some(p => filePath.startsWith(p))) return true;
  if (SKIP_SUFFIXES.some(s => filePath.endsWith(s))) return true;
  if (!fs.existsSync(filePath)) return true;
  return false;
}

function findReaders(filePath: string): string[] {
  const basename = path.basename(filePath);
  const pattern = `${escapeRegex(filePath)}|${escapeRegex(basename)}`;
  const out = runGit(`grep -lE '${pattern}'`);
  return out.split('\n')
    .filter(Boolean)
    .filter(f => f !== filePath);
}

function formatHuman(results: AuditResult[]): void {
  const orphans = results.filter(r => r.isOrphan);
  console.log(`Write audit — ${results.length} file(s) examined, ${orphans.length} orphan(s)`);
  console.log('');
  for (const r of results) {
    const mark = r.isOrphan ? '⛔ ORPHAN' : `✓ ${r.readers.length} reader(s)`;
    console.log(`  ${mark}  ${r.file}`);
  }
  if (orphans.length > 0) {
    console.log('');
    console.log('Orphans have no file in the repo that references them by path');
    console.log('or basename. Either wire a reader, delete if one-shot, or rerun');
    console.log('with --json to inspect each file\'s reader list for false-negatives.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const strict = args.includes('--strict');

  const files = gatherFiles(args).filter(f => !shouldSkip(f));

  if (files.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ audited: 0, orphans: [], details: [] }));
    } else {
      console.log('Write audit — no files to examine (working tree clean + no recent commits).');
    }
    process.exit(0);
  }

  const results: AuditResult[] = files.map(file => {
    const readers = findReaders(file);
    return { file, readers, isOrphan: readers.length === 0 };
  });

  const orphans = results.filter(r => r.isOrphan);

  if (jsonOutput) {
    console.log(JSON.stringify({
      audited: results.length,
      orphan_count: orphans.length,
      orphans: orphans.map(o => o.file),
      details: results,
    }, null, 2));
  } else {
    formatHuman(results);
  }

  process.exit(strict && orphans.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('write-audit failed:', err.message);
  process.exit(1);
});
