#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * ledger-recall — surface accumulated learning-ledger patterns from a session.
 *
 * Closes the write-only gap surfaced by @T33R0 (Rory) and Conn in the
 * 2026-04-20 bench task S03: the ledger writes corrections but a partner
 * working inside a session has no path to read them back. Without this,
 * corrections accumulate and never feed runtime behavior.
 *
 * Usage:
 *   npx tsx scripts/tools/ledger-recall.ts --recent [N]
 *   npx tsx scripts/tools/ledger-recall.ts --frequent [N]
 *   npx tsx scripts/tools/ledger-recall.ts --search <query>
 *   npx tsx scripts/tools/ledger-recall.ts --stale [days]
 *
 * Without Supabase configured, returns an empty list and exits 0. The
 * capability scorecard already reports this via learning-ledger's own
 * registerUnavailable. Not a CLI-level concern.
 */

const {
  getRecentLearnings,
  getFrequentPatterns,
  searchLearnings,
  getStaleLearnings,
} = require('../lib/learning-ledger.ts');

function formatEntry(e: any): string {
  const pattern = e.pattern_name || e.pattern || '(unnamed)';
  const count = e.occurrence_count !== undefined ? ` ×${e.occurrence_count}` : '';
  const sev = e.severity !== undefined ? ` sev=${e.severity}` : '';
  const when = e.last_seen_at || e.created_at || '';
  const snippet = (e.correction_text || e.content || '').slice(0, 120).replace(/\n/g, ' ');
  return `- ${pattern}${count}${sev} ${when ? '[' + when.slice(0, 10) + ']' : ''}\n    ${snippet}`;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const n = parseInt(args[1], 10);
    return Number.isFinite(n) ? n : 10;
  })();

  if (args.includes('--recent')) {
    const rows = await getRecentLearnings({ limit });
    console.log(`Recent learnings (${rows.length}):\n`);
    rows.forEach((r: any) => console.log(formatEntry(r)));
    return;
  }
  if (args.includes('--frequent')) {
    const rows = await getFrequentPatterns({ limit });
    console.log(`Most frequent patterns (${rows.length}):\n`);
    rows.forEach((r: any) => console.log(formatEntry(r)));
    return;
  }
  if (args.includes('--search')) {
    const qIdx = args.indexOf('--search');
    const query = args[qIdx + 1];
    if (!query) {
      console.error('Usage: --search <query>');
      process.exit(1);
    }
    const rows = await searchLearnings(query, { limit });
    console.log(`Search "${query}" (${rows.length}):\n`);
    rows.forEach((r: any) => console.log(formatEntry(r)));
    return;
  }
  if (args.includes('--stale')) {
    const days = parseInt(args[args.indexOf('--stale') + 1], 10) || 60;
    const rows = await getStaleLearnings({ days, limit });
    console.log(`Stale (${days}d+, ${rows.length}):\n`);
    rows.forEach((r: any) => console.log(formatEntry(r)));
    return;
  }

  console.log(
    'ledger-recall — surface learning-ledger entries from a session.\n\n' +
    'Subcommands:\n' +
    '  --recent [N]      most recent N (default 10)\n' +
    '  --frequent [N]    top-N by occurrence_count\n' +
    '  --search <query>  full-text search\n' +
    '  --stale [days]    corrections not seen in N days (default 60)\n',
  );
}

main().catch((err) => {
  console.error('ledger-recall failed:', err.message);
  process.exit(1);
});
