#!/usr/bin/env node

/**
 * Uncommitted Delta — Stop hook.
 *
 * Warns when code changes exist that aren't documented in session-state.md
 * or today's daily memory file. Advisory only — not a blocker.
 *
 * Throttled: fires every 5th response per session to avoid noise.
 *
 * Fires on: Stop event (every assistant response)
 * Output: warning listing undocumented code files (if any)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KEEL_DIR = path.resolve(__dirname, '../..');
const CODE_DIRS = ['scripts/', 'config/', '.claude/'];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData: any;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const counterFile = `/tmp/keel-uncommitted-delta-${sessionId}`;

  // Throttle: fire every 5th response
  let count = 0;
  try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  count++;
  fs.writeFileSync(counterFile, String(count));

  if (count % 5 !== 0) {
    process.exit(0);
  }

  // Get modified code files from git
  let modifiedFiles: string[] = [];
  try {
    const diffOutput = execSync('git diff --name-only', {
      cwd: KEEL_DIR,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    if (!diffOutput) {
      process.exit(0);
    }

    modifiedFiles = diffOutput
      .split('\n')
      .filter((f: string) => CODE_DIRS.some(dir => f.startsWith(dir)));
  } catch {
    process.exit(0);
  }

  if (modifiedFiles.length === 0) {
    process.exit(0);
  }

  // Read memory files
  const today = new Date().toISOString().split('T')[0];
  const dailyFile = path.join(KEEL_DIR, `memory/daily/${today}.md`);
  const sessionFile = path.join(KEEL_DIR, 'memory/daily/');

  let memoryContent = '';
  try { memoryContent += fs.readFileSync(sessionFile, 'utf8'); } catch {}
  try { memoryContent += '\n' + fs.readFileSync(dailyFile, 'utf8'); } catch {}

  // Check which modified files are mentioned in memory
  const undocumented = modifiedFiles.filter((f: string) => {
    const basename = path.basename(f);
    const dirname = path.basename(path.dirname(f));
    // Check for filename or directory/filename mention
    return !memoryContent.includes(basename) && !memoryContent.includes(f);
  });

  if (undocumented.length === 0) {
    process.exit(0);
  }

  console.log(
    `UNCOMMITTED DELTA — ${undocumented.length} modified code file(s) not mentioned in daily memory:\n` +
    undocumented.map((f: string) => `  • ${f}`).join('\n') +
    '\nConsider documenting these changes before the session ends.'
  );

  process.exit(0);
}

main().catch(() => process.exit(0));
