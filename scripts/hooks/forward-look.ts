#!/usr/bin/env node

/**
 * Forward Look — PostToolUse hook for Bash (fires after git commit).
 *
 * The "three-move rule." After a successful commit, reads the diff and
 * commit message to identify downstream implications that may be incomplete.
 *
 * Three checks:
 *   1. INTENT COMPLETION — does the codebase reflect the full intent of the commit?
 *      (e.g., renamed a module but old name still referenced elsewhere)
 *   2. CAPABILITY PROPAGATION — if a new capability was built, is it in harness.md?
 *      Is it discoverable? Are reasoning defaults updated?
 *   3. DOWNSTREAM IMPLICATIONS — what are 2-3 things that logically follow from this
 *      change that might not be done yet?
 *
 * Uses local model (vLLM-MLX) for analysis — zero Opus compute cost.
 * Advisory output (warnings, not blocks). The intent-audit nightly job is the
 * enforcement layer; this is the real-time awareness layer.
 *
 * Fires on: PostToolUse (Bash) — only when command is a git commit
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const ALIENKIND_DIR = resolveRepoRoot();
const VLLM_PORT = 8000;
const VLLM_MODEL = 'mlx-community/Qwen3.5-27B-4bit';
const TIMEOUT_MS = 15000; // 15 second cap — don't block the developer

// --- Local model inference (zero Opus cost) ---

function localInfer(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), TIMEOUT_MS);
    const body = JSON.stringify({
      model: VLLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: VLLM_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res: any) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch { resolve(''); }
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(''); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(''); });
    req.write(body);
    req.end();
  });
}

// --- Main ---

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData: any;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  // Only fire on Bash tool
  if (hookData.tool_name !== 'Bash') process.exit(0);

  // Only fire on actual git commits (not echo/grep containing "git commit")
  const command = hookData.tool_input?.command || '';
  const toolResult = hookData.tool_result;
  const output = typeof toolResult === 'string' ? toolResult
    : (toolResult?.stdout || toolResult?.output || toolResult?.content || '');

  const isActualCommit = /^\s*git\s+commit\b|&&\s*git\s+commit\b/m.test(command);
  if (!isActualCommit) process.exit(0);

  // PostToolUse doesn't pass tool_result — check git directly for recent commit
  let diff = '';
  let commitMsg = '';
  try {
    commitMsg = execSync('git log -1 --format=%B', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }).trim();
    // Verify the commit is fresh (within last 30 seconds)
    const commitTime = execSync('git log -1 --format=%ct', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }).trim();
    if (Math.abs(Date.now() / 1000 - parseInt(commitTime)) > 30) process.exit(0);
    diff = execSync('git diff HEAD~1 --stat', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
  } catch { process.exit(0); }

  // Get the actual changes for key files (not just stat)
  let diffContent = '';
  try {
    diffContent = execSync('git diff HEAD~1 --name-only', { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 });
  } catch { process.exit(0); }

  const changedFiles = diffContent.trim().split('\n').filter(Boolean);

  // --- Check 1: Capability Propagation (deterministic — no LLM needed) ---
  const newScripts = changedFiles.filter(f =>
    f.startsWith('scripts/') && !f.startsWith('scripts/tests/') && !f.startsWith('scripts/hooks/')
    && f.endsWith('.ts') && !changedFiles.includes('identity/harness.md')
  );
  const isNewCapability = commitMsg.toLowerCase().includes('feat:') || commitMsg.toLowerCase().includes('feat(');
  const harnessUpdated = changedFiles.includes('identity/harness.md');

  let warnings: string[] = [];

  if (isNewCapability && newScripts.length > 0 && !harnessUpdated) {
    warnings.push(`CAPABILITY PROPAGATION — New feature committed but identity/harness.md not updated.`);
    warnings.push(`  New scripts: ${newScripts.join(', ')}`);
    warnings.push(`  Is this capability discoverable in future sessions?`);
    warnings.push(`  Update harness.md with: tool name, usage, purpose.`);
  }

  // --- Check 2: Intent Completion (grep-based — fast, deterministic) ---
  // Look for common incomplete-migration patterns
  if (commitMsg.toLowerCase().includes('migrat') || commitMsg.toLowerCase().includes('replac') || commitMsg.toLowerCase().includes('renam')) {
    // Check for stale references to old names in the diff
    // Extract potential "old thing" from commit message
    const migrationPatterns = [
      { old: '11434', new: '8000', check: /11434/ },
      { old: 'NVIDIA-Nemotron', new: 'Qwen3.5-27B', check: /NVIDIA-Nemotron/ },
    ];

    for (const pat of migrationPatterns) {
      if (commitMsg.toLowerCase().includes(pat.old) || commitMsg.toLowerCase().includes(pat.new.toLowerCase())) {
        try {
          const grepResult = execSync(
            `grep -rl "${pat.old}" scripts/ config/ --include="*.ts" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v ".git" | head -5`,
            { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }
          ).trim();
          if (grepResult) {
            warnings.push(`INTENT COMPLETION — Commit mentions "${pat.old}" migration but stale references remain:`);
            for (const file of grepResult.split('\n').slice(0, 5)) {
              warnings.push(`  → ${file}`);
            }
          }
        } catch { /* grep found nothing — good */ }
      }
    }
  }

  // --- Check 3: REMOVED 2026-04-10 ---
  //
  // Was: synchronous 27B LLM call ("forward look analysis") with 15s
  // timeout, asking the model to imagine 1-3 incomplete things from the
  // diff. Under load (working groups, consciousness, classifier all
  // sharing the 27B on port 8000), this call routinely took 30+ seconds
  // and was the root cause of 7-minute commits. Worse, the output could
  // be hallucinated and the warnings table fed into read-guard as
  // blocking state, meaning a 27B hallucination could block subsequent
  // edits.
  //
  // Decision: the speculative LLM layer is not worth the latency cost.
  // The three deterministic checks above (capability propagation,
  // intent completion, env var activation) catch the specific
  // high-value patterns with zero LLM cost. Deeper analysis runs in
  // nightly-analysis.ts where blocking is not a concern.
  //
  // If we want fast post-commit intelligence in the future, spawn it
  // async via detached child process that writes findings to circulation
  // for the working groups to review — never block the commit.

  // --- Check 4: ENV VAR ACTIVATION — new env var references need external deployment ---
  // If the diff introduces new process.env.SOMETHING references, warn that the
  // env var needs to be set in the deployment environment (Vercel, .env, etc.)
  // This catches a common deploy failure: feature built but env var never set.
  try {
    const addedLines = execSync('git diff HEAD~1 -U0 -- "*.ts" 2>/dev/null', {
      cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000,
    });
    const removedLines = execSync('git diff HEAD~1 -U0 -- "*.ts" 2>/dev/null', {
      cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000,
    });

    // Extract env var names from added lines only
    const addedEnvVars = new Set<string>();
    const removedEnvVars = new Set<string>();
    for (const line of addedLines.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const matches = line.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g);
        for (const m of matches) addedEnvVars.add(m[1]);
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        const matches = line.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g);
        for (const m of matches) removedEnvVars.add(m[1]);
      }
    }

    // New env vars = added but not removed (not just moved/renamed)
    const newEnvVars = Array.from(addedEnvVars).filter(v => !removedEnvVars.has(v));

    // Filter out known env vars that are already in .env
    if (newEnvVars.length > 0) {
      let knownVars = new Set<string>();
      try {
        const envContent = fs.readFileSync(path.join(ALIENKIND_DIR, '.env'), 'utf8');
        for (const line of envContent.split('\n')) {
          const key = line.split('=')[0]?.trim();
          if (key && !key.startsWith('#')) knownVars.add(key);
        }
      } catch { /* .env not readable */ }

      const unknownEnvVars = newEnvVars.filter(v => !knownVars.has(v));
      if (unknownEnvVars.length > 0) {
        warnings.push(`ENV VAR ACTIVATION — New env var(s) referenced but not in .env:`);
        for (const v of unknownEnvVars) {
          warnings.push(`  → ${v}`);
        }
        warnings.push(`  Set in deployment environment (Vercel, .env, etc.) or this feature won't activate.`);
      }
    }
  } catch { /* env var check is best-effort */ }

  // --- Write issues to tracking file so read-guard can enforce ---
  if (warnings.length > 0) {
    try {
      const sessionId = hookData.session_id || process.ppid || 'unknown';
      const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;
      let tracking: any = {};
      try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
      tracking.forwardLookIssues = warnings;
      tracking.forwardLookCommit = commitMsg.slice(0, 100);
      fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
    } catch { /* never block on tracking write failure */ }

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  THREE-MOVE RULE — Forward Look                             ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const w of warnings) {
      const line = w.length > 58 ? w.slice(0, 55) + '...' : w;
      console.log(`║  ${line.padEnd(60)}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  BLOCKING — address these before editing more files.        ║');
    console.log('║  Fix the issues, or: npx tsx -e "forward-look clear"        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  } else {
    // Clean — clear any prior forward-look issues
    try {
      const sessionId = hookData.session_id || process.ppid || 'unknown';
      const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;
      let tracking: any = {};
      try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
      if (tracking.forwardLookIssues) {
        delete tracking.forwardLookIssues;
        delete tracking.forwardLookCommit;
        fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
      }
    } catch {}
  }

  // --- Auto-log decision from commit message (tier 1 enforcement) ---
  // Every commit IS a decision. Extract the first line as the "what".
  // Tier 1: code enforcement. No prompt instruction. No voluntary compliance.
  //
  // Fire-and-forget async: spawn a detached curl so the hook exits
  // immediately. Previously used synchronous execSync with 3s timeout,
  // which added latency on every commit. The Supabase write is best-
  // effort — losing a single decision log is acceptable, losing the
  // developer's time to a blocking network call is not.
  try {
    const { loadEnv } = require('../lib/keel-env.ts');
    try { Object.assign(process.env, loadEnv()); } catch {}
    const firstLine = commitMsg.split('\n')[0].trim();
    if (firstLine && firstLine.length > 5 && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const { spawn } = require('child_process');
      const body = JSON.stringify({ what: firstLine, terminal_id: process.env.ALIENKIND_TERMINAL_ID || 'unknown', open: false });
      const child = spawn('curl', [
        '-s', '--max-time', '5',
        '-X', 'POST',
        `${process.env.SUPABASE_URL}/rest/v1/decisions`,
        '-H', `apikey: ${process.env.SUPABASE_SERVICE_KEY}`,
        '-H', `Authorization: Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        '-H', 'Content-Type: application/json',
        '-d', body,
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch {}

  process.exit(0);
}

main().catch(() => process.exit(0));
