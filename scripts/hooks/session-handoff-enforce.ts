#!/usr/bin/env node
/**
 * session-handoff-enforce.ts — Stop hook. Forcing function for daily
 * memory flush.
 *
 * Closes the bench gap surfaced by @T33R0 (Rory) and Conn in 2026-04-20
 * task S01/S02: Kael wrote 8 bench answer files but never flushed to
 * today's daily, so a fresh instance had no architectural reason to
 * know the bench happened. Conn has an explicit conn_session_handoff
 * table queried at boot as guaranteed step 3a; AlienKind relied on an
 * implicit daily-memory flush that's easy to skip.
 *
 * Mechanism: at session Stop, if the session modified code AND the
 * daily file has no breadcrumb for this terminal yet, auto-append a
 * minimal handoff entry (files touched, verification state, commit hash
 * if any). Idempotent — re-running on the same terminal/day no-ops.
 *
 * Not a block — the session is already ending. This is auto-fill so
 * the breadcrumb is guaranteed to exist regardless of whether the
 * partner remembered to flush.
 *
 * Fires on: Stop event.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const terminalId = process.env.ALIENKIND_TERMINAL_ID || sessionId.slice(0, 12);

  // Read build-cycle tracking
  const trackFile = `/tmp/alienkind-build-cycle-${terminalId}.json`;
  let tracking: any = {};
  try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {
    // No tracking = no session work recorded = nothing to flush
    process.exit(0);
  }

  const codeFiles: string[] = tracking.codeFiles || [];
  const filesRead: string[] = tracking.filesRead || [];
  const verify = tracking.verifyEvidence || {};

  // No meaningful work this session — skip
  if (codeFiles.length === 0 && filesRead.length < 5) process.exit(0);

  // Today's daily file
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dailyPath = path.join(ALIENKIND_DIR, 'memory', 'daily', `${yyyy}-${mm}-${dd}.md`);

  // Idempotent: only append if this terminal hasn't been flushed yet today
  const marker = `## Session ${terminalId} auto-handoff`;
  try {
    if (fs.existsSync(dailyPath) && fs.readFileSync(dailyPath, 'utf8').includes(marker)) {
      process.exit(0);
    }
  } catch { /* file may not exist yet — fine */ }

  // Optional: last commit on current branch (if any)
  let lastCommit = '';
  try {
    lastCommit = execSync(`git -C "${ALIENKIND_DIR}" log -1 --format="%h %s" 2>/dev/null`, {
      encoding: 'utf8', timeout: 2000,
    }).trim();
  } catch { /* git unavailable — skip */ }

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [
    '',
    marker + ` [${hhmm}]`,
    `Files touched: ${codeFiles.length > 0 ? codeFiles.join(', ') : '(read-only session)'}`,
    `Verification: syntax=${verify.syntax ? 'PASSED' : 'NOT_RUN'} test=${verify.test ? 'PASSED' : 'NOT_RUN'}`,
  ];
  if (lastCommit) lines.push(`Last commit: ${lastCommit}`);

  try {
    fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
    fs.appendFileSync(dailyPath, lines.join('\n') + '\n');
  } catch {
    // best-effort — never block Stop on daily append failure
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
