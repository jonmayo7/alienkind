#!/usr/bin/env node

/**
 * Boot Verify — Stop hook.
 *
 * Verifies that critical boot files were read in the first few responses
 * of a session. Catches sessions that start identity-blind (never reading
 * today's daily file).
 *
 * Different from post-compaction-audit.ts which only fires AFTER compaction.
 * This fires during normal boot — catches the case where CLAUDE.md says
 * "read daily file at boot" but no code enforces it.
 *
 * Fires on: Stop event
 * Active window: responses 3-6 only (after boot, before normal work)
 * Output: advisory warning if critical files not yet read
 * Cost: <5ms (file stat + JSON parse)
 */

const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const counterFile = `/tmp/alienkind-boot-verify-${sessionId}`;
  const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;

  // Count responses
  let count = 0;
  try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
  count++;
  fs.writeFileSync(counterFile, String(count));

  // Only check during responses 3-6 (give boot sequence time to complete)
  if (count < 3 || count > 6) process.exit(0);

  // Read tracking data from track-read.ts
  let tracking = { filesRead: [] as string[] };
  try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch { process.exit(0); }
  const filesRead: string[] = tracking.filesRead || [];

  const today = new Date().toISOString().split('T')[0];
  const dailyFilePattern = `memory/daily/${today}.md`;

  const missing: string[] = [];

  // Check daily file
  if (!filesRead.some((f: string) => f.includes(dailyFilePattern))) {
    missing.push(`memory/daily/${today}.md (today's daily file)`);
  }

  // Check today's daily file (live state — replaces stale session-state.md)
  if (!filesRead.some((f: string) => f.includes(`daily/${today}.md`))) {
    missing.push(`memory/daily/${today}.md (today)`);
  }

  // Check harness.md (tool registry — prevents MCP reaching)
  if (!filesRead.some((f: string) => f.includes('harness.md'))) {
    missing.push('identity/harness.md (tool registry)');
  }

  if (missing.length > 0 && count === 3) {
    // First warning at response 3
    console.log(
      `BOOT VERIFY — Critical boot files not yet read:\n` +
      missing.map((f: string) => `  • ${f}`).join('\n') +
      '\nCLAUDE.md boot sequence requires these. Read them now for full context.'
    );
  } else if (missing.length > 0 && count === 5) {
    // Escalated warning at response 5
    console.log(
      `BOOT VERIFY — WARNING: Response #${count} and still missing boot files:\n` +
      missing.map((f: string) => `  • ${f}`).join('\n') +
      '\nYou are operating without today\'s context. This WILL cause duplicate work or missed decisions.'
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
