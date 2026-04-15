#!/usr/bin/env node

/**
 * Session Reaper — cleans up stale files from specified directories.
 *
 * Exports reapOldFiles(dir, maxAgeDays, options) for programmatic use.
 * Also runnable as a standalone CLI:
 *   node scripts/lib/reaper.js [dir] [maxAgeDays] [--dry-run]
 *
 * Used by nightly-cycle.js to clean up old delivery-queue failures
 * and temporary checkpoint files.
 */

const fs = require('fs');
const path = require('path');

const { REAPER: _REAPER } = require('./constants.ts');

interface ReapOptions {
  dryRun?: boolean;
  pattern?: string | null;
  log?: (...args: any[]) => void;
}

interface ReapResult {
  deleted: number;
  errors: number;
  skipped: number;
}

interface ReapTarget {
  dir: string;
  maxAgeDays: number;
  pattern?: string;
}

interface ReapTargetResult {
  dir: string;
  maxAgeDays: number;
  pattern: string | null;
  result: ReapResult;
}

interface ReapAllOptions {
  dryRun?: boolean;
  log?: (...args: any[]) => void;
  keelDir?: string;
}

interface ReapAllSummary {
  targets: ReapTargetResult[];
  totalDeleted: number;
  totalErrors: number;
}

/**
 * Scan a directory for files older than maxAgeDays and delete them.
 */
function reapOldFiles(dir: string, maxAgeDays: number, options: ReapOptions = {}): ReapResult {
  const {
    dryRun = false,
    pattern = null,
    log = console.log,
  } = options;

  const result: ReapResult = { deleted: 0, errors: 0, skipped: 0 };
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Bail if directory doesn't exist — not an error, just nothing to do
  if (!fs.existsSync(dir)) {
    log(`reaper: directory does not exist, skipping: ${dir}`);
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    log(`reaper: failed to read directory ${dir}: ${err.message}`);
    result.errors++;
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    // Only reap files, not directories
    let stat: any;
    try {
      stat = fs.statSync(fullPath);
    } catch (err: any) {
      log(`reaper: failed to stat ${fullPath}: ${err.message}`);
      result.errors++;
      continue;
    }

    if (!stat.isFile()) {
      result.skipped++;
      continue;
    }

    // Apply pattern filter if provided
    if (pattern && !matchPattern(entry, pattern)) {
      result.skipped++;
      continue;
    }

    // Check age using mtime
    if (stat.mtimeMs >= cutoff) {
      result.skipped++;
      continue;
    }

    const ageDays = ((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)).toFixed(1);

    if (dryRun) {
      log(`reaper: [DRY RUN] would delete ${fullPath} (${ageDays}d old)`);
      result.deleted++;
      continue;
    }

    try {
      fs.unlinkSync(fullPath);
      log(`reaper: deleted ${fullPath} (${ageDays}d old)`);
      result.deleted++;
    } catch (err: any) {
      log(`reaper: failed to delete ${fullPath}: ${err.message}`);
      result.errors++;
    }
  }

  return result;
}

/**
 * Simple pattern matching supporting leading and trailing wildcards.
 * Patterns like '*.json', 'keel-memory-checkpoint-*', '*backup*' are supported.
 */
function matchPattern(filename: string, pattern: string): boolean {
  // Exact match
  if (pattern === filename) return true;

  // Convert simple glob to regex:
  //   * → .*    ? → .    everything else is escaped
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials (except * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexStr}$`).test(filename);
}

/**
 * Run all configured reaper targets.
 * Uses REAPER config from constants.js.
 */
function reapAll(options: ReapAllOptions = {}): ReapAllSummary {
  const {
    dryRun = false,
    log = console.log,
    keelDir = path.resolve(__dirname, '../..'),
  } = options;

  const summary: ReapAllSummary = { targets: [], totalDeleted: 0, totalErrors: 0 };

  for (const target of _REAPER.targets as ReapTarget[]) {
    // Resolve dir relative to keelDir if not absolute
    const resolvedDir = path.isAbsolute(target.dir)
      ? target.dir
      : path.join(keelDir, target.dir);

    const result = reapOldFiles(resolvedDir, target.maxAgeDays, {
      dryRun,
      pattern: target.pattern || null,
      log,
    });

    summary.targets.push({
      dir: resolvedDir,
      maxAgeDays: target.maxAgeDays,
      pattern: target.pattern || null,
      result,
    });

    summary.totalDeleted += result.deleted;
    summary.totalErrors += result.errors;
  }

  return summary;
}

module.exports = { reapAll };

// --- CLI Mode ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filteredArgs = args.filter((a: string) => a !== '--dry-run');

  if (filteredArgs.length === 0) {
    // No args: run all configured targets
    console.log(`Running all configured reaper targets${dryRun ? ' (DRY RUN)' : ''}...\n`);
    const summary = reapAll({ dryRun });
    console.log(`\nSummary: ${summary.totalDeleted} deleted, ${summary.totalErrors} errors`);
    for (const t of summary.targets) {
      const pStr = t.pattern ? ` (pattern: ${t.pattern})` : '';
      console.log(`  ${t.dir}${pStr}: ${t.result.deleted} deleted, ${t.result.errors} errors, ${t.result.skipped} skipped`);
    }
    process.exit(summary.totalErrors > 0 ? 1 : 0);
  } else if (filteredArgs.length >= 2) {
    // Explicit dir + maxAgeDays
    const dir = path.resolve(filteredArgs[0]);
    const maxAgeDays = parseFloat(filteredArgs[1]);

    if (isNaN(maxAgeDays) || maxAgeDays <= 0) {
      console.error('Error: maxAgeDays must be a positive number');
      process.exit(1);
    }

    console.log(`Reaping files older than ${maxAgeDays}d in ${dir}${dryRun ? ' (DRY RUN)' : ''}...\n`);
    const result = reapOldFiles(dir, maxAgeDays, { dryRun });
    console.log(`\nResult: ${result.deleted} deleted, ${result.errors} errors, ${result.skipped} skipped`);
    process.exit(result.errors > 0 ? 1 : 0);
  } else {
    console.error('Usage: node scripts/lib/reaper.ts [dir] [maxAgeDays] [--dry-run]');
    console.error('       node scripts/lib/reaper.js [--dry-run]   (run all configured targets)');
    process.exit(1);
  }
}
