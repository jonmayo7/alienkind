#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * recall-rate — report the rolling memory-recall rate.
 *
 * Usage:
 *   npx tsx scripts/tools/recall-rate.ts            # 7-day window
 *   npx tsx scripts/tools/recall-rate.ts --hours 24 # 24-hour window
 *   npx tsx scripts/tools/recall-rate.ts --snapshot # write today's row to history
 *
 * Reports surfaced / cited / rate over the window. Baseline is whatever
 * your instance actually produces — the point is trending, not absolute
 * comparison. Partners are expected to improve this rate over time as
 * the memory layer learns what's worth surfacing.
 */

const { getRecallRate, snapshotRecallRate } = require('../lib/memory-recall.ts');

async function main() {
  const args = process.argv.slice(2);
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1], 10) : 24 * 7;
  const snap = args.includes('--snapshot');

  const result = snap ? await snapshotRecallRate(hours) : await getRecallRate(hours);

  const pct = (result.rate * 100).toFixed(2);
  const label = snap ? ' (snapshot saved)' : '';
  console.log(`Recall rate [${result.window_hours}h]${label}: ${pct}%`);
  console.log(`  surfaced: ${result.surfaced}`);
  console.log(`  cited:    ${result.cited}`);
  console.log(`  sample:   ${result.sample_size} events`);
}

main().catch((err) => {
  console.error('recall-rate failed:', err.message);
  process.exit(1);
});
