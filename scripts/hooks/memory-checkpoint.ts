#!/usr/bin/env node

/**
 * Memory checkpoint — Stop hook.
 *
 * Uses REAL context window percentage from THIS terminal's Supabase row
 * (written by context-checkpoint.ts StatusLine hook) to trigger
 * flush reminders and handoff cues.
 *
 * Tiers calibrated to CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=96:
 *   - >=85% used (~850K tokens): advisory — "getting deep, /handoff when ready"
 *   - >=92% used (~920K tokens): urgent — "/handoff recommended"
 *   - >=55% used (~550K tokens): standard reminder (every 8th response)
 *
 * Compaction fires at 96% (our override). Handoff uses 0 model tokens.
 * The 4% buffer between 92% urgent cue and 96% compaction = 40K tokens —
 * more than enough for [HUMAN] to see the cue and type /handoff.
 *
 * Fires on: Stop event (every assistant response)
 */

const fs = require('fs');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();

// Infrastructure deps — degrade gracefully on a fresh fork
let getNowCT: () => string;
try {
  getNowCT = require('../lib/keel-env.ts').getNowCT;
} catch {
  getNowCT = () => new Date().toISOString();
}
const STALENESS_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const CONTEXT_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes
const SECTION_LINE_THRESHOLD = 100; // sections above this are too large for a daily file

async function getContextPercentage(): Promise<number | null> {
  if (process.env.KEEL_TEST_CONTEXT_PCT) {
    const pct = parseFloat(process.env.KEEL_TEST_CONTEXT_PCT);
    return isNaN(pct) ? null : pct;
  }
  try {
    const { getTerminalId, getTerminal } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
    );
    const terminalId = getTerminalId();
    const row = await getTerminal(terminalId);
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    if (ageMs > CONTEXT_FRESHNESS_MS) return null;
    return row.context_used_pct;
  } catch {
    return null;
  }
}

/**
 * Daily-file hygiene: detect deliverables dumped into daily files.
 *
 * Two checks:
 * 1. H1 artifact detection — daily files should NEVER contain # (h1) headers.
 *    An h1 signals a standalone deliverable (review, analysis, diagnostic) that
 *    belongs in its own file (memory/deliberations/, memory/audits/, etc.).
 *    Measures lines from h1 to next h1 or EOF.
 *
 * 2. Large ## section detection — any single ## section exceeding
 *    SECTION_LINE_THRESHOLD is too large for a daily entry.
 *
 * Returns warning string or null if clean.
 */
function checkDailyFileHygiene(): string | null {
  try {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dailyPath = path.join(KEEL_DIR, 'memory', 'daily', `${yyyy}-${mm}-${dd}.md`);

    if (!fs.existsSync(dailyPath)) return null;

    const content = fs.readFileSync(dailyPath, 'utf8');
    const lines = content.split('\n');
    const warnings: string[] = [];

    // --- Check 1: H1 artifact detection ---
    // Daily files are flat lists of ## entries. An h1 header = a deliverable that
    // should be its own file.
    const h1Sections: { header: string; startLine: number; lineCount: number }[] = [];
    let h1Header: string | null = null;
    let h1Start = 0;
    let h1Count = 0;

    for (let i = 0; i < lines.length; i++) {
      // Match "# Header" but not "## Header"
      if (/^# [^#]/.test(lines[i])) {
        if (h1Header !== null && h1Count > 0) {
          h1Sections.push({ header: h1Header, startLine: h1Start + 1, lineCount: h1Count });
        }
        h1Header = lines[i].replace(/^# /, '').trim();
        h1Start = i;
        h1Count = 0;
      }
      if (h1Header !== null) h1Count++;
    }
    if (h1Header !== null && h1Count > 0) {
      h1Sections.push({ header: h1Header, startLine: h1Start + 1, lineCount: h1Count });
    }

    if (h1Sections.length > 0) {
      warnings.push('H1 ARTIFACTS in daily file (deliverables that should be separate files):');
      for (const s of h1Sections) {
        warnings.push(`  "# ${s.header}" — ${s.lineCount} lines starting at line ${s.startLine}`);
      }
    }

    // --- Check 2: Oversized ## sections ---
    const h2Sections: { header: string; lineCount: number }[] = [];
    let h2Header = '(top of file)';
    let h2Count = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        if (h2Count > SECTION_LINE_THRESHOLD) {
          h2Sections.push({ header: h2Header, lineCount: h2Count });
        }
        h2Header = lines[i].replace(/^## /, '').trim();
        h2Count = 0;
      }
      h2Count++;
    }
    if (h2Count > SECTION_LINE_THRESHOLD) {
      h2Sections.push({ header: h2Header, lineCount: h2Count });
    }

    if (h2Sections.length > 0) {
      warnings.push('Oversized ## sections (threshold: ' + SECTION_LINE_THRESHOLD + ' lines):');
      for (const s of h2Sections) {
        warnings.push(`  "## ${s.header}" — ${s.lineCount} lines`);
      }
    }

    if (warnings.length === 0) return null;

    return (
      'DAILY FILE HYGIENE — issues detected:\n' +
      warnings.join('\n') + '\n' +
      'Daily files are reflection surfaces, not deliverable dumps.\n' +
      'Extract artifacts to memory/deliberations/, memory/audits/, or a dedicated file,\n' +
      'then link from the daily entry with a one-line summary.'
    );
  } catch {
    return null;
  }
}

function checkSessionStateStaleness(): string | null {
  try {
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALENESS_THRESHOLD_MS) {
      const ageMin = Math.round(ageMs / 60000);
    }
  } catch {
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const counterFile = `/tmp/keel-memory-checkpoint-${sessionId}`;

  let count = 0;
  try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  count++;
  fs.writeFileSync(counterFile, String(count));

  // Daily-file hygiene check: run once per session (first response only)
  if (count === 1) {
    const hygieneWarning = checkDailyFileHygiene();
    if (hygieneWarning) {
      console.log(hygieneWarning);
    }
  }

  const contextPct = await getContextPercentage();
  if (contextPct === null) process.exit(0);

  const remaining = 100 - contextPct;
  let tier: 'urgent' | 'advisory' | 'standard' | null = null;
  let triggerSource = '';

  // Tiers: urgent (8% remaining) → advisory (15% remaining) → standard (45% remaining)
  // Compaction at 96% (our override). Handoff costs 0 model tokens.
  if (remaining <= 8) {
    tier = 'urgent';
    triggerSource = `${remaining.toFixed(0)}% remaining (~${Math.round(remaining * 10)}K tokens)`;
  } else if (remaining <= 15) {
    tier = 'advisory';
    triggerSource = `${remaining.toFixed(0)}% remaining (~${Math.round(remaining * 10)}K tokens)`;
  } else if (remaining <= 45 && count >= 8 && count % 8 === 0) {
    tier = 'standard';
    triggerSource = `${remaining.toFixed(0)}% remaining, response #${count}`;
  }

  if (tier === null) process.exit(0);

  const staleness = checkSessionStateStaleness();

  if (tier === 'urgent') {
    // Auto-preserve: write structured handoff state + mark in Supabase + deposit to circulation
    try {
      const { getTerminalId, upsertTerminal } = require(
        path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
      );
      const termId = getTerminalId();

      // Write structured handoff file with current session state
      try {
        const handoffDir = path.join(KEEL_DIR, 'memory', 'handoffs');
        fs.mkdirSync(handoffDir, { recursive: true });
        const handoffFile = path.join(handoffDir, `auto-${termId}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.md`);

        // Gather what we know about this session
        const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;
        let tracking: any = {};
        try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}

        const handoffContent = [
          `# Auto-Preserved Handoff — ${termId}`,
          ``,
          `**Context:** ${contextPct.toFixed(0)}% used. Auto-preserved at ${getNowCT()}.`,
          ``,
          `## Files Modified This Session`,
          ...(tracking.codeFiles || []).map((f: string) => `- ${f}`),
          ``,
          `## Verification State`,
          `- Syntax: ${tracking.verifyEvidence?.syntax ? 'PASSED' : 'NOT RUN'}`,
          `- Tests: ${tracking.verifyEvidence?.test ? 'PASSED' : 'NOT RUN'}`,
          `- Flow: ${tracking.verifyEvidence?.flow ? 'PASSED' : 'NOT RUN'}`,
          ``,
          `## Integration Docs Updated`,
          ...(tracking.integrateDocs || []).map((f: string) => `- ${f}`),
          ``,
          `_Auto-generated by memory-checkpoint. Read this file to resume where this session left off._`,
        ].join('\n');

        fs.writeFileSync(handoffFile, handoffContent);
      } catch {}

      await upsertTerminal(termId, {
        handoff_pending: true,
        context_used_pct: Math.round(contextPct),
      });

      try {
        const { deposit, delegateTask } = require(path.resolve(__dirname, '..', 'lib', 'circulation.ts'));
        await deposit({
          source_organ: 'memory-checkpoint',
          finding: `Terminal ${termId} at ${contextPct.toFixed(0)}% context — handoff pending. State auto-preserved.`,
          finding_type: 'signal',
          domain: 'infrastructure',
          confidence: 1.0,
          action_tier: 'T2',
        });

        // Delegate uncommitted work to another terminal
        let delegateTracking: any = {};
        try { delegateTracking = JSON.parse(fs.readFileSync(`/tmp/keel-build-cycle-${sessionId}.json`, 'utf8')); } catch {}
        const uncommittedFiles = delegateTracking.codeFiles || [];
        if (uncommittedFiles.length > 0 && !delegateTracking.verifyEvidence?.test) {
          await delegateTask({
            task: `Verify and commit uncommitted work: ${uncommittedFiles.join(', ')}`,
            reason: `Terminal ${termId} at ${contextPct.toFixed(0)}% context, handoff pending`,
            fromTerminal: termId,
            requiredMode: 'builder',
            priority: 7,
          });
        }
      } catch {}
    } catch {}

    console.log(
      `⚠ HANDOFF CUE — URGENT (${triggerSource}): ` +
      'Context getting tight. /handoff recommended.\n' +
      'Compaction fires at 96%. Handoff uses zero model tokens — safe to run now.\n' +
      '2. Tell [HUMAN]: "/handoff recommended — context at ' + contextPct.toFixed(0) + '%"\n' +
      (staleness ? `WARNING: ${staleness}\n` : '') +
      'State auto-preserved to Supabase. Recovery possible if compaction fires.\n' +
      'If [HUMAN] doesn\'t handoff, compaction will fire at 96% (lossy).'
    );
  } else if (tier === 'advisory') {
    console.log(
      `HANDOFF CUE — ADVISORY (${triggerSource}): ` +
      'Getting deep. /handoff when ready.\n' +
      '1. Write any unrecorded decisions/learnings to today\'s daily file\n' +
      (staleness ? `NOTE: ${staleness}\n` : '') +
      'Plenty of room — just start thinking about a clean handoff point.'
    );
  } else if (tier === 'standard') {
    console.log(
      `MEMORY CHECKPOINT (${triggerSource}): ` +
      'Write current decisions, learnings, and working state to daily file ' +
      (staleness ? `\n${staleness} ` : '') +
      'If you haven\'t written it down, it didn\'t happen.'
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
