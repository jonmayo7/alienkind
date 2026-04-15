#!/usr/bin/env npx tsx
/**
 * Organ Map — produces a structured map of an organ for working group analysis.
 *
 * Phase 0 of the working group cycle. Reads the organ's file list, import graph,
 * export surface, and data flows. Produces a JSON map that Phase 1 (Diverge)
 * uses to know what to analyze and what connections to trace.
 *
 * Usage:
 *   npx tsx scripts/tools/organ-map.ts --organ consciousness-engine
 *   npx tsx scripts/tools/organ-map.ts --organ security-organ
 *   npx tsx scripts/tools/organ-map.ts --list
 */

const fs = require('fs');
const path = require('path');
const { getRelatedFiles, buildGraph } = require('../lib/import-graph.ts');

const KEEL_DIR = path.resolve(__dirname, '..', '..');

// Organ definitions: entry files + related patterns
// CUSTOMIZE: Add your own organs below. Each organ is a subsystem of the organism
// with its own entry files and file patterns. The working group steward uses this
// map to scope its analysis — files outside the organ are flagged by scope-lock.
const ORGANS: Record<string, { name: string; description: string; entryFiles: string[]; patterns: string[] }> = {
  'consciousness-engine': {
    name: 'Consciousness Engine',
    description: 'Single source of truth for everywhere the organism shows up. processMessage -> invoke -> invokeKeel -> Claude CLI.',
    entryFiles: [
      'scripts/lib/consciousness-engine.ts',
      'scripts/lib/runtime.ts',
      'scripts/lib/invoke.ts',
    ],
    patterns: ['consciousness-engine', 'runtime', 'invoke', 'discernment-engine', 'discernment-config', 'consult', 'cross-verify'],
  },
  'security-organ': {
    name: 'Security Organ',
    description: 'Multi-scan security organ: threat-hunter, red-team, pentest, osint, honeypots, threat-intel.',
    entryFiles: [
      'scripts/security/threat-hunter.ts',
      'scripts/security/red-team.ts',
      'scripts/security/pentest-scan.ts',
    ],
    patterns: ['security/', 'injection-detector', 'privacy-gate'],
  },
  'nightly-pipeline': {
    name: 'Nightly Pipeline',
    description: 'Sequential overnight pipeline: immune -> analysis -> identity-sync -> digest.',
    entryFiles: [
      'scripts/lib/nightly/immune.ts',
      'scripts/lib/nightly/analysis.ts',
      'scripts/lib/nightly/identity-sync.ts',
      'scripts/lib/nightly/weekly.ts',
    ],
    patterns: ['nightly/', 'nightly-cycle'],
  },
  'communication-layer': {
    name: 'Communication Layer',
    description: 'Telegram, Discord — all outbound messaging surfaces.',
    entryFiles: [
      'scripts/telegram-bot.ts',
      'scripts/discord-engine.ts',
      'scripts/lib/telegram.ts',
    ],
    patterns: ['telegram', 'discord'],
  },
  'infrastructure': {
    name: 'Infrastructure',
    description: 'Daemon, scheduler, job-queue, resource-guardian, auto-commit.',
    entryFiles: [
      'scripts/daemon.ts',
      'scripts/lib/scheduler.ts',
      'scripts/lib/job-queue.ts',
    ],
    patterns: ['daemon', 'scheduler', 'job-queue', 'resource-guardian', 'auto-commit'],
  },
  'circulation': {
    name: 'Circulation System',
    description: 'Stigmergic blackboard. Deposit/withdraw/reinforce findings across organs.',
    entryFiles: [
      'scripts/lib/circulation.ts',
      'scripts/circulation-pump.ts',
    ],
    patterns: ['circulation'],
  },
  'memory': {
    name: 'Memory System',
    description: 'Memory indexing, search, and embedding. How the organism remembers across sessions.',
    entryFiles: [
      'scripts/lib/memory-indexer.ts',
      'scripts/lib/memory-search.ts',
    ],
    patterns: ['memory-indexer', 'memory-search', 'memory-chunks'],
  },
  'discernment': {
    name: 'Discernment Engine',
    description: 'Signal evaluation for multi-party channels. Decides when to speak, when to stay silent, and when to act.',
    entryFiles: [
      'scripts/lib/discernment-engine.ts',
    ],
    patterns: ['discernment-engine', 'discernment-config'],
  },
};

interface FileInfo {
  path: string;
  lines: number;
  exports: string[];
  imports: string[];
  consumers: string[]; // files that import this file
}

interface OrganMap {
  organ: string;
  name: string;
  description: string;
  files: FileInfo[];
  totalLines: number;
  externalConsumers: string[]; // files outside this organ that import its files
  internalConnections: { from: string; to: string }[];
  dataFlows: string[]; // Supabase tables read/written
}

function getExports(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const exports: string[] = [];

    // module.exports = { ... }
    const moduleExports = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (moduleExports) {
      const names = moduleExports[1].match(/\b(\w+)\b/g);
      if (names) exports.push(...names.filter((n: string) => n !== 'module' && n !== 'exports'));
    }

    // exports.X = ...
    const namedExports = content.matchAll(/exports\.(\w+)\s*=/g);
    for (const m of namedExports) exports.push(m[1]);

    const deduped: string[] = [];
    for (const e of exports) { if (!deduped.includes(e)) deduped.push(e); }
    return deduped;
  } catch { return []; }
}

function getImportsFor(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports: string[] = [];
    const matches = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of matches) {
      if (m[1].startsWith('.')) {
        const resolved = path.resolve(path.dirname(filePath), m[1]);
        const rel = path.relative(KEEL_DIR, resolved).replace(/\.(ts|js)$/, '');
        imports.push(rel);
      }
    }
    return imports;
  } catch { return []; }
}

function getSupabaseTables(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const tables: string[] = [];
    const re = /supabase(?:Get|Post|Patch|Count|Delete)\s*\(\s*['"]([a-z_]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!tables.includes(m[1])) tables.push(m[1]);
    }
    return tables;
  } catch { return []; }
}

function countLines(filePath: string): number {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').length;
  } catch { return 0; }
}

function buildOrganMap(organKey: string): OrganMap {
  const organ = ORGANS[organKey];
  if (!organ) throw new Error(`Unknown organ: ${organKey}`);

  // Collect all files that belong to this organ
  const organFiles = new Set<string>();

  // Add entry files
  for (const entry of organ.entryFiles) {
    const fullPath = path.join(KEEL_DIR, entry);
    if (fs.existsSync(fullPath)) organFiles.add(entry);
  }

  // Add files matching patterns
  const allTsFiles = fs.readdirSync(path.join(KEEL_DIR, 'scripts'), { recursive: true })
    .filter((f: string) => f.endsWith('.ts') && !f.includes('node_modules') && !f.startsWith('tests/'))
    .map((f: string) => `scripts/${f}`);

  for (const f of allTsFiles) {
    if (organ.patterns.some(p => f.includes(p))) organFiles.add(f);
  }

  // Add related files (one hop from entry files via import graph)
  for (const entry of organ.entryFiles) {
    const related = getRelatedFiles(entry);
    // Only add if they match a pattern (avoid pulling in the entire codebase)
    for (const r of related) {
      if (organ.patterns.some(p => r.includes(p))) organFiles.add(r);
    }
  }

  // Build file info
  const files: FileInfo[] = [];
  const allTables: string[] = [];

  const organFileList = Array.from(organFiles) as string[];
  for (const relPath of organFileList) {
    const fullPath = path.join(KEEL_DIR, relPath);
    if (!fs.existsSync(fullPath)) continue;

    const exports = getExports(fullPath);
    const imports = getImportsFor(fullPath);
    const consumers = getRelatedFiles(relPath).filter((r: string) => !organFiles.has(r));
    const tables = getSupabaseTables(fullPath);
    for (const t of tables) { if (!allTables.includes(t)) allTables.push(t); }

    files.push({
      path: relPath,
      lines: countLines(fullPath),
      exports,
      imports,
      consumers,
    });
  }

  // Internal connections (imports between organ files)
  const internalConnections: { from: string; to: string }[] = [];
  for (const file of files) {
    for (const imp of file.imports) {
      const impWithExt = organFiles.has(imp + '.ts') ? imp + '.ts' : imp;
      if (organFiles.has(impWithExt) || organFiles.has(imp)) {
        internalConnections.push({ from: file.path, to: imp });
      }
    }
  }

  // External consumers (files outside organ that import organ files)
  const externalConsumers: string[] = [];
  for (const file of files) {
    for (const c of file.consumers) {
      if (!organFiles.has(c) && !externalConsumers.includes(c)) externalConsumers.push(c);
    }
  }

  return {
    organ: organKey,
    name: organ.name,
    description: organ.description,
    files: files.sort((a, b) => b.lines - a.lines),
    totalLines: files.reduce((sum, f) => sum + f.lines, 0),
    externalConsumers: externalConsumers.sort(),
    internalConnections,
    dataFlows: allTables.sort(),
  };
}

// --- Surveyor: verify the map is accurate ---

interface SurveyResult {
  passed: boolean;
  missingFiles: string[];      // files in map that don't exist on disk
  unmappedFiles: string[];     // files that reference the organ but aren't in the map
  brokenConsumers: string[];   // listed consumers that don't actually import organ files
  exportDrift: { file: string; claimed: string[]; actual: string[] }[];
}

function surveyOrgan(map: OrganMap): SurveyResult {
  const issues: SurveyResult = { passed: true, missingFiles: [], unmappedFiles: [], brokenConsumers: [], exportDrift: [] };
  const organFilePaths = map.files.map(f => f.path);

  // 1. File existence
  for (const f of map.files) {
    const fullPath = path.join(KEEL_DIR, f.path);
    if (!fs.existsSync(fullPath)) {
      issues.missingFiles.push(f.path);
      issues.passed = false;
    }
  }

  // 2. Unmapped files — search for files that reference organ entry files but aren't in the map
  const organKeywords = map.files.map(f => path.basename(f.path, '.ts'));
  const allScripts = fs.readdirSync(path.join(KEEL_DIR, 'scripts', 'lib'), { recursive: true })
    .filter((f: string) => f.endsWith('.ts') && !f.includes('node_modules'))
    .map((f: string) => `scripts/lib/${f}`);

  for (const scriptPath of allScripts) {
    if (organFilePaths.includes(scriptPath)) continue;
    const fullPath = path.join(KEEL_DIR, scriptPath);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      // Check if this file imports any of the organ's entry files
      for (const entryFile of map.files.slice(0, 3)) { // check top 3 files (entry points)
        const baseName = path.basename(entryFile.path, '.ts');
        if (content.includes(baseName) && content.match(new RegExp(`require.*${baseName}|import.*${baseName}`))) {
          issues.unmappedFiles.push(scriptPath);
          break;
        }
      }
    } catch { /* skip unreadable files */ }
  }

  // 3. Consumer verification (spot check top 10 — check for ANY organ file import)
  const organBaseNames = map.files.map(f => path.basename(f.path, '.ts'));
  for (const consumer of map.externalConsumers.slice(0, 10)) {
    const fullPath = path.join(KEEL_DIR, consumer);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const importsAnyOrganFile = organBaseNames.some(name => content.includes(name));
      if (!importsAnyOrganFile) {
        issues.brokenConsumers.push(consumer);
      }
    } catch {
      issues.brokenConsumers.push(consumer + ' (file not found)');
    }
  }

  // 4. Export drift — verify claimed exports exist in the actual file
  for (const f of map.files) {
    if (f.exports.length === 0) continue;
    const fullPath = path.join(KEEL_DIR, f.path);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const missing = f.exports.filter(e => !content.includes(e));
      if (missing.length > 0) {
        issues.exportDrift.push({ file: f.path, claimed: missing, actual: [] });
        issues.passed = false;
      }
    } catch { /* skip */ }
  }

  // Unmapped files are only a FAIL if they match organ patterns (truly missing from map)
  // Files that reference the organ without matching patterns are consumers (expected)
  const organ = ORGANS[map.organ];
  const trulyMissing = organ ? issues.unmappedFiles.filter(f => organ.patterns.some(p => f.includes(p))) : issues.unmappedFiles;
  if (trulyMissing.length > 0) issues.passed = false;
  // Keep all in the list for visibility, but only fail on truly missing
  if (issues.brokenConsumers.length > 0) issues.passed = false;

  return issues;
}

// --- Exports (for programmatic use by triage-aire, working groups) ---
module.exports = { buildOrganMap, surveyOrgan, ORGANS };

// --- CLI ---
if (!module.parent) {  // Only run CLI when executed directly
const args = process.argv.slice(2);

if (args.includes('--list')) {
  console.log('Available organs:\n');
  for (const [key, organ] of Object.entries(ORGANS)) {
    console.log(`  ${key}`);
    console.log(`    ${organ.description}`);
    console.log(`    Entry: ${organ.entryFiles.join(', ')}\n`);
  }
  process.exit(0);
}

const organIdx = args.indexOf('--organ');
if (organIdx === -1 || !args[organIdx + 1]) {
  console.error('Usage: npx tsx scripts/tools/organ-map.ts --organ <name>');
  console.error('       npx tsx scripts/tools/organ-map.ts --list');
  process.exit(1);
}

const organKey = args[organIdx + 1];
const map = buildOrganMap(organKey);

// Run surveyor verification
const survey = surveyOrgan(map);

// Output
console.log(`\n=== ${map.name} ===`);
console.log(`${map.description}\n`);
console.log(`Files: ${map.files.length} | Lines: ${map.totalLines} | Supabase tables: ${map.dataFlows.length}`);
console.log(`External consumers: ${map.externalConsumers.length}`);
console.log(`Survey: ${survey.passed ? 'PASSED' : 'ISSUES FOUND'}\n`);

// Survey results
if (!survey.passed || args.includes('--verify')) {
  if (survey.missingFiles.length > 0) {
    console.log('SURVEY — Missing files (in map but not on disk):');
    for (const f of survey.missingFiles) console.log(`  ✗ ${f}`);
  }
  if (survey.unmappedFiles.length > 0) {
    console.log('SURVEY — Unmapped files (reference this organ but not in map):');
    for (const f of survey.unmappedFiles) console.log(`  ? ${f}`);
  }
  if (survey.brokenConsumers.length > 0) {
    console.log('SURVEY — Broken consumers (listed but don\'t import organ):');
    for (const f of survey.brokenConsumers) console.log(`  ✗ ${f}`);
  }
  if (survey.exportDrift.length > 0) {
    console.log('SURVEY — Export drift (claimed exports not found in file):');
    for (const d of survey.exportDrift) console.log(`  ✗ ${d.file}: missing ${d.claimed.join(', ')}`);
  }
  console.log('');
}

console.log('Files (by size):');
for (const f of map.files) {
  console.log(`  ${f.path} (${f.lines} lines, ${f.exports.length} exports, ${f.consumers.length} consumers)`);
}

console.log('\nInternal connections:');
for (const c of map.internalConnections) {
  console.log(`  ${c.from} → ${c.to}`);
}

console.log('\nData flows (Supabase tables):');
for (const t of map.dataFlows) {
  console.log(`  ${t}`);
}

console.log('\nExternal consumers (files outside this organ that depend on it):');
for (const c of map.externalConsumers.slice(0, 15)) {
  console.log(`  ${c}`);
}
if (map.externalConsumers.length > 15) {
  console.log(`  ... and ${map.externalConsumers.length - 15} more`);
}

// Also output JSON for programmatic use
if (args.includes('--json')) {
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(map, null, 2));
}
} // end if (!module.parent)
