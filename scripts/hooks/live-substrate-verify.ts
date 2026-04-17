#!/usr/bin/env node
/**
 * Live Substrate Verification Hook — Phase 5.2.5 Step B
 *
 * PostToolUse on Edit|Write. When a file that declares model IDs or
 * substrate endpoints is edited, fires a real HTTP call against each
 * declared (port, model) pair to verify the live substrate still serves
 * what the file says it should.
 *
 * The 9B silent-break class of bug:
 *   1. Code updates a model ID (e.g., Qwen3.5-7B → Qwen3.5-9B)
 *   2. No one runs a live call after the change
 *   3. The running mlx_lm server on that port still serves the OLD model
 *   4. Classifier calls silently fall through to fallback values for hours
 *   5. Someone finally notices at 3 AM because a gate was misbehaving
 *
 * This hook catches that at edit time: the moment you save the file,
 * we ping the live substrate and compare what the code declares vs
 * what the server actually serves. Non-blocking — warnings go to
 * stderr as advisory so you see them immediately but can still proceed
 * if the mismatch is intentional.
 *
 * Scope: only watches files that actually contain model IDs. Routine
 * edits (test files, memory files, docs) are no-ops — exits in <10ms
 * without any HTTP calls.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const ALIENKIND_DIR = resolveRepoRoot();

// Known substrate endpoints — map of "host:port" → label for friendly output.
// When the file being edited contains a port reference, we look up the
// endpoint here and check its /v1/models.
const SUBSTRATES: Record<string, { host: string; port: number; label: string }> = {
  '127.0.0.1:8000':   { host: '127.0.0.1', port: 8000, label: 'Studio 1 nginx' },
  '127.0.0.1:8001':   { host: '127.0.0.1', port: 8001, label: 'Studio 1 daily (27B)' },
  '127.0.0.1:8002':   { host: '127.0.0.1', port: 8002, label: 'Studio 1 vision' },
  '127.0.0.1:8004':   { host: '127.0.0.1', port: 8004, label: 'Studio 1 embedding' },
  '127.0.0.1:8005':   { host: '127.0.0.1', port: 8005, label: 'Studio 1 classifier' },
  '[LOCAL_HOST]:8001':    { host: '[LOCAL_HOST]',  port: 8001, label: 'Studio 2 daily (35B MoE)' },
  '[LOCAL_HOST]:8002':    { host: '[LOCAL_HOST]',  port: 8002, label: 'Studio 2 heavy (122B MoE)' },
  '[LOCAL_HOST]:8003':    { host: '[LOCAL_HOST]',  port: 8003, label: 'Studio 2 vision' },
  '[LOCAL_HOST]:8004':    { host: '[LOCAL_HOST]',  port: 8004, label: 'Studio 2 identity' },
  '[LOCAL_HOST]:8005':    { host: '[LOCAL_HOST]',  port: 8005, label: 'Studio 2 embedding' },
};

// Files that are always worth checking when edited
const ALWAYS_WATCH = [
  'scripts/lib/models.ts',
  'scripts/lib/runtime.ts',
  'scripts/lib/local-inference.ts',
  'scripts/lib/local-vision.ts',
  'scripts/lib/substrate-policy.ts',
  'scripts/tools/local-classify.js',
];

// Regex to detect model ID strings
const MODEL_ID_RE = /mlx-community\/[A-Za-z0-9._-]+/g;

// Regex to detect port references (capture :PORT or port: PORT)
// Keep tight to avoid matching unrelated numbers
const PORT_RE = /(?::|\bport:\s*)(80\d\d)\b/g;

// Short timeout — if the substrate isn't reachable, we don't want to
// block the editor. 1.5s is enough for a healthy LAN ping.
const HTTP_TIMEOUT_MS = 1500;

function fetchModels(host: string, port: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), HTTP_TIMEOUT_MS);
    const req = http.request(
      { hostname: host, port, path: '/v1/models', method: 'GET', timeout: HTTP_TIMEOUT_MS },
      (res: any) => {
        let data = '';
        res.on('data', (c: string) => (data += c));
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.data || []).map((m: any) => m.id).filter(Boolean);
            resolve(models);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve(null);
    });
    req.end();
  });
}

function extractReferences(fileContent: string): { modelIds: Set<string>; ports: Set<number> } {
  const modelIds = new Set<string>();
  const ports = new Set<number>();

  // Only extract IDs from "active" lines — filter out dead/deprecated
  // registry entries (Keel convention: DEAD_*, DEPRECATED_*, status:
  // 'dead', // comments). This prevents false positives from models.ts
  // which intentionally records dead entries for cleanup tracking.
  // Using substring match (not word-boundary) because identifiers like
  // "DEPRECATED_QWEN25_7B" have an underscore right after the keyword
  // which breaks \b matching.
  const DEAD_MARKERS = /(dead|deprecated|stale|archived)/i;
  const lines = fileContent.split('\n');
  let inBlockComment = false;
  // Look BEHIND up to 3 lines and AHEAD up to 4 lines for a death
  // marker on either the identifier key (e.g. DEAD_NEMOTRON_SUPER),
  // a status field, or a note.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.trim().startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.trim().startsWith('//')) continue;

    // Check surrounding context for death markers (3 lines back, 4 forward)
    const contextStart = Math.max(0, i - 3);
    const contextEnd = Math.min(lines.length, i + 5);
    const context = lines.slice(contextStart, contextEnd).join('\n');
    if (DEAD_MARKERS.test(context)) continue;

    const modelMatches = line.match(MODEL_ID_RE) || [];
    for (const m of modelMatches) modelIds.add(m);
  }

  // Ports: same filtering
  PORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PORT_RE.exec(fileContent)) !== null) {
    const p = parseInt(m[1], 10);
    if (p >= 8000 && p < 8100) ports.add(p);
  }
  return { modelIds, ports };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let hookData: any;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Only fire on Edit/Write
  if (hookData.tool_name !== 'Edit' && hookData.tool_name !== 'Write') process.exit(0);

  const filePath: string = hookData.tool_input?.file_path || '';
  if (!filePath) process.exit(0);

  // Convert absolute path → repo-relative
  const relPath = filePath.startsWith(ALIENKIND_DIR) ? filePath.slice(ALIENKIND_DIR.length + 1) : filePath;

  // Scope: only check files that declare model IDs or ports. Fast exit
  // for routine edits (tests, memory, docs, daily files).
  const isWatchedByName = ALWAYS_WATCH.some((w) => relPath === w);
  const isPlist = relPath.endsWith('.plist');

  let fileContent = '';
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch {
    process.exit(0);
  }

  const hasModelId = MODEL_ID_RE.test(fileContent);
  MODEL_ID_RE.lastIndex = 0; // reset after test()
  const hasPortRef = /\b80\d\d\b/.test(fileContent);

  if (!isWatchedByName && !isPlist && !hasModelId) process.exit(0);

  // Extract declared references
  const { modelIds } = extractReferences(fileContent);
  if (modelIds.size === 0) process.exit(0);

  const warnings: string[] = [];

  // For each declared model ID in the file, check that it's served by
  // AT LEAST ONE live substrate. This is the 9B-silent-break check: if
  // the file claims a model ID that no running server actually serves,
  // calls to that model will silently fall through. We probe all known
  // substrates in parallel (1.5s timeout each) and collect the union of
  // currently-served model IDs.
  const substrateKeys = Object.keys(SUBSTRATES);
  const probes = substrateKeys.map(async (key) => {
    const sub = SUBSTRATES[key];
    const models = await fetchModels(sub.host, sub.port);
    return { key, label: sub.label, models };
  });
  const results = await Promise.all(probes);

  // Build the global set of currently-served model IDs (across all
  // reachable substrates) and a reachable-count for context.
  const liveModels = new Set<string>();
  let reachableCount = 0;
  for (const r of results) {
    if (r.models !== null) {
      reachableCount++;
      for (const m of r.models) liveModels.add(m);
    }
  }

  // If zero substrates were reachable, the check is inconclusive —
  // don't warn, just exit (avoid noise when the network is down).
  if (reachableCount === 0) process.exit(0);

  const declaredModels = Array.from(modelIds);
  for (const declaredModel of declaredModels) {
    // Match loosely: exact or short-name containment. Some substrates
    // may expose with slightly different prefixes.
    const shortName = declaredModel.split('/')[1] || declaredModel;
    const match = Array.from(liveModels).some(
      (lm: string) => lm === declaredModel || lm.includes(shortName)
    );
    if (!match) {
      warnings.push(`  → declared but NOT served anywhere: ${declaredModel}`);
      // Find the closest match for context
      const near = Array.from(liveModels).find((lm: string) => lm.includes(shortName.split('-')[0] || ''));
      if (near) warnings.push(`    closest live: ${near}`);
    }
  }

  if (warnings.length > 0) {
    warnings.push(`  (probed ${reachableCount}/${substrateKeys.length} substrates, ${liveModels.size} unique models live)`);
  }

  if (warnings.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('╔══════════════════════════════════════════════════════════════╗\n');
    process.stderr.write('║  LIVE SUBSTRATE VERIFY — model/port mismatch detected       ║\n');
    process.stderr.write('╠══════════════════════════════════════════════════════════════╣\n');
    process.stderr.write(`║  file: ${relPath.padEnd(54)}║\n`);
    for (const w of warnings.slice(0, 10)) {
      const line = w.length > 58 ? w.slice(0, 55) + '...' : w;
      process.stderr.write(`║${line.padEnd(62)}║\n`);
    }
    process.stderr.write('╠══════════════════════════════════════════════════════════════╣\n');
    process.stderr.write('║  Advisory only. Restart the relevant mlx_lm server or      ║\n');
    process.stderr.write('║  revert the model ID if this mismatch is unintentional.    ║\n');
    process.stderr.write('╚══════════════════════════════════════════════════════════════╝\n');
    process.stderr.write('\n');
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
