#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * memory-search — CLI for retrieving from the partner's memory corpus.
 *
 * Uses hybrid retrieval (pgvector + FTS + local embeddings) when the full
 * stack is wired. Falls back to TF-IDF over memory/ files on fresh clones
 * with no Supabase. Either way, the call shape is the same and partners
 * can reach for memory-search as a first-reach instead of filesystem Grep.
 *
 * Closes the retrieval-fallback gap surfaced by the 2026-04-20 bench
 * (task S08): without Supabase + embeddings, the partner defaulted to
 * `Grep` over `**\/*.{ts,md,sh}` because memory-search wasn't a natural
 * first-reach. A CLI + a ranked local fallback makes it one.
 *
 * Usage:
 *   npx tsx scripts/tools/memory-search.ts 'circulation pump'
 *   npx tsx scripts/tools/memory-search.ts 'nightly immune' --limit 5
 *   npx tsx scripts/tools/memory-search.ts 'pattern' --type daily
 *   npx tsx scripts/tools/memory-search.ts 'pattern' --json
 *
 * Flags:
 *   --limit N       top-K results (default 10)
 *   --type T        filter by file_type (daily|synthesis|build_log|memory)
 *   --json          machine-readable output
 */

const { searchMemory } = require('../lib/memory-search.ts');

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 10;
  const typeIdx = args.indexOf('--type');
  const fileTypes = typeIdx >= 0 && args[typeIdx + 1] ? [args[typeIdx + 1]] : undefined;

  // Query = tokens that aren't flags or flag-values
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' || a === '--type') { i++; continue; }
    if (a === '--json') continue;
    queryParts.push(a);
  }
  const query = queryParts.join(' ').trim();

  if (!query) {
    console.error('Usage: memory-search <query> [--limit N] [--type daily|synthesis|build_log|memory] [--json]');
    process.exit(1);
  }

  const results = await searchMemory(query, { fileTypes, limit });

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No matches for: "${query}"`);
    return;
  }

  console.log(`${results.length} match(es) for: "${query}"`);
  console.log('');
  for (const r of results) {
    const dateStr = r.file_date ? ` [${r.file_date}]` : '';
    console.log(`${r.source_file}${dateStr}`);
    if (r.heading) console.log(`  # ${r.heading}`);
    const snippet = (r.content || '').slice(0, 250).replace(/\s+/g, ' ').trim();
    console.log(`  ${snippet}`);
    console.log('');
  }
}

main().catch(err => {
  console.error('memory-search failed:', err.message);
  process.exit(1);
});
