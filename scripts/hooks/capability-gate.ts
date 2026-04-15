#!/usr/bin/env node

/**
 * Capability Gate — PreToolUse hook for Edit and Write.
 *
 * Detects when content being written claims something "can't be done" or
 * "doesn't exist" and automatically searches Keel's 656+ indexed capabilities
 * before allowing the claim through. Advisory only (exit 0) — warns, never blocks.
 *
 * Root cause: Intent #179 — Keel forgets capabilities it has and presents problems
 * as unsolved. The OAuth refresh mechanism existed for months but was presented
 * as unsolvable (integration gap failure mode).
 *
 * Fires on: PreToolUse (Edit, Write)
 */

const { execSync } = require('child_process');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const KEEL_DIR = resolveRepoRoot();
const CAPABILITY_SEARCH = path.join(KEEL_DIR, 'scripts', 'tools', 'capability-search.ts');

// Phrases that signal "I can't do this" — the exact failure mode we're catching
const CANT_PATTERNS = [
  /\bi\s+can'?t\b/i,
  /\bwe\s+don'?t\s+have\b/i,
  /\bthere'?s\s+no\s+way\s+to\b/i,
  /\bnot\s+possible\b/i,
  /\bno\s+capability\b/i,
  /\bunable\s+to\b/i,
  /\bdoesn'?t\s+exist\b/i,
  /\bcan'?t\s+be\s+done\b/i,
  /\bno\s+tool\s+for\b/i,
  /\bno\s+script\s+for\b/i,
  /\bnot\s+available\b/i,
  /\bno\s+way\s+to\b/i,
  /\bwe\s+lack\b/i,
  /\bdon'?t\s+have\s+(?:a\s+)?(?:way|tool|script|capability)\b/i,
  /\bno\s+existing\b/i,
  /\bnot\s+(?:currently\s+)?supported\b/i,
  /\bcannot\b/i,
];

// Files where these phrases are expected (documentation, identity, this hook itself)
const EXEMPT_PATTERNS = [
  /^identity\//,
  /^CLAUDE\.md$/,
  /^memory\//,
  /^skills\//,
  /^BUILD_LOG/,
  /^config\//,
  /^scripts\/hooks\/capability-gate\.ts$/,
  /^scripts\/tests\//,
];

/**
 * Extract a search query from the surrounding text of the matched "can't" phrase.
 * Grabs the sentence or clause containing the match and strips filler words.
 */
function extractSearchTerms(content: string, matchIndex: number): string {
  // Get a window around the match — ~200 chars on each side
  const start = Math.max(0, matchIndex - 200);
  const end = Math.min(content.length, matchIndex + 200);
  const window = content.slice(start, end);

  // Remove common filler/stop words and keep nouns/verbs that are searchable
  const stopWords = new Set([
    'i', 'we', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'cannot', 'cant',
    "can't", 'not', 'no', 'nor', 'but', 'or', 'and', 'if', 'then', 'else',
    'when', 'up', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
    'there', 'here', 'this', 'that', 'these', 'those', 'to', 'from', 'by',
    'for', 'with', 'about', 'between', 'through', 'during', 'before', 'after',
    'above', 'below', 'of', 'at', 'in', 'into', 'it', 'its', "it's",
    'way', 'don', 'doesn', 'didn', 'won', 'wouldn', 'currently', 'able',
    'unable', 'possible', 'available', 'supported', 'existing', 'done',
    'find', 'think', 'know', 'need', 'want', 'get', 'make', 'just',
    'also', 'so', 'than', 'too', 'very', 'only', 'own', 'same',
  ]);

  // Extract words, filter stops, keep up to 5 meaningful terms
  const words = window
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  return unique.slice(0, 5).join(' ');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolInput = hookData.tool_input || hookData.input || {};
  const toolName = hookData.tool_name || hookData.name || '';
  const filePath = toolInput.file_path || '';

  if (!filePath) process.exit(0);

  // Get relative path
  let relPath = filePath;
  if (filePath.startsWith(KEEL_DIR + '/')) {
    relPath = filePath.slice(KEEL_DIR.length + 1);
  }

  // Skip exempt files (memory, identity, docs, config, tests, this hook)
  if (EXEMPT_PATTERNS.some(p => p.test(relPath))) {
    process.exit(0);
  }

  // Extract content to scan
  let contentToScan = '';
  if (toolName === 'Edit' || toolName === 'edit') {
    contentToScan = toolInput.new_string || '';
  } else if (toolName === 'Write' || toolName === 'write') {
    contentToScan = toolInput.content || '';
  }

  if (!contentToScan) process.exit(0);

  // Check for "can't do it" patterns
  let firstMatch: { pattern: RegExp; index: number } | null = null;
  for (const pattern of CANT_PATTERNS) {
    const match = pattern.exec(contentToScan);
    if (match) {
      if (!firstMatch || match.index < firstMatch.index) {
        firstMatch = { pattern, index: match.index };
      }
    }
  }

  if (!firstMatch) process.exit(0);

  // Extract search terms from the surrounding context
  const searchQuery = extractSearchTerms(contentToScan, firstMatch.index);
  if (!searchQuery) process.exit(0);

  // Run capability search
  try {
    const result = execSync(
      `node "${CAPABILITY_SEARCH}" "${searchQuery}" --limit 5`,
      {
        cwd: KEEL_DIR,
        timeout: 10000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    // Check if capabilities were actually found (not "No capabilities found")
    if (result.includes('No capabilities found')) {
      process.exit(0);
    }

    // Parse the output to extract capability names
    const lines = result.split('\n').filter(l => l.trim());
    const capLines: string[] = [];
    for (const line of lines) {
      // Match lines that show capability type + name
      const capMatch = line.match(/^\s+(function|class|const|type|interface)\s+(\S+)/);
      if (capMatch) {
        capLines.push(`  ${capMatch[1]} ${capMatch[2]}`);
      }
      // Match lines showing the file path
      const fileMatch = line.match(/^\s{13}(scripts\/\S+)/);
      if (fileMatch) {
        capLines[capLines.length - 1] += ` (${fileMatch[1]})`;
      }
    }

    if (capLines.length > 0) {
      console.error('');
      console.error(`CAPABILITY GATE: Content claims something can't be done.`);
      console.error(`  Search: "${searchQuery}"`);
      console.error(`  Before claiming this can't be done, check these existing capabilities:`);
      console.error('');
      for (const cap of capLines) {
        console.error(`  ${cap}`);
      }
      console.error('');
      console.error(`  Run: npx tsx scripts/tools/capability-search.ts "${searchQuery}" for details.`);
      console.error('');
    }
  } catch {
    // Search failed — don't block. This is advisory.
  }

  // Semantic "can't" evaluation — classifier assesses if the claim is genuine or lazy
  if (contentToScan.length > 50 && firstMatch) {
    try {
      const { localClassify } = require('../lib/local-inference.ts');
      const cantContext = contentToScan.slice(Math.max(0, firstMatch.index - 100), firstMatch.index + 200);
      const evalPrompt = `An AI assistant is writing code that claims something "can't be done" or "doesn't exist." Evaluate if this is:
1. GENUINE: The capability truly doesn't exist and would need to be built
2. LAZY: The assistant hasn't checked properly — the capability likely exists but wasn't looked up
3. DEFLECTING: The assistant is routing work to the human when it could solve it itself

Respond with ONE word: GENUINE, LAZY, or DEFLECTING

Context: ${cantContext.slice(0, 400)}`;

      const evalResult: string = await localClassify(evalPrompt, { maxTokens: 5, timeoutMs: 2000, uppercase: true, fallback: '' });

      if (evalResult.startsWith('LAZY') || evalResult.startsWith('DEFLECTING')) {
        console.error(`  ⚠ classifier assessment: ${evalResult} — check harder before claiming this can't be done.`);
        console.error('');
      }
    } catch { /* advisory — never block */ }
  }

  // Always allow — this is advisory only
  process.exit(0);
}

main().catch(() => process.exit(0));
