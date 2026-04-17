#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Self-Improvement Working Group
 *
 * Reads correction logs, learning ledger, nightly analysis, brief feedback.
 * Finds the highest-impact unaddressed issue. Builds the fix on a preview branch.
 *
 * Runs nightly via daemon-jobs.ts.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadEnv, createLogger, checkAuth } = require('./lib/shared.ts');
const { logToDaily, getNowCT } = require('./lib/keel-env.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..');
Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));

const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const DATE = new Date().toISOString().split('T')[0];
const { log } = createLogger(path.join(LOG_DIR, `working-group-self-improvement-${DATE}.log`));

const { supabaseGet } = require('./lib/supabase.ts');
const { dispatch } = require('./lib/task-dispatch.ts');
const { getBudget, isOverBudget } = require('./lib/resource-budgets.ts');
const { processMessage, CHANNELS } = require('./lib/keel-engine.ts');

const BUDGET = getBudget('self-improvement');
const START_TIME = Date.now();

async function findTarget(): Promise<any | null> {
  // Priority: recurring corrections > self-assessment > keel gaps > brief feedback
  const corrections = await supabaseGet('learning_ledger',
    'select=id,pattern_name,correction_text,severity,occurrence_count&severity=gte.5&occurrence_count=gte.2&order=severity.desc,occurrence_count.desc&limit=5'
  ).catch(() => []);

  if (corrections.length > 0) {
    const c = corrections[0];
    return { type: 'correction', data: c, description: `Correction sev ${c.severity} (${c.occurrence_count}x): ${c.pattern_name}` };
  }

  const findings = await supabaseGet('deep_process_outputs',
    'select=id,domain,summary,findings&domain=eq.self&incorporated=eq.false&order=created_at.desc&limit=3'
  ).catch(() => []);

  if (findings.length > 0) {
    return { type: 'finding', data: findings[0], description: `Self-assessment: ${findings[0].summary?.slice(0, 150)}` };
  }

  const gaps = await supabaseGet('capability_requests',
    'select=id,user_message,gap_type,frequency&source_prefix=eq.keel&status=eq.detected&order=frequency.desc&limit=3'
  ).catch(() => []);

  if (gaps.length > 0) {
    return { type: 'gap', data: gaps[0], description: `Keel gap: ${gaps[0].user_message?.slice(0, 150)}` };
  }

  return null;
}

async function run() {
  log('INFO', '=== Self-Improvement Working Group Starting ===');
  if (!checkAuth(log).ok) { process.exit(1); }

  const target = await findTarget();
  if (!target) { log('INFO', 'Nothing actionable. Exiting.'); return; }
  log('INFO', `Target: ${target.description}`);

  const d = dispatch(target.description, { group: 'self-improvement', externalFacing: false, estimatedScope: 'small', requiresJudgment: target.type === 'finding' });
  log('INFO', `Dispatch: ${d.mode} via ${d.substrate}`);

  const branch = `preview/self-fix-${Date.now()}`;
  try { execSync(`git checkout -b ${branch}`, { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }); } catch {}

  const prompt = `Fix this issue in Keel's codebase:\n\n${target.description}\n${target.type === 'correction' ? `\nCorrection text: ${target.data.correction_text}\nSeverity: ${target.data.severity}, Occurrences: ${target.data.occurrence_count}` : ''}\n${target.type === 'finding' ? `\nFindings: ${JSON.stringify(target.data.findings)?.slice(0, 2000)}` : ''}\n\nRead code. Fix it. Test it.\n\nSELF_FIX_SUMMARY_START\nIssue: [one line]\nFix: [what changed]\nFiles: [which files]\nTest: [verification]\nSELF_FIX_SUMMARY_END`;

  try {
    const daemonSessionId = process.env.ALIENKIND_DAEMON_SESSION_ID;
    const daemonSessionResume = process.env.ALIENKIND_DAEMON_SESSION_RESUME === 'true';
    const result = await processMessage(prompt, {
      channelConfig: CHANNELS.research, log: (l: string, m: string) => log(l, m),
      sender: 'system', senderDisplayName: 'Self-Improvement',
      substrate: d.substrate as any,
      allowedTools: 'Bash(node *),Bash(npx *),Bash(ls *),Bash(mkdir *),Read,Edit,Write,Glob,Grep',
      recentMessageCount: 3,
      ...(daemonSessionId && daemonSessionResume ? { resumeSessionId: daemonSessionId } : {}),
      ...(daemonSessionId && !daemonSessionResume ? { sessionId: daemonSessionId } : {}),
    });

    const match = (result.text || '').match(/SELF_FIX_SUMMARY_START\n([\s\S]*?)SELF_FIX_SUMMARY_END/);
    const summary = match ? match[1].trim() : 'No summary.';

    const time = getNowCT();
    logToDaily(`### Self-Improvement (${time} CDT)\n${target.description.slice(0, 150)}\nBranch: ${branch}\n${summary}`, undefined, false);
  } catch (e: any) { log('ERROR', `Failed: ${e.message}`); }

  try { execSync('git checkout main', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }); } catch {}
  log('INFO', '=== Self-Improvement Complete ===');
}

run().catch(e => { log('ERROR', `Fatal: ${e.message}`); process.exit(1); });
