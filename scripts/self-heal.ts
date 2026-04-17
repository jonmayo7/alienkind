#!/usr/bin/env node

/**
 * Self-Heal — Autonomous investigation + fix for failed daemon jobs.
 *
 * Called by daemon.js onError callback when a self-healing job fails.
 * NOT a daemon job. Runs as an async function within the daemon process.
 *
 * Flow:
 *   1. Notify [HUMAN]: "Investigating {job} failure..."
 *   2. Read relevant logs, git state, affected script
 *   3. Spawn isolated Claude session with diagnostic prompt
 *   4. Parse result: FIXED / PROPOSE / FAILED
 *   5. If FIXED (clean fix, tests pass, small diff): auto-committed, notify [HUMAN]
 *   6. If PROPOSE: update intent with concrete diagnosis, notify [HUMAN]
 *   7. If FAILED: notify [HUMAN] with what was tried
 *
 * Isolation: own session (no shared Telegram/daemon session), own lock file.
 * Recursion prevention: lock file + per-job cooldown + not in SELF_HEALING_JOBS.
 *
 * Writers: daemon.js (calls investigate)
 * Readers: [HUMAN] (via Telegram), intents table (via Supabase)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadEnv, getActiveConfigDir, isAuthError, checkAuth, attemptSelfHeal } = require('./lib/shared.ts');
const { processMessage, CHANNELS } = require('./lib/keel-engine.ts');
const { supabasePatch } = require('./lib/supabase.ts');
const { TIMEZONE, SELF_HEAL, MODELS } = require('./lib/constants.ts');
const { recordInvestigation, buildPriorContext } = require('./lib/heal-history.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..');
const PARTIAL_DIR = path.join(ALIENKIND_DIR, 'logs');

// Ensure env is loaded for Supabase calls
const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
Object.assign(process.env, env);

// --- Lock Management ---

function acquireHealLock(jobName, log) {
  const lockPath = path.join(ALIENKIND_DIR, SELF_HEAL.lockFile);
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const age = Date.now() - new Date(lock.timestamp).getTime();
      if (age < SELF_HEAL.lockMaxAgeMs) {
        log('WARN', `[self-heal] Lock held by ${lock.jobName} (${Math.round(age / 1000)}s ago) — skipping`);
        return false;
      }
      log('WARN', `[self-heal] Stale lock from ${lock.jobName} (${Math.round(age / 1000)}s) — clearing`);
    } catch {
      // Corrupt lock file — clear it
    }
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    jobName,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  }));
  return true;
}

function releaseHealLock() {
  const lockPath = path.join(ALIENKIND_DIR, SELF_HEAL.lockFile);
  try { fs.unlinkSync(lockPath); } catch {}
}

// --- Per-job AND per-root-cause cooldown ---

const recentInvestigations = new Map();
const recentDiagnoses = new Map<string, { ts: number; summary: string }>();

function getErrorFingerprint(errMsg: string): string {
  return errMsg.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function canInvestigate(jobName, log, errorMsg?: string) {
  // Per-job cooldown
  const last = recentInvestigations.get(jobName);
  if (last && Date.now() - last < SELF_HEAL.cooldownMs) {
    log('INFO', `[self-heal] ${jobName} on cooldown (${Math.round((Date.now() - last) / 1000)}s ago) — skipping`);
    return false;
  }
  // Per-root-cause cooldown (15 min window)
  if (errorMsg) {
    const fp = getErrorFingerprint(errorMsg);
    const prev = recentDiagnoses.get(fp);
    if (prev && Date.now() - prev.ts < 900000) {
      log('INFO', `[self-heal] Same root cause already diagnosed ${Math.round((Date.now() - prev.ts) / 1000)}s ago — skipping. Prior diagnosis: ${prev.summary.slice(0, 100)}`);
      return false;
    }
  }
  return true;
}

// --- Context Gathering ---

function readLogTail(jobName) {
  // Try job-specific log, fall back to daemon log
  const date = new Date().toISOString().split('T')[0];
  const candidates = [
    path.join(ALIENKIND_DIR, 'logs', `${jobName.replace('-hourly', '')}-${date}.log`),
    path.join(ALIENKIND_DIR, 'logs', `${jobName}.log`),
    path.join(ALIENKIND_DIR, 'logs', `daemon-${date}.log`),
  ];
  for (const logFile of candidates) {
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n');
        return lines.slice(-SELF_HEAL.logTailLines).join('\n');
      } catch { continue; }
    }
  }
  return '(no log file found)';
}

function getGitContext() {
  try {
    const gitLog = execSync('git log --oneline -5', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
    const gitDiff = execSync('git diff --stat HEAD~3 2>/dev/null || echo "(less than 3 commits)"', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
    return { gitLog, gitDiff };
  } catch {
    return { gitLog: '(git unavailable)', gitDiff: '' };
  }
}

// Full grounding context so the diagnostic session IS Keel, not raw Claude.
// CLAUDE.md loads automatically from CWD. This adds: grounding, daily memory,
// git log, daily file — the same sources a full Keel boot reads.
function getGroundingContext() {
  const sections = [];

  // Run grounding script for time/services/sessions
  try {
    const grounding = execSync('bash scripts/ground.sh 2>/dev/null', {
      cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 10000
    });
    sections.push(`GROUNDING:\n${grounding}`);
  } catch {
    sections.push(`GROUNDING:\nTime: ${new Date().toISOString()}\n(ground.sh unavailable)`);
  }

  // Today's daily memory (last 100 lines to stay concise)
  const date = new Date().toISOString().split('T')[0];
  const dailyPath = path.join(ALIENKIND_DIR, 'memory', 'daily', `${date}.md`);
  try {
    const daily = fs.readFileSync(dailyPath, 'utf8');
    const lines = daily.split('\n');
    const tail = lines.length > 100 ? lines.slice(-100).join('\n') : daily;
    sections.push(`TODAY'S DAILY MEMORY (${dailyPath}):\n${tail}`);
  } catch {
    sections.push('DAILY MEMORY: (not found)');
  }

  // Recent git log — what was actually built (source of truth)
  try {
    const gitLog = execSync('git log --oneline -15', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
    sections.push(`RECENT GIT LOG:\n${gitLog}`);
  } catch {}

  return sections.join('\n\n---\n\n');
}

// --- Partial Diagnostics ---

/**
 * Write partial diagnostic output to a file so that timeout kills (code=143)
 * leave actionable information instead of 'No output'.
 * Returns the file path written, or null on failure.
 */
function writePartialDiagnostics(jobName: string, context: {
  errorMsg: string;
  partialStderr?: string;
  partialResponse?: string;
  exitInfo?: string;
  logTail?: string;
}, log: (...args: any[]) => void): string | null {
  try {
    fs.mkdirSync(PARTIAL_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(PARTIAL_DIR, `self-heal-partial-${ts}.md`);
    const sections = [
      `# Self-Heal Partial Diagnostics`,
      `**Job:** ${jobName}`,
      `**Time:** ${new Date().toISOString()}`,
      `**Exit:** ${context.exitInfo || 'unknown'}`,
      '',
      `## Original Error`,
      context.errorMsg || '(none)',
    ];
    if (context.partialStderr) {
      sections.push('', '## Partial stderr (Claude CLI output)', '```', context.partialStderr, '```');
    }
    if (context.partialResponse) {
      sections.push('', '## Partial Response', context.partialResponse);
    }
    if (context.logTail) {
      sections.push('', '## Log Tail at Time of Failure', '```', context.logTail, '```');
    }
    fs.writeFileSync(filePath, sections.join('\n'));
    log('INFO', `[self-heal] Partial diagnostics written to ${filePath}`);
    return filePath;
  } catch (writeErr) {
    log('WARN', `[self-heal] Failed to write partial diagnostics: ${(writeErr as Error).message}`);
    return null;
  }
}

// --- Diagnostic Prompt ---

function buildDiagnosticPrompt(jobName, errorMsg, scriptPath, logTail, gitLog, gitDiff, groundingContext, priorContext?: string) {
  const priorSection = priorContext
    ? `\n${priorContext}\n---\n`
    : '';

  return `This is an autonomous diagnostic session. A daemon job failed and you need to investigate and fix it.

Apply the same build discipline, same judgment, same thoroughness as any session.

${groundingContext || '(grounding unavailable)'}

---
${priorSection}
FAILURE DETAILS:
- Job: ${jobName}
- Error: ${errorMsg}
- Script: ${scriptPath}
- Time: ${new Date().toISOString()}

RECENT LOG OUTPUT (last ${SELF_HEAL.logTailLines} lines from the most relevant log):
${logTail}

RECENT GIT CHANGES (last 5 commits):
${gitLog}

RECENT FILE DIFFS:
${gitDiff}

INSTRUCTIONS:
1. Read the failing script (${scriptPath}) to understand its current state
2. Read any files mentioned in the error message
3. Diagnose the root cause — what broke and why
4. Attempt a fix — modify only the minimum files needed
5. Run syntax checks: node -c on every JS file you changed
6. Run relevant test suites: node scripts/tests/test-*.ts for affected areas
7. If syntax AND tests pass AND your changes are small (under ${SELF_HEAL.maxDiffLines} lines total):
   - Stage and commit: git add <specific files> && git commit -m "auto-heal: ${jobName} — <brief summary>"
   - Push: git push
   - Write a response starting with exactly: FIXED: <one-line summary>
8. If you found the issue but tests fail or changes are large:
   - DO NOT commit
   - Write a response starting with exactly: PROPOSE: <what you found and what you'd change>
9. If you cannot diagnose the root cause:
   - Write a response starting with exactly: FAILED: <what you tried and what you found>

RULES:
- NEVER modify more than 5 files
- NEVER change test expectations to make tests pass — fix the production code
- NEVER modify CLAUDE.md, identity kernel files, or memory files
- Your response MUST start with exactly one of: FIXED:, PROPOSE:, or FAILED:
- Be thorough but fast — you have ${SELF_HEAL.maxDiagnosticTurns} turns`;
}

// --- Parse Claude Response ---

function parseResult(response) {
  if (!response || typeof response !== 'string') {
    return { status: 'failed', summary: 'No response from diagnostic session' };
  }
  const trimmed = response.trim();
  if (trimmed.startsWith('FIXED:')) {
    return { status: 'fixed', summary: trimmed.slice(6).trim() };
  }
  if (trimmed.startsWith('PROPOSE:')) {
    return { status: 'propose', summary: trimmed.slice(8).trim() };
  }
  if (trimmed.startsWith('FAILED:')) {
    return { status: 'failed', summary: trimmed.slice(7).trim() };
  }
  // No clear prefix — treat as failed
  return { status: 'failed', summary: trimmed.slice(0, 500) };
}

// --- Main Investigation ---

const { alertOperator: _selfHealAlert } = require('./lib/alert-dispatcher.ts');
function sendAlert(text: string) {
  _selfHealAlert({ severity: 'heads-up', source: 'self-heal', summary: text.slice(0, 200), detail: text.length > 200 ? text : undefined, cooldownMs: 0 });
}

async function investigate({ jobName, errorMsg, scriptPath, intentId, log }) {
  if (!canInvestigate(jobName, log, errorMsg)) return { status: 'skipped', summary: 'On cooldown' };
  if (!acquireHealLock(jobName, log)) return { status: 'skipped', summary: 'Lock held' };

  recentInvestigations.set(jobName, Date.now());
  let logTail = '';

  try {
    // Step 1: Investigation notification already sent by daemon.
    // No duplicate notification here.

    // Step 2: Gather context — full grounding so diagnostic session IS Keel
    logTail = readLogTail(jobName);
    const { gitLog, gitDiff } = getGitContext();
    const groundingContext = getGroundingContext();

    // Step 3: Build prompt with full grounding context + prior investigation memory
    const fullScriptPath = scriptPath.startsWith('scripts/')
      ? path.join(ALIENKIND_DIR, scriptPath)
      : scriptPath;
    const fp = getErrorFingerprint(errorMsg);
    let priorContext = '';
    try {
      priorContext = buildPriorContext(fp, jobName);
      if (priorContext) {
        log('INFO', `[self-heal] Found prior investigation history for ${jobName} (fingerprint: ${fp.slice(0, 50)})`);
      }
    } catch (histErr) {
      log('WARN', `[self-heal] Failed to load prior history: ${(histErr as Error).message}`);
    }
    const prompt = buildDiagnosticPrompt(jobName, errorMsg, fullScriptPath, logTail, gitLog, gitDiff, groundingContext, priorContext);

    // Step 3.5: Auth short-circuit — if error IS auth, skip Claude diagnostic entirely
    if (isAuthError(errorMsg)) {
      log('INFO', `[self-heal] Auth error detected for ${jobName} — skipping Claude diagnostic, running direct self-heal`);
      const healResult = await attemptSelfHeal(errorMsg, log);
      const summary = healResult.healed
        ? `HEALED: Auth recovered — ${healResult.diagnosis?.split('\n').pop() || 'transient'}`
        : `Auth failure. Diagnosis:\n${healResult.diagnosis || 'Both accounts need /login.'}`;
      if (sendAlert) {
        sendAlert(`🔧 Self-heal (${jobName}): ${summary.slice(0, 500)}`);
      }
      return { status: healResult.healed ? 'fixed' : 'failed', summary };
    }

    // Step 4: Route through consciousness engine for diagnostic session
    log('INFO', `[self-heal] Spawning diagnostic session for ${jobName}`);
    const result = await processMessage(prompt, {
      channelConfig: CHANNELS.self_heal,
      log: (level: string, msg: string) => log(level, `[self-heal:engine] ${msg}`),
      sender: 'system',
      senderDisplayName: `Self-Heal (${jobName})`,
      maxTurns: SELF_HEAL.maxDiagnosticTurns,
      outputFormat: 'text',
      noOutputTimeout: SELF_HEAL.noOutputTimeout,
      recentMessageCount: 0,
    });

    const responseText = result.text || '';
    const parsed = parseResult(responseText);

    // If diagnostic session returned empty/useless output, write partial file
    if (parsed.status === 'failed' && parsed.summary === 'No response from diagnostic session') {
      const partialFile = writePartialDiagnostics(jobName, {
        errorMsg,
        partialResponse: responseText || undefined,
        exitInfo: 'session returned empty response (possible silent timeout)',
        logTail,
      }, log);
      if (partialFile) {
        parsed.summary = `No response from diagnostic session. Partial diagnostics: ${partialFile}`;
      }
    }

    log('INFO', `[self-heal] ${jobName}: ${parsed.status} — ${parsed.summary.slice(0, 200)}`);

    // Record diagnosis for root-cause dedup (in-memory)
    recentDiagnoses.set(fp, { ts: Date.now(), summary: parsed.summary });

    // Step 5: Handle outcome
    if (parsed.status === 'fixed') {
      // Verify the diff was small (code enforcement, not prompt willpower)
      try {
        const diffStat = execSync('git diff --stat HEAD~1', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
        const insertions = diffStat.match(/(\d+) insertion/);
        const deletions = diffStat.match(/(\d+) deletion/);
        const totalLines = (parseInt(insertions?.[1] || '0', 10)) + (parseInt(deletions?.[1] || '0', 10));
        if (totalLines > SELF_HEAL.maxDiffLines) {
          log('WARN', `[self-heal] Diff too large (${totalLines} lines > ${SELF_HEAL.maxDiffLines}) — reverting`);
          execSync('git reset --soft HEAD~1', { cwd: ALIENKIND_DIR, timeout: 5000 });
          parsed.status = 'propose';
          parsed.summary = `Fix identified but diff too large (${totalLines} lines). ${parsed.summary}`;
        }
      } catch {
        // Can't verify diff — trust it
      }

      if (parsed.status === 'fixed') {
        if (sendAlert) {
          sendAlert(`Fixed: ${jobName}\n${parsed.summary}`);
        }
        if (intentId) {
          await supabasePatch('intents', `id=eq.${intentId}`, {
            status: 'completed',
            execution_result: `Auto-healed: ${parsed.summary}`,
            executed_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    }

    if (parsed.status === 'propose') {
      // Notify [HUMAN] with findings. Intent creation handled by daemon caller.
      if (sendAlert) {
        sendAlert(`Investigated ${jobName}. Here's what I found:\n${parsed.summary.slice(0, 500)}\n\nI intend to fix this. Creating intent for your approval.`);
      }
      if (intentId) {
        await supabasePatch('intents', `id=eq.${intentId}`, {
          diagnosis: parsed.summary,
          proposed_action: parsed.summary,
        }).catch(() => {});
      }
    }

    if (parsed.status === 'failed') {
      if (sendAlert) {
        sendAlert(`Investigated ${jobName} but couldn't identify a fix:\n${parsed.summary.slice(0, 500)}\n\nNeeds manual investigation in terminal.`);
      }
    }

    // Record to persistent investigation history (survives daemon restart).
    // Placed AFTER outcome handling so status reflects any downgrades (e.g., fixed → proposed on large diff).
    try {
      let fixCommit: string | undefined;
      if (parsed.status === 'fixed') {
        try {
          fixCommit = execSync('git rev-parse --short HEAD', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 3000 }).trim();
        } catch {}
      }
      recordInvestigation({
        jobName,
        fingerprint: fp,
        errorMsg: errorMsg.slice(0, 500),
        timestamp: new Date().toISOString(),
        outcome: parsed.status as 'fixed' | 'proposed' | 'failed',
        summary: parsed.summary.slice(0, 1000),
        durationMs: Date.now() - (recentInvestigations.get(jobName) || Date.now()),
        fixCommit,
      });
    } catch (histErr) {
      log('WARN', `[self-heal] Failed to record investigation history: ${(histErr as Error).message}`);
    }

    return parsed;
  } catch (err) {
    // Capture partial stderr from invokeKeel timeout/kill rejections
    const partialStderr = (err as any).stderr || '';
    const partialFile = writePartialDiagnostics(jobName, {
      errorMsg,
      partialStderr: partialStderr || undefined,
      exitInfo: err.message,
      logTail,
    }, log);
    const partialRef = partialFile ? ` Partial diagnostics: ${partialFile}` : '';

    log('ERROR', `[self-heal] Investigation crashed: ${err.message}${partialRef}`);
    if (sendAlert) {
      sendAlert(`Self-heal investigation for ${jobName} crashed: ${err.message.slice(0, 200)}${partialRef}`);
    }
    return { status: 'failed', summary: `Investigation error: ${err.message}${partialRef}` };
  } finally {
    releaseHealLock();
  }
}

module.exports = { investigate, buildDiagnosticPrompt, parseResult, acquireHealLock, releaseHealLock, getGroundingContext, writePartialDiagnostics };
