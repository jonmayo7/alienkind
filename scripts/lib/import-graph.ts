/**
 * Import Graph — dynamic relationship detection from code.
 *
 * Parses require() and import statements to build a dependency graph.
 * Used by conflict-guard.ts for related-file detection.
 * No manual maintenance — relationships computed from source code.
 *
 * Usage:
 *   const { getRelatedFiles, buildGraph } = require('./import-graph.ts');
 *   const related = getRelatedFiles('scripts/daemon.ts'); // returns files that import or are imported by daemon.ts
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CACHE_FILE = '/tmp/alienkind-import-graph.json';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface GraphEdge {
  from: string;  // relative path of the file doing the import
  to: string;    // relative path of the imported file
}

interface Graph {
  edges: GraphEdge[];
  builtAt: number;
}

/**
 * Extract require/import targets from a TypeScript/JavaScript file.
 */
function extractImports(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports: string[] = [];

    // require('./path') or require('../path')
    const requireMatches = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of requireMatches) {
      if (m[1].startsWith('.')) imports.push(m[1]);
    }

    // import ... from './path'
    const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
    for (const m of importMatches) {
      if (m[1].startsWith('.')) imports.push(m[1]);
    }

    return imports;
  } catch { return []; }
}

/**
 * Resolve a relative import path to an absolute path, then to a relative path from ALIENKIND_DIR.
 */
function resolveImport(fromFile: string, importPath: string): string | null {
  const fromDir = path.dirname(fromFile);
  let resolved = path.resolve(ALIENKIND_DIR, fromDir, importPath);

  // Try with extensions
  const extensions = ['', '.ts', '.js', '.json'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(ALIENKIND_DIR, candidate);
    }
  }

  // Try as directory with index
  for (const ext of ['.ts', '.js']) {
    const indexCandidate = path.join(resolved, `index${ext}`);
    if (fs.existsSync(indexCandidate)) {
      return path.relative(ALIENKIND_DIR, indexCandidate);
    }
  }

  return null;
}

/**
 * Build the full import graph by scanning all TypeScript files.
 */
function buildGraph(): Graph {
  const edges: GraphEdge[] = [];
  const { execSync } = require('child_process');

  try {
    const files = execSync(
      'find scripts/ config/ -name "*.ts" -not -path "*/node_modules/*" -not -path "*/.git/*"',
      { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }
    ).trim().split('\n').filter(Boolean);

    for (const file of files) {
      const imports = extractImports(path.join(ALIENKIND_DIR, file));
      for (const imp of imports) {
        const resolved = resolveImport(file, imp);
        if (resolved) {
          edges.push({ from: file, to: resolved });
        }
      }
    }
  } catch { /* scan failed — return partial graph */ }

  const graph = { edges, builtAt: Date.now() };

  // Cache
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(graph));
  } catch {}

  return graph;
}

/**
 * Get the cached graph or build a new one.
 */
function getGraph(): Graph {
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return buildGraph();
}

/**
 * Get files related to a given file — both files it imports AND files that import it.
 * Returns relative paths from ALIENKIND_DIR.
 */
function getRelatedFiles(relPath: string): string[] {
  const graph = getGraph();
  const related = new Set<string>();

  for (const edge of graph.edges) {
    // Files this file imports
    if (edge.from === relPath) {
      related.add(edge.to);
    }
    // Files that import this file
    if (edge.to === relPath) {
      related.add(edge.from);
    }
  }

  // Remove self
  related.delete(relPath);

  return Array.from(related);
}

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--build')) {
    const graph = buildGraph();
    console.log(`Built graph: ${graph.edges.length} edges`);
  } else if (args.length > 0) {
    const related = getRelatedFiles(args[0]);
    console.log(`Files related to ${args[0]}:`);
    for (const f of related) console.log(`  ${f}`);
  } else {
    console.log('Usage: npx tsx scripts/lib/import-graph.ts <file-path> | --build');
  }
}

module.exports = { getRelatedFiles, buildGraph, getGraph };
