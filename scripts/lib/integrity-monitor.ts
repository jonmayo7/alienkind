// @alienkind-core
/**
 * integrity-monitor.ts — SHA-256 integrity checks on critical files.
 *
 * Baseline lives in Supabase so a compromised local agent can't tamper
 * with what it's checked against. Detects unauthorized modification of
 * identity files, config, and core security modules. Returns a severity
 * assessment (ok / warn / critical) that distinguishes stale baselines
 * (committed changes since baseline) from genuine threat signals
 * (unstaged working-tree modifications to critical files).
 *
 * Usage:
 *   const { checkIntegrity, updateBaseline, integrityAssessment } =
 *     require('./integrity-monitor.ts');
 *
 * Storage: Supabase `security_audit_log` table
 * (action_type=integrity_baseline rows carry the checksum map). Without
 * Supabase configured every call gracefully no-ops via portable.ts.
 *
 * Readers: threat-hunter.ts, nightly/immune.ts
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { tryStorage, registerUnavailable } = require('./portable.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  registerUnavailable('integrity-monitor', {
    reason: 'Supabase credentials not configured — baseline storage unavailable.',
    enableWith: 'Set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env. Baseline rows write to security_audit_log with action_type=integrity_baseline.',
    docs: 'HYPOTHESIS.md §7 Security Organ.',
  });
}

function execSyncRetry(cmd: string, opts: Record<string, any>, retries = 3): string {
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmd, opts);
    } catch (err: any) {
      const isEAGAIN = err.message?.includes('EAGAIN') || err.message?.includes('error -11') ||
        err.status === -11 || err.errno === -11;
      if (!isEAGAIN || i === retries - 1) throw err;
    }
  }
  throw new Error('execSyncRetry: unreachable');
}

// Files that, if modified unexpectedly, indicate compromise. Only lists
// files that ship in a fresh clone — user-generated files (.env, CLAUDE.md
// after setup-wizard) are monitored at runtime if present but aren't in
// the tracked set here, because they don't exist until a forker creates
// them. Forkers extending this list should add their own identity /
// credential paths.
const CRITICAL_FILES = [
  'identity/character.md',
  'identity/commitments.md',
  'identity/orientation.md',
  'identity/harness.md',
  'config/daemon-jobs.ts',
  'scripts/lib/constants.ts',
  'scripts/lib/supabase.ts',
  'scripts/lib/shared.ts',
  'scripts/lib/security.ts',
  'scripts/lib/exec-safety.ts',
  'scripts/lib/defense-elements.ts',
];

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function computeChecksums(): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const file of CRITICAL_FILES) {
    result[file] = hashFile(path.join(ALIENKIND_DIR, file));
  }
  return result;
}

async function updateBaseline(): Promise<void> {
  const checksums = computeChecksums();
  await tryStorage(
    async () => {
      const { supabasePost } = require('./supabase.ts');
      return supabasePost('security_audit_log', {
        action_type: 'integrity_baseline',
        target: 'critical_files',
        parameters: { checksums, file_count: Object.keys(checksums).length },
        source: 'integrity-monitor',
        severity: 'info',
        outcome: 'success',
      });
    },
    null,
  );
}

async function checkIntegrity(): Promise<{
  matches: number;
  mismatches: { file: string; expected: string | null; actual: string | null }[];
  missing: string[];
  baselineAge: string | null;
}> {
  const baselines = await tryStorage(
    async () => {
      const { supabaseGet } = require('./supabase.ts');
      return supabaseGet(
        'security_audit_log',
        'select=parameters,created_at&action_type=eq.integrity_baseline&order=created_at.desc&limit=1',
      );
    },
    [] as Array<{ parameters: any; created_at: string }>,
  );

  if (!baselines || baselines.length === 0) {
    return { matches: 0, mismatches: [], missing: CRITICAL_FILES, baselineAge: null };
  }

  const baseline = baselines[0].parameters.checksums;
  const baselineAge = baselines[0].created_at;
  const current = computeChecksums();

  const mismatches: { file: string; expected: string | null; actual: string | null }[] = [];
  const missing: string[] = [];
  let matches = 0;

  for (const file of CRITICAL_FILES) {
    const expected = baseline[file];
    const actual = current[file];
    if (actual === null) missing.push(file);
    else if (expected !== actual) mismatches.push({ file, expected, actual });
    else matches++;
  }

  return { matches, mismatches, missing, baselineAge };
}

function getUncommittedFiles(files: string[]): string[] {
  try {
    const statusOutput = execSyncRetry('git status --porcelain', { cwd: ALIENKIND_DIR, encoding: 'utf8' });
    const dirtyFiles = new Set(
      statusOutput.split('\n').filter(Boolean).map((line: string) => line.slice(3).trim()),
    );
    return files.filter(f => dirtyFiles.has(f));
  } catch {
    return files;
  }
}

function categorizeUncommittedFiles(files: string[]): { staged: string[]; unstaged: string[] } {
  try {
    const statusOutput = execSyncRetry('git status --porcelain', { cwd: ALIENKIND_DIR, encoding: 'utf8' });
    const staged: string[] = [];
    const unstaged: string[] = [];
    for (const line of statusOutput.split('\n').filter(Boolean)) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();
      if (!files.includes(file)) continue;
      if (y !== ' ' && y !== '?') unstaged.push(file);
      else if (x !== ' ' && x !== '?') staged.push(file);
    }
    return { staged, unstaged };
  } catch {
    return { staged: [], unstaged: files };
  }
}

async function integrityAssessment(): Promise<{
  healthy: boolean;
  severity: 'ok' | 'warn' | 'critical';
  summary: string;
  details: any;
}> {
  const result = await checkIntegrity();

  if (result.missing.length > 0 && result.baselineAge === null) {
    return {
      healthy: true,
      severity: 'warn',
      summary: `No baseline established. ${CRITICAL_FILES.length} files need initial baseline.`,
      details: result,
    };
  }

  if (result.mismatches.length === 0 && result.missing.length === 0) {
    return {
      healthy: true,
      severity: 'ok',
      summary: `All ${result.matches} critical files match baseline.`,
      details: result,
    };
  }

  const mismatchedFiles = result.mismatches.map(m => m.file);
  const uncommitted = getUncommittedFiles(mismatchedFiles);

  if (uncommitted.length === 0) {
    return {
      healthy: true,
      severity: 'warn',
      summary: `${result.mismatches.length} file(s) changed since baseline (all committed — stale baseline): ${mismatchedFiles.join(', ')}`,
      details: { ...result, uncommitted: [], allCommitted: true },
    };
  }

  const { staged, unstaged } = categorizeUncommittedFiles(uncommitted);

  if (unstaged.length > 0) {
    const highValueFiles = ['scripts/lib/supabase.ts', 'scripts/lib/shared.ts', 'scripts/lib/security.ts', 'scripts/lib/defense-elements.ts'];
    const hasHighValue = unstaged.some(f => highValueFiles.includes(f));
    return {
      healthy: false,
      severity: 'critical',
      summary: `CRITICAL: ${unstaged.length} critical file(s) have UNSTAGED modifications: ${unstaged.join(', ')}` +
        (hasHighValue ? ' (includes security/core files)' : '') +
        (staged.length > 0 ? ` (${staged.length} additional staged-only: ${staged.join(', ')})` : ''),
      details: { ...result, uncommitted, staged, unstaged, hasHighValue },
    };
  }

  return {
    healthy: true,
    severity: 'warn',
    summary: `${staged.length} file(s) staged but not yet committed: ${staged.join(', ')}`,
    details: { ...result, uncommitted, staged, unstaged: [], stagedOnly: true },
  };
}

function getCriticalFiles(): string[] {
  return [...CRITICAL_FILES];
}

module.exports = {
  checkIntegrity,
  updateBaseline,
  integrityAssessment,
  computeChecksums,
  getCriticalFiles,
  getUncommittedFiles,
  categorizeUncommittedFiles,
  hashFile,
};
