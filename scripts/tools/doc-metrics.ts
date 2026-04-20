#!/usr/bin/env npx tsx

/**
 * doc-metrics — keep published numbers in sync with disk.
 *
 * Prose drifts. Code doesn't. This script reads the repo, computes the
 * numbers that appear in README / HYPOTHESIS / ATTRIBUTION / plugin.json /
 * SKILL.md, and rewrites them to match what's actually on disk.
 *
 * Usage:
 *   npx tsx scripts/tools/doc-metrics.ts            # rewrite in place
 *   npx tsx scripts/tools/doc-metrics.ts --check    # exit 1 if drift found
 *
 * Markdown files use inline HTML-comment markers:
 *   <!-- doc-metric:hook-count -->53<!-- /doc-metric:hook-count -->
 *
 * JSON / other files use explicit regex patterns declared below.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function countMatching(dir: string, re: RegExp): number {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return 0;
  return fs.readdirSync(abs).filter((n: string) => re.test(n)).length;
}

const METRICS: Record<string, number> = {
  'hook-count': countMatching('scripts/hooks', /\.(ts|sh)$/),
  'hook-count-ts': countMatching('scripts/hooks', /\.ts$/),
  'migration-count': countMatching('migrations', /\.sql$/),
  'test-count': countMatching('tests', /^test-.*\.ts$/),
  'lifecycle-events': 6,
};

type JsonTarget = {
  file: string;
  pattern: RegExp;
  render: () => string;
};

const MARKDOWN_TARGETS = [
  'README.md',
  'HYPOTHESIS.md',
  'ATTRIBUTION.md',
  'skills/alienkind/SKILL.md',
];

const PATTERN_TARGETS: JsonTarget[] = [
  {
    file: '.claude-plugin/plugin.json',
    pattern: /(\d+) behavioral enforcement hooks/,
    render: () => `${METRICS['hook-count']} behavioral enforcement hooks`,
  },
];

function rewriteMarkers(content: string): { content: string; changed: boolean } {
  let changed = false;
  const out = content.replace(
    /<!-- doc-metric:([a-z-]+) -->([^<]*)<!-- \/doc-metric:\1 -->/g,
    (_whole: string, name: string, current: string) => {
      const v = METRICS[name];
      if (v === undefined) {
        throw new Error(`doc-metrics: unknown metric "${name}"`);
      }
      const replacement = `<!-- doc-metric:${name} -->${v}<!-- /doc-metric:${name} -->`;
      if (current !== String(v)) changed = true;
      return replacement;
    },
  );
  return { content: out, changed };
}

function rewritePattern(content: string, target: JsonTarget): { content: string; changed: boolean } {
  const m = content.match(target.pattern);
  if (!m) return { content, changed: false };
  const replacement = target.render();
  if (m[0] === replacement) return { content, changed: false };
  return { content: content.replace(target.pattern, replacement), changed: true };
}

const checkOnly = process.argv.includes('--check');
const driftFiles: string[] = [];
let wrote = 0;

for (const rel of MARKDOWN_TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const orig = fs.readFileSync(abs, 'utf8');
  const { content, changed } = rewriteMarkers(orig);
  if (changed) {
    driftFiles.push(rel);
    if (!checkOnly) {
      fs.writeFileSync(abs, content);
      wrote++;
    }
  }
}

for (const target of PATTERN_TARGETS) {
  const abs = path.join(ROOT, target.file);
  if (!fs.existsSync(abs)) continue;
  const orig = fs.readFileSync(abs, 'utf8');
  const { content, changed } = rewritePattern(orig, target);
  if (changed) {
    driftFiles.push(target.file);
    if (!checkOnly) {
      fs.writeFileSync(abs, content);
      wrote++;
    }
  }
}

if (checkOnly) {
  if (driftFiles.length > 0) {
    console.error(`doc-metrics drift detected in ${driftFiles.length} file(s):`);
    driftFiles.forEach((f) => console.error(`  ${f}`));
    console.error(`\nFix: npx tsx scripts/tools/doc-metrics.ts`);
    process.exit(1);
  }
  console.log(`doc-metrics: clean (${Object.keys(METRICS).length} metrics tracked)`);
  process.exit(0);
}

console.log(`doc-metrics: ${JSON.stringify(METRICS)}`);
console.log(`doc-metrics: rewrote ${wrote} file(s)${wrote > 0 ? ':\n  ' + driftFiles.join('\n  ') : ''}`);
process.exit(0);
