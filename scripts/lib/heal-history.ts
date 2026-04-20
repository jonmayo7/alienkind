// @alienkind-core
/**
 * heal-history.ts — Persistent investigation history for self-heal.
 *
 * Gives the self-heal system memory across daemon restarts.
 * Before: diagnostic sessions start from zero context about prior failures.
 * After: recurring failures inject prior findings into the diagnostic prompt.
 *
 * Storage: JSON file at logs/self-heal-history.json (max 200 entries,
 * auto-pruned). Each entry: job name, error fingerprint, timestamp,
 * outcome, summary, duration. A corrupt or missing file returns an empty
 * history — no opt-in gate required, the degrade is natural.
 *
 * Writers: self-heal.ts (after each investigation via recordInvestigation)
 * Readers: self-heal.ts (before building diagnostic prompt via buildPriorContext)
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const HISTORY_PATH = path.join(ALIENKIND_DIR, 'logs', 'self-heal-history.json');
const MAX_ENTRIES = 200;
const RECURRING_THRESHOLD = 3; // N occurrences of same fingerprint = recurring

interface HealEntry {
  jobName: string;
  fingerprint: string;
  errorMsg: string;
  timestamp: string;        // ISO 8601
  outcome: 'fixed' | 'proposed' | 'failed' | 'skipped';
  summary: string;
  durationMs?: number;
  fixCommit?: string;       // commit hash if auto-fixed
}

interface HealHistory {
  entries: HealEntry[];
  lastPruned: string;       // ISO 8601
}

function readHistory(): HealHistory {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        return parsed as HealHistory;
      }
    }
  } catch {
    // Corrupt file — start fresh
  }
  return { entries: [], lastPruned: new Date().toISOString() };
}

function writeHistory(history: HealHistory): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Record an investigation result to persistent history.
 * Auto-prunes to MAX_ENTRIES (oldest removed first).
 */
function recordInvestigation(entry: HealEntry): void {
  const history = readHistory();
  history.entries.push(entry);

  if (history.entries.length > MAX_ENTRIES) {
    history.entries = history.entries.slice(-MAX_ENTRIES);
    history.lastPruned = new Date().toISOString();
  }

  writeHistory(history);
}

/**
 * Find prior investigations matching the same error fingerprint.
 * Returns most recent first, up to `limit` entries.
 */
function findPriorInvestigations(fingerprint: string, limit: number = 5): HealEntry[] {
  const history = readHistory();
  return history.entries
    .filter(e => e.fingerprint === fingerprint)
    .reverse()
    .slice(0, limit);
}

/**
 * Find prior investigations for a specific job (any fingerprint).
 * Returns most recent first, up to `limit` entries.
 */
function findPriorForJob(jobName: string, limit: number = 10): HealEntry[] {
  const history = readHistory();
  return history.entries
    .filter(e => e.jobName === jobName)
    .reverse()
    .slice(0, limit);
}

/**
 * Identify recurring failures: fingerprints that appear >= RECURRING_THRESHOLD
 * times in the last `windowHours` hours.
 */
function getRecurringFailures(windowHours: number = 24): Array<{
  fingerprint: string;
  count: number;
  jobs: string[];
  lastSummary: string;
  lastTimestamp: string;
}> {
  const history = readHistory();
  const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);

  const recent = history.entries.filter(e =>
    new Date(e.timestamp).getTime() > cutoff && e.outcome !== 'skipped'
  );

  const groups = new Map<string, HealEntry[]>();
  for (const entry of recent) {
    const existing = groups.get(entry.fingerprint) || [];
    existing.push(entry);
    groups.set(entry.fingerprint, existing);
  }

  const recurring: Array<{
    fingerprint: string;
    count: number;
    jobs: string[];
    lastSummary: string;
    lastTimestamp: string;
  }> = [];

  for (const [fp, entries] of groups) {
    if (entries.length >= RECURRING_THRESHOLD) {
      const sorted = entries.sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      recurring.push({
        fingerprint: fp,
        count: entries.length,
        jobs: [...new Set(entries.map(e => e.jobName))],
        lastSummary: sorted[0].summary,
        lastTimestamp: sorted[0].timestamp,
      });
    }
  }

  return recurring.sort((a, b) => b.count - a.count);
}

/**
 * Build a context block for the diagnostic prompt from prior investigations.
 * Returns empty string if no prior history exists for this fingerprint.
 */
function buildPriorContext(fingerprint: string, jobName: string): string {
  const priorByFingerprint = findPriorInvestigations(fingerprint, 3);
  const priorByJob = findPriorForJob(jobName, 3);

  // Deduplicate (fingerprint matches may overlap with job matches)
  const seen = new Set<string>();
  const allPrior: HealEntry[] = [];
  for (const entry of [...priorByFingerprint, ...priorByJob]) {
    const key = `${entry.timestamp}-${entry.fingerprint}`;
    if (!seen.has(key)) {
      seen.add(key);
      allPrior.push(entry);
    }
  }

  if (allPrior.length === 0) return '';

  const lines = [
    'PRIOR INVESTIGATION HISTORY (from persistent memory):',
    `Found ${allPrior.length} prior investigation(s) for this job/error pattern.`,
    '',
  ];

  for (const entry of allPrior.slice(0, 5)) {
    lines.push(`- [${entry.timestamp}] ${entry.jobName} → ${entry.outcome.toUpperCase()}`);
    lines.push(`  Error fingerprint: ${entry.fingerprint}`);
    lines.push(`  Summary: ${entry.summary.slice(0, 300)}`);
    if (entry.fixCommit) {
      lines.push(`  Fix commit: ${entry.fixCommit}`);
    }
    lines.push('');
  }

  const recurring = getRecurringFailures(24);
  const thisRecurring = recurring.find(r => r.fingerprint === fingerprint);
  if (thisRecurring) {
    lines.push(`⚠ RECURRING FAILURE: This error pattern has occurred ${thisRecurring.count} times in the last 24 hours.`);
    lines.push(`  Affected jobs: ${thisRecurring.jobs.join(', ')}`);
    lines.push('  Consider: is the prior fix incomplete? Is there a deeper root cause?');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get full history (for inspection/debugging).
 */
function getHistory(): HealHistory {
  return readHistory();
}

/**
 * Get summary stats for reporting (e.g., nightly immune cycle).
 */
function getStats(windowHours: number = 24): {
  total: number;
  fixed: number;
  proposed: number;
  failed: number;
  recurring: number;
  topFailures: Array<{ fingerprint: string; count: number; jobs: string[] }>;
} {
  const history = readHistory();
  const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);
  const recent = history.entries.filter(e =>
    new Date(e.timestamp).getTime() > cutoff && e.outcome !== 'skipped'
  );

  const recurring = getRecurringFailures(windowHours);

  return {
    total: recent.length,
    fixed: recent.filter(e => e.outcome === 'fixed').length,
    proposed: recent.filter(e => e.outcome === 'proposed').length,
    failed: recent.filter(e => e.outcome === 'failed').length,
    recurring: recurring.length,
    topFailures: recurring.slice(0, 3),
  };
}

module.exports = {
  recordInvestigation,
  findPriorInvestigations,
  findPriorForJob,
  getRecurringFailures,
  buildPriorContext,
  getHistory,
  getStats,
};
