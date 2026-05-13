#!/usr/bin/env npx tsx

/**
 * AlienKind Doctor — diagnose your partnership stack.
 *
 * Usage:
 *   npm run doctor          — report only (default)
 *   npm run doctor -- --fix — install missing requirements (with consent)
 *
 * What it checks:
 *   - Required: Node ≥20, git
 *   - Optional: Claude Code CLI, psql (Postgres client)
 *
 * Each missing item shows the exact install command for your OS before running.
 */

import { runPreflight, detectOS } from '../lib/preflight';

const fix = process.argv.includes('--fix') || process.argv.includes('-f');

async function main() {
  const os = detectOS();
  console.log('');
  console.log(`  \x1b[1m\x1b[35m👽 AlienKind Doctor\x1b[0m`);
  console.log(`  \x1b[2mPlatform: ${os.platform} (${os.family}) · Package manager: ${os.manager}${os.managerInstalled ? '' : ' [missing]'}\x1b[0m`);
  console.log('');

  const { ok, results } = await runPreflight(fix ? 'fix' : 'report');

  const requiredMissing = results.filter((r) => r.required && !r.ok);
  const optionalMissing = results.filter((r) => !r.required && !r.ok);

  if (requiredMissing.length === 0 && optionalMissing.length === 0) {
    console.log('  \x1b[32m✓ All requirements met. You\'re ready.\x1b[0m\n');
    process.exit(0);
  }

  if (requiredMissing.length > 0) {
    console.log(`  \x1b[31mMissing required:\x1b[0m ${requiredMissing.map((r) => r.name).join(', ')}`);
    if (!fix) console.log(`  \x1b[2mRun \x1b[36mnpm run doctor -- --fix\x1b[0m\x1b[2m to install.\x1b[0m`);
  }
  if (optionalMissing.length > 0) {
    console.log(`  \x1b[33mMissing optional:\x1b[0m ${optionalMissing.map((r) => r.name).join(', ')}`);
    if (!fix) console.log(`  \x1b[2m(Optional — AlienKind works without these, but features may be limited.)\x1b[0m`);
  }
  console.log('');

  process.exit(ok ? 0 : 1);
}

main().catch((err: any) => {
  console.error(`\n  \x1b[31m✗\x1b[0m Doctor failed: ${err.message}\n`);
  process.exit(1);
});
