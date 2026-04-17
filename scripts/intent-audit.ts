#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Intent Audit & Fulfillment — nightly closed-loop gap closure.
 *
 * Reads every commit from the last 24h, audits each for:
 *   1. INTENT COMPLETION — does the codebase fully reflect the commit's intent?
 *   2. CAPABILITY PROPAGATION — is harness.md updated? Are reasoning defaults wired?
 *   3. DOWNSTREAM GAPS — stale references, broken consumers, missing tests
 *
 * For each finding:
 *   - Bounded + codeable → fix it (builder mode, preview branch, no compute caps)
 *   - Needs judgment → surface in morning brief with specific recommendation
 *
 * Daemon job: runs at 1:00 AM (after nightly analysis, before keel-research).
 * Builder mode. No compute caps.
 *
 * Usage:
 *   npx tsx scripts/intent-audit.ts                  # full audit + fix
 *   npx tsx scripts/intent-audit.ts --audit-only     # audit without fixing
 *   npx tsx scripts/intent-audit.ts --commit SHA     # audit a specific commit
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logToDaily, getNowCT } = require('./lib/keel-env.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..');

// --- Git helpers ---

function gitExec(cmd: string): string {
  return execSync(cmd, { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 15000 }).trim();
}

function getTodaysCommits(): Array<{ hash: string; message: string; files: string[] }> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const logOutput = gitExec(`git log --since="${since}T00:00:00" --format="%H|%s" --no-merges`);
    if (!logOutput) return [];
    return logOutput.split('\n').filter(Boolean).map(line => {
      const [hash, ...msgParts] = line.split('|');
      const message = msgParts.join('|');
      let files: string[] = [];
      try { files = gitExec(`git diff-tree --no-commit-id --name-only -r ${hash}`).split('\n').filter(Boolean); } catch {}
      return { hash: hash.trim(), message: message.trim(), files };
    });
  } catch { return []; }
}

// --- Audit checks ---

interface AuditFinding {
  commit: string;
  commitMessage: string;
  type: 'intent_completion' | 'capability_propagation' | 'downstream_gap' | 'missing_test';
  description: string;
  severity: 'fix' | 'surface';
  files?: string[];
}

function auditCommit(commit: { hash: string; message: string; files: string[] }): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const msg = commit.message.toLowerCase();
  const shortHash = commit.hash.slice(0, 7);

  // Check 1: Capability propagation
  const isFeat = msg.startsWith('feat:') || msg.startsWith('feat(');
  const newScripts = commit.files.filter(f =>
    f.startsWith('scripts/') && !f.startsWith('scripts/tests/') && !f.startsWith('scripts/hooks/') && f.endsWith('.ts'));
  const harnessUpdated = commit.files.includes('identity/harness.md');
  if (isFeat && newScripts.length > 0 && !harnessUpdated) {
    findings.push({
      commit: shortHash, commitMessage: commit.message, type: 'capability_propagation',
      description: `New feature with ${newScripts.length} script(s) but harness.md not updated. Scripts: ${newScripts.join(', ')}`,
      severity: 'fix', files: ['identity/harness.md', ...newScripts],
    });
  }

  // Check 2: Intent completion for migrations — DYNAMIC extraction
  // Instead of a hardcoded list, extract old/new pairs from the commit message itself.
  // Pattern: "X→Y", "X to Y", "rename X", "replace X with Y", "migrate from X"
  if (msg.includes('migrat') || msg.includes('replac') || msg.includes('renam') || msg.includes('→') || msg.includes('->') || msg.includes('nuke') || msg.includes('purge')) {
    const extractedTerms: string[] = [];

    // Extract from arrow patterns: "X→Y", "X->Y", "X → Y"
    const arrowMatches = commit.message.match(/(\S+)\s*(?:→|->)\s*(\S+)/g);
    if (arrowMatches) {
      for (const m of arrowMatches) {
        const parts = m.split(/\s*(?:→|->)\s*/);
        if (parts[0] && parts[0].length >= 3) extractedTerms.push(parts[0].trim());
      }
    }

    // Extract from "rename/replace/migrate X" patterns
    const verbPatterns = [
      /(?:renam|replac|migrat|nuk|purg)\w*\s+(?:all\s+)?(\S{3,})/gi,
      /(?:from|remove|eradicat)\w*\s+(\S{3,})/gi,
    ];
    for (const pat of verbPatterns) {
      let match;
      while ((match = pat.exec(commit.message)) !== null) {
        const term = match[1].replace(/[,.:;'"]/g, '').trim();
        if (term.length >= 3 && !['the', 'all', 'and', 'for', 'with', 'from', 'into'].includes(term.toLowerCase())) {
          extractedTerms.push(term);
        }
      }
    }

    // Deduplicate and grep for each extracted term
    const uniqueTerms = Array.from(new Set(extractedTerms));
    for (const term of uniqueTerms) {
      // Skip terms that are too generic or too short
      if (term.length < 3 || /^\d+$/.test(term)) continue;
      // Escape special regex chars for grep
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const grepResult = gitExec(
          `grep -rl "${escaped}" scripts/ config/ --include="*.ts" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v ".git" | grep -v scripts/tests/ | grep -v scripts/intent-audit.ts | head -10`
        );
        if (grepResult) {
          const staleFiles = grepResult.split('\n').filter(Boolean);
          findings.push({
            commit: shortHash, commitMessage: commit.message, type: 'intent_completion',
            description: `Migration/rename: "${term}" still referenced in ${staleFiles.length} file(s) after commit "${commit.message.slice(0, 60)}"`,
            severity: 'fix', files: staleFiles,
          });
        }
      } catch { /* grep found nothing — clean */ }
    }
  }

  // Check 3: New scripts without test files
  for (const script of newScripts) {
    if (script.startsWith('scripts/lib/') || script.startsWith('scripts/tools/')) {
      const baseName = path.basename(script, '.ts');
      const testFile = `scripts/tests/test-${baseName}.ts`;
      if (!commit.files.includes(testFile) && !fs.existsSync(path.join(ALIENKIND_DIR, testFile))) {
        findings.push({
          commit: shortHash, commitMessage: commit.message, type: 'missing_test',
          description: `New script ${script} has no test file (expected: ${testFile})`,
          severity: 'surface', files: [script],
        });
      }
    }
  }

  return findings;
}

// --- Fix findings using Claude ---

async function fixFinding(finding: AuditFinding, log: Function): Promise<{ fixed: boolean; branch?: string; summary: string }> {
  if (finding.severity !== 'fix') return { fixed: false, summary: `Surfaced: ${finding.description}` };

  const { loadEnv } = require('./lib/shared.ts');
  Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));
  const { processMessage, CHANNELS } = require('./lib/keel-engine.ts');

  const originalBranch = gitExec('git rev-parse --abbrev-ref HEAD');
  const branchSlug = finding.type.replace(/_/g, '-') + '-' + finding.commit;
  const branchName = `preview/intent-${branchSlug}`;

  try { gitExec(`git checkout -b ${branchName}`); }
  catch { try { gitExec(`git checkout ${branchName}`); } catch { return { fixed: false, summary: `Branch creation failed` }; } }

  log('INFO', `Fixing on ${branchName}: ${finding.description}`);

  try {
    let taskDesc = '';
    if (finding.type === 'capability_propagation') {
      taskDesc = `Update identity/harness.md to include the new capability. Read the new scripts to understand what they do, then add entries. Match existing format.`;
    } else if (finding.type === 'intent_completion') {
      taskDesc = `Find and fix all remaining stale references. Update each file to use the correct name. Verify with grep that zero stale references remain.`;
    } else {
      taskDesc = `Fix this gap. Read the files, understand the issue, fix it, verify.`;
    }

    const gapContext = `TYPE: ${finding.type}\nDESCRIPTION: ${finding.description}\nCOMMIT: ${finding.commit} — "${finding.commitMessage}"\nFILES: ${(finding.files || []).join('\n')}`;

    const prompt = `The nightly intent-audit found a gap.\n${taskDesc}\nYou are on a preview branch. Fix the issue, verify, stop. Do NOT push. Keep changes minimal.`;

    const daemonSessionId = process.env.ALIENKIND_DAEMON_SESSION_ID;
    const daemonSessionResume = process.env.ALIENKIND_DAEMON_SESSION_RESUME === 'true';
    const result = await processMessage(prompt, {
      channelConfig: CHANNELS.intent_audit,
      log: (level: string, msg: string) => log(level, msg),
      additionalContext: gapContext,
      sender: 'system',
      senderDisplayName: 'Intent Audit',
      allowedTools: 'Read,Edit,Write,Glob,Grep,Bash(node *),Bash(npx *),Bash(grep *),Bash(ls *)',
      recentMessageCount: 0,
      ...(daemonSessionId && daemonSessionResume ? { resumeSessionId: daemonSessionId } : {}),
      ...(daemonSessionId && !daemonSessionResume ? { sessionId: daemonSessionId } : {}),
    });

    const status = gitExec('git status --porcelain');
    if (status) {
      const files = status.split('\n').map((l: string) => l.slice(3).trim()).filter((f: string) => f && !f.includes('.env'));
      for (const f of files) { try { gitExec(`git add "${f}"`); } catch {} }
      // ACTIVATE gate
      const { checkActivateGate } = require('./lib/activate-gate.ts');
      const activateCheck = checkActivateGate();
      if (!activateCheck.passed) {
        log('WARN', `ACTIVATE BLOCKED: ${activateCheck.reason}`);
        return { fixed: false, summary: `ACTIVATE blocked: daemon stale` };
      }
      gitExec(`git commit -m "fix(intent): ${finding.type} — ${finding.description.slice(0, 60)}"`);
      return { fixed: true, branch: branchName, summary: `Fixed: ${finding.description}` };
    }
    return { fixed: false, summary: `No changes needed` };
  } catch (err: any) {
    return { fixed: false, summary: `Fix failed: ${err.message}` };
  } finally {
    try { gitExec(`git checkout ${originalBranch}`); } catch {}
  }
}

// --- Main (only runs when called directly) ---

async function main() {
  const { loadEnv, createLogger, checkAuth } = require('./lib/shared.ts');
  Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));

  const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const DATE = new Date().toISOString().split('T')[0];
  const { log } = createLogger(path.join(LOG_DIR, `intent-audit-${DATE}.log`));

  const args = process.argv.slice(2);
  const auditOnly = args.includes('--audit-only');
  const specificCommit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;

  log('INFO', '=== Intent Audit & Fulfillment Starting ===');

  const authResult = checkAuth(log);
  if (!authResult.ok) { log('ERROR', `Auth failed: ${authResult.reason}`); process.exit(1); }

  let commits;
  if (specificCommit) {
    const message = gitExec(`git log -1 --format=%s ${specificCommit}`);
    const files = gitExec(`git diff-tree --no-commit-id --name-only -r ${specificCommit}`).split('\n').filter(Boolean);
    commits = [{ hash: specificCommit, message, files }];
  } else {
    commits = getTodaysCommits();
  }

  log('INFO', `Found ${commits.length} commits to audit`);
  if (commits.length === 0) { log('INFO', 'Nothing to audit.'); return; }

  const allFindings: AuditFinding[] = [];
  for (const commit of commits) {
    const findings = auditCommit(commit);
    if (findings.length > 0) {
      log('INFO', `${commit.hash.slice(0, 7)} "${commit.message.slice(0, 50)}": ${findings.length} finding(s)`);
      allFindings.push(...findings);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = allFindings.filter(f => {
    const key = `${f.type}:${f.description.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log('INFO', `Total: ${allFindings.length}, Unique: ${deduped.length}`);

  const results: Array<{ finding: AuditFinding; result: { fixed: boolean; branch?: string; summary: string } }> = [];
  for (const finding of deduped) {
    if (auditOnly || finding.severity !== 'fix') {
      results.push({ finding, result: { fixed: false, summary: finding.description } });
    } else {
      const result = await fixFinding(finding, log);
      results.push({ finding, result });
    }
  }

  // Write to daily file
  const time = getNowCT();
  const fixed = results.filter(r => r.result.fixed);
  const surfaced = results.filter(r => !r.result.fixed);
  let entry = `## Intent Audit — ${time} CDT\n\n${deduped.length} findings from ${commits.length} commits.`;
  if (fixed.length > 0) {
    entry += `\n\n**Fixed (${fixed.length} preview branches):**`;
    for (const r of fixed) entry += `\n- \`${r.result.branch}\`: ${r.result.summary}`;
  }
  if (surfaced.length > 0) {
    entry += `\n\n**Surfaced (${surfaced.length}):**`;
    for (const r of surfaced) entry += `\n- [${r.finding.type}] ${r.result.summary}`;
  }
  logToDaily(entry, undefined, false);

  // Deposit findings into circulation (Supabase-backed stigmergic bloodstream)
  try {
    const { deposit } = require('./lib/circulation.ts');
    for (const r of results) {
      if (r.result.fixed) {
        await deposit({
          source_organ: 'intent-audit',
          finding: `Fixed: ${r.result.summary} (branch: ${r.result.branch})`,
          finding_type: 'gap',
          domain: 'infrastructure',
          confidence: 0.9,
          action_tier: 'T1',
          related_files: r.finding.files,
        });
      } else if (r.finding.severity === 'surface') {
        await deposit({
          source_organ: 'intent-audit',
          finding: `Needs attention: ${r.result.summary}`,
          finding_type: 'gap',
          domain: 'infrastructure',
          confidence: 0.7,
          action_tier: 'T3',
          related_files: r.finding.files,
        });
      }
    }
  } catch { /* circulation unavailable — non-fatal */ }

  const fixedCount = fixed.length;
  const surfacedCount = surfaced.length;
  log('INFO', `=== Complete: ${fixedCount} fixed, ${surfacedCount} surfaced ===`);
  console.log(`Intent audit: ${fixedCount} fixed, ${surfacedCount} surfaced`);
}

// Only run main() when called directly, not on require()
if (require.main === module) {
  main().catch(err => {
    try { gitExec('git checkout main'); } catch {}
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { auditCommit, getTodaysCommits };
