#!/usr/bin/env npx tsx

/**
 * Alien Kind — OpenClaw Consumption Engine
 *
 * Reads an OpenClaw installation directory and imports the partnership
 * history into AlienKind's architecture. Zero external dependencies.
 *
 * Usage:
 *   npx tsx scripts/tools/consume-openclaw.ts [options] [path]
 *
 * Arguments:
 *   path              Path to OpenClaw directory (default: ~/.openclaw)
 *
 * Options:
 *   --dry-run         Show what would be imported without writing
 *   --full            Import ALL sessions (default: last 50)
 *   --skip-soul       Don't import SOUL.md
 *   --skip-sessions   Don't mine sessions for learnings
 *   --help            Show this help message
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

// ============================================================================
// CLI parsing
// ============================================================================

interface CLIOptions {
  openclawPath: string;
  dryRun: boolean;
  full: boolean;
  skipSoul: boolean;
  skipSessions: boolean;
}

function parseArgs(argv: string[]): CLIOptions {
  const args = argv.slice(2);
  const opts: CLIOptions = {
    openclawPath: path.join(os.homedir(), '.openclaw'),
    dryRun: false,
    full: false,
    skipSoul: false,
    skipSessions: false,
  };

  const positional: string[] = [];

  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--full':
        opts.full = true;
        break;
      case '--skip-soul':
        opts.skipSoul = true;
        break;
      case '--skip-sessions':
        opts.skipSessions = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`\n  \x1b[31m\u2717\x1b[0m Unknown option: ${arg}\n`);
          printHelp();
          process.exit(1);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 0) {
    opts.openclawPath = path.resolve(positional[0]);
  }

  return opts;
}

function printHelp(): void {
  console.log(`
  \x1b[1m\x1b[35m\ud83d\udc7d Alien Kind \u2014 OpenClaw Consumption Engine\x1b[0m

  Import your OpenClaw partnership history into Alien Kind.

  \x1b[1mUsage:\x1b[0m
    npx tsx scripts/tools/consume-openclaw.ts [options] [path]

  \x1b[1mArguments:\x1b[0m
    path              Path to OpenClaw directory (default: ~/.openclaw)

  \x1b[1mOptions:\x1b[0m
    --dry-run         Show what would be imported without writing
    --full            Import ALL sessions (default: last 50)
    --skip-soul       Don't import SOUL.md
    --skip-sessions   Don't mine sessions for learnings
    --help            Show this help message

  \x1b[1mExamples:\x1b[0m
    npx tsx scripts/tools/consume-openclaw.ts
    npx tsx scripts/tools/consume-openclaw.ts --dry-run
    npx tsx scripts/tools/consume-openclaw.ts --full /path/to/.openclaw
    npx tsx scripts/tools/consume-openclaw.ts --skip-sessions ~/my-openclaw
`);
}

// ============================================================================
// Display helpers
// ============================================================================

function banner(): void {
  console.log(`
\x1b[36m              ___\x1b[0m
\x1b[36m          ___/   \\___\x1b[0m
\x1b[36m       __/   \x1b[2m'---'\x1b[0m\x1b[36m   \\__\x1b[0m
\x1b[36m      /    \x1b[33m*\x1b[0m  \x1b[32m\ud83d\udc7d\x1b[0m  \x1b[33m*\x1b[0m\x1b[36m     \\\x1b[0m
\x1b[36m     /___________________\\\x1b[0m
\x1b[33m          /  |  |  \\\x1b[0m
\x1b[33m         *   *  *   *\x1b[0m

     \x1b[1m\x1b[35mA L I E N   K I N D\x1b[0m
  \x1b[2mOpenClaw Consumption Engine\x1b[0m
`);
}

function ok(msg: string): void {
  console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`);
}

function skip(msg: string): void {
  console.log(`  \x1b[31m\u2717\x1b[0m ${msg}`);
}

function info(msg: string): void {
  console.log(`  \x1b[33m\u25b8\x1b[0m ${msg}`);
}

function heading(msg: string): void {
  console.log(`\n\x1b[36m${msg}\x1b[0m`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================================
// Scan phase — discover what's available
// ============================================================================

interface ScanResult {
  soulPath: string | null;
  soulSize: number;
  memoryPath: string | null;
  memorySize: number;
  sessionFiles: string[];
  dailyFiles: string[];
  execApprovalsPath: string | null;
}

function scan(openclawPath: string): ScanResult {
  const result: ScanResult = {
    soulPath: null,
    soulSize: 0,
    memoryPath: null,
    memorySize: 0,
    sessionFiles: [],
    dailyFiles: [],
    execApprovalsPath: null,
  };

  // SOUL.md
  const soulPath = path.join(openclawPath, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    result.soulPath = soulPath;
    result.soulSize = fs.statSync(soulPath).size;
  }

  // MEMORY.md
  const memoryPath = path.join(openclawPath, 'MEMORY.md');
  if (fs.existsSync(memoryPath)) {
    result.memoryPath = memoryPath;
    result.memorySize = fs.statSync(memoryPath).size;
  }

  // Session JSONL files
  const sessionsDir = path.join(openclawPath, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => path.join(sessionsDir, f));

      // Sort by modification time (oldest first, so slice from end for most recent)
      files.sort((a: string, b: string) => {
        const aStat = fs.statSync(a);
        const bStat = fs.statSync(b);
        return aStat.mtimeMs - bStat.mtimeMs;
      });

      result.sessionFiles = files;
    } catch {
      // Directory exists but unreadable — skip silently
    }
  }

  // Daily memory files
  const memoryDir = path.join(openclawPath, 'memory');
  if (fs.existsSync(memoryDir)) {
    try {
      const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
      result.dailyFiles = fs.readdirSync(memoryDir)
        .filter((f: string) => datePattern.test(f))
        .map((f: string) => path.join(memoryDir, f));
    } catch {
      // Skip silently
    }
  }

  // exec-approvals.json
  const execPath = path.join(openclawPath, 'exec-approvals.json');
  if (fs.existsSync(execPath)) {
    result.execApprovalsPath = execPath;
  }

  return result;
}

function reportScan(result: ScanResult, opts: CLIOptions): void {
  heading('Scanning ' + opts.openclawPath + '...');

  if (result.soulPath) {
    ok(`Found SOUL.md (${formatBytes(result.soulSize)})`);
  } else {
    skip('No SOUL.md');
  }

  if (result.memoryPath) {
    ok(`Found MEMORY.md (${formatBytes(result.memorySize)})`);
  } else {
    skip('No MEMORY.md');
  }

  const totalSessions = result.sessionFiles.length;
  if (totalSessions > 0) {
    const limit = opts.full ? totalSessions : Math.min(50, totalSessions);
    const label = opts.full
      ? `Found ${totalSessions} sessions (importing all)`
      : `Found ${totalSessions} sessions (importing last ${limit})`;
    ok(label);
  } else {
    skip('No sessions found');
  }

  if (result.dailyFiles.length > 0) {
    ok(`Found ${result.dailyFiles.length} daily notes`);
  } else {
    skip('No daily notes');
  }

  if (result.execApprovalsPath) {
    ok('Found exec-approvals.json');
  } else {
    skip('No exec-approvals.json');
  }
}

// ============================================================================
// SOUL.md → identity/character.md
// ============================================================================

interface SoulSection {
  heading: string;
  content: string;
}

function parseSoulSections(content: string): SoulSection[] {
  const lines = content.split('\n');
  const sections: SoulSection[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    // Skip H1 title lines (e.g. "# Soul") — we only care about ## sections
    if (/^#\s+[^#]/.test(line) && !currentHeading) {
      continue;
    }
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentHeading || currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Final section
  if (currentHeading || currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join('\n').trim(),
    });
  }

  return sections;
}

function mapSoulToCharacter(sections: SoulSection[]): { text: string; sectionCount: number } {
  // Classify each section into AlienKind identity buckets
  const thinkPatterns = /personality|traits|behavior|approach|thinking|core|principles|identity|mindset/i;
  const speakPatterns = /communication|style|voice|tone|language|speak|talk|writing/i;
  const protectPatterns = /rules|guidelines|red.?lines|boundaries|limits|safety|never|forbidden|protect/i;
  const valuePatterns = /values|beliefs|priorities|ethics|moral|philosophy|mission|purpose/i;

  const buckets: Record<string, string[]> = {
    think: [],
    speak: [],
    protect: [],
    value: [],
    unclassified: [],
  };

  for (const section of sections) {
    const h = section.heading;
    const block = section.content;
    if (!block) continue;

    if (thinkPatterns.test(h)) {
      buckets.think.push(block);
    } else if (speakPatterns.test(h)) {
      buckets.speak.push(block);
    } else if (protectPatterns.test(h)) {
      buckets.protect.push(block);
    } else if (valuePatterns.test(h)) {
      buckets.value.push(block);
    } else {
      buckets.unclassified.push(block);
    }
  }

  // If nothing classified, dump everything into "How I think"
  const hasClassified = buckets.think.length + buckets.speak.length +
    buckets.protect.length + buckets.value.length > 0;

  if (!hasClassified) {
    buckets.think = sections
      .map(s => s.content)
      .filter(c => c.length > 0);
  }

  const sectionCount = (hasClassified
    ? [buckets.think, buckets.speak, buckets.protect, buckets.value]
    : [buckets.think]
  ).filter(b => b.length > 0).length;

  const parts: string[] = [];
  parts.push(`# Character\n`);
  parts.push(`_Imported from OpenClaw on ${today()}. Edit freely \u2014 this is yours now._\n`);

  if (buckets.think.length > 0) {
    parts.push(`\n## How I think\n\n${buckets.think.join('\n\n')}`);
  }

  if (buckets.speak.length > 0) {
    parts.push(`\n## How I speak\n\n${buckets.speak.join('\n\n')}`);
  }

  if (buckets.protect.length > 0) {
    parts.push(`\n## What I protect\n\n${buckets.protect.join('\n\n')}`);
  }

  if (buckets.value.length > 0) {
    parts.push(`\n## What I value\n\n${buckets.value.join('\n\n')}`);
  }

  if (hasClassified && buckets.unclassified.length > 0) {
    parts.push(`\n## Other\n\n${buckets.unclassified.join('\n\n')}`);
  }

  return { text: parts.join('\n'), sectionCount };
}

function importSoul(scanResult: ScanResult, opts: CLIOptions): { imported: boolean; sectionCount: number } {
  if (!scanResult.soulPath || opts.skipSoul) {
    return { imported: false, sectionCount: 0 };
  }

  const charPath = path.join(ROOT, 'identity', 'character.md');

  // Only overwrite if character.md still has the template marker
  if (fs.existsSync(charPath)) {
    const existing = fs.readFileSync(charPath, 'utf8');
    if (!existing.includes('## How to write this file')) {
      info('identity/character.md already customized \u2014 skipping SOUL.md import');
      return { imported: false, sectionCount: 0 };
    }
  }

  const soulContent = fs.readFileSync(scanResult.soulPath, 'utf8');
  const sections = parseSoulSections(soulContent);
  const { text, sectionCount } = mapSoulToCharacter(sections);

  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(charPath), { recursive: true });
    fs.writeFileSync(charPath, text, 'utf8');
  }

  return { imported: true, sectionCount };
}

// ============================================================================
// MEMORY.md → memory/imported/openclaw-memory.md
// ============================================================================

function importMemory(scanResult: ScanResult, opts: CLIOptions): boolean {
  if (!scanResult.memoryPath) return false;

  const destDir = path.join(ROOT, 'memory', 'imported');
  const destPath = path.join(destDir, 'openclaw-memory.md');

  const content = fs.readFileSync(scanResult.memoryPath, 'utf8');
  const output = `# Imported from OpenClaw\n\n_Imported on ${today()}. These are durable facts your previous partner remembered._\n\n${content}`;

  if (!opts.dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destPath, output, 'utf8');
  }

  return true;
}

// ============================================================================
// Sessions → .partner/imported-learnings.md
// ============================================================================

// Patterns that indicate the user is correcting the partner
const CORRECTION_PATTERNS = [
  /^no[,.\s!]/i,
  /^not that/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\bwrong\b/i,
  /\bi said\b/i,
  /\bi meant\b/i,
  /\bthat'?s not right\b/i,
  /^actually[,\s]/i,
  /\bnot what i\b/i,
  /\bthat'?s wrong\b/i,
  /\bnever do\b/i,
  /\bdon'?t ever\b/i,
  /\bI already told you\b/i,
  /\bnope\b/i,
];

// Patterns that indicate explicit preferences
const PREFERENCE_PATTERNS = [
  /\bi prefer\b/i,
  /\balways\s+\w+/i,
  /\bnever\s+\w+/i,
  /\bfrom now on\b/i,
  /\bremember that\b/i,
  /\bkeep in mind\b/i,
  /\bgoing forward\b/i,
  /\bmake sure (to|you)\b/i,
  /\bi (like|want|need) (it|you|things) (to be|when)\b/i,
];

interface SessionLine {
  role?: string;
  content?: string;
  timestamp?: string;
}

interface LearningResult {
  corrections: string[];
  preferences: string[];
  sessionsScanned: number;
}

function extractLearnings(sessionFiles: string[], opts: CLIOptions): LearningResult {
  const limit = opts.full ? sessionFiles.length : 50;
  const filesToScan = sessionFiles.slice(-limit);

  const corrections: string[] = [];
  const preferences: string[] = [];

  for (const filePath of filesToScan) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n').filter((l: string) => l.trim());

    for (const line of lines) {
      let parsed: SessionLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed JSONL line — skip silently
        continue;
      }

      // Only look at user messages
      if (parsed.role !== 'user' || !parsed.content) continue;

      const msg = parsed.content.trim();
      // Skip very short or very long messages (noise)
      if (msg.length < 4 || msg.length > 500) continue;

      // Check for corrections
      for (const pattern of CORRECTION_PATTERNS) {
        if (pattern.test(msg)) {
          // Deduplicate — skip if we already have something very similar
          const normalized = msg.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          const isDuplicate = corrections.some(c => {
            const cn = c.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
            return cn === normalized || cn.includes(normalized) || normalized.includes(cn);
          });
          if (!isDuplicate) {
            corrections.push(msg);
          }
          break; // One match per message is enough
        }
      }

      // Check for preferences
      for (const pattern of PREFERENCE_PATTERNS) {
        if (pattern.test(msg)) {
          const normalized = msg.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          const isDuplicate = preferences.some(p => {
            const pn = p.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
            return pn === normalized || pn.includes(normalized) || normalized.includes(pn);
          });
          if (!isDuplicate) {
            preferences.push(msg);
          }
          break;
        }
      }
    }
  }

  return {
    corrections,
    preferences,
    sessionsScanned: filesToScan.length,
  };
}

function importSessions(scanResult: ScanResult, opts: CLIOptions): LearningResult | null {
  if (opts.skipSessions || scanResult.sessionFiles.length === 0) {
    return null;
  }

  const result = extractLearnings(scanResult.sessionFiles, opts);

  if (result.corrections.length === 0 && result.preferences.length === 0) {
    info('No corrections or preferences found in sessions');
    return result;
  }

  const destDir = path.join(ROOT, '.partner');
  const destPath = path.join(destDir, 'imported-learnings.md');

  const lines: string[] = [];
  lines.push(`# Imported Learnings from OpenClaw`);
  lines.push(`\n_Extracted from ${result.sessionsScanned} sessions on ${today()}_\n`);

  lines.push(`\n## Corrections (patterns your previous partner was corrected on)\n`);
  if (result.corrections.length > 0) {
    for (const c of result.corrections) {
      // Truncate at 200 chars for readability
      const display = c.length > 200 ? c.slice(0, 197) + '...' : c;
      lines.push(`- ${display}`);
    }
  } else {
    lines.push(`_No correction patterns detected._`);
  }

  lines.push(`\n## Preferences (things you explicitly stated)\n`);
  if (result.preferences.length > 0) {
    for (const p of result.preferences) {
      const display = p.length > 200 ? p.slice(0, 197) + '...' : p;
      lines.push(`- ${display}`);
    }
  } else {
    lines.push(`_No explicit preferences detected._`);
  }

  lines.push('');

  if (!opts.dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destPath, lines.join('\n'), 'utf8');
  }

  return result;
}

// ============================================================================
// Daily notes → memory/daily/
// ============================================================================

interface DailyImportResult {
  imported: number;
  skipped: number;
}

function importDailyNotes(scanResult: ScanResult, opts: CLIOptions): DailyImportResult {
  const result: DailyImportResult = { imported: 0, skipped: 0 };

  if (scanResult.dailyFiles.length === 0) {
    return result;
  }

  const destDir = path.join(ROOT, 'memory', 'daily');

  for (const srcPath of scanResult.dailyFiles) {
    const filename = path.basename(srcPath);
    const destPath = path.join(destDir, filename);

    // Don't overwrite existing daily files
    if (fs.existsSync(destPath)) {
      result.skipped++;
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(srcPath, 'utf8');
    } catch {
      result.skipped++;
      continue;
    }

    const output = `[Imported from OpenClaw]\n\n${content}`;

    if (!opts.dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, output, 'utf8');
    }

    result.imported++;
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const opts = parseArgs(process.argv);

  banner();

  if (opts.dryRun) {
    console.log('  \x1b[33m[DRY RUN]\x1b[0m No files will be written.\n');
  }

  // Verify OpenClaw directory exists
  if (!fs.existsSync(opts.openclawPath)) {
    console.log(`  \x1b[31m\u2717\x1b[0m No OpenClaw installation found at ${opts.openclawPath}.`);
    console.log(`    If your OpenClaw is elsewhere, pass the path as an argument.\n`);
    console.log(`    \x1b[2mExample: npx tsx scripts/tools/consume-openclaw.ts /path/to/.openclaw\x1b[0m\n`);
    process.exit(1);
  }

  // --- Scan ---
  const scanResult = scan(opts.openclawPath);
  reportScan(scanResult, opts);

  // Check if there's anything to import
  const hasAnything = scanResult.soulPath || scanResult.memoryPath ||
    scanResult.sessionFiles.length > 0 || scanResult.dailyFiles.length > 0;

  if (!hasAnything) {
    console.log(`\n  \x1b[33m\u25b8\x1b[0m Nothing to import. The OpenClaw directory exists but is empty.\n`);
    process.exit(0);
  }

  // --- Import ---
  heading('Importing...');

  // 1. SOUL.md → identity/character.md
  if (scanResult.soulPath && !opts.skipSoul) {
    const soulResult = importSoul(scanResult, opts);
    if (soulResult.imported) {
      ok(`SOUL.md \u2192 identity/character.md (${soulResult.sectionCount} sections mapped)`);
    }
  }

  // 2. MEMORY.md → memory/imported/openclaw-memory.md
  if (scanResult.memoryPath) {
    const memImported = importMemory(scanResult, opts);
    if (memImported) {
      ok(`MEMORY.md \u2192 memory/imported/openclaw-memory.md`);
    }
  }

  // 3. Sessions → .partner/imported-learnings.md
  if (!opts.skipSessions && scanResult.sessionFiles.length > 0) {
    const learnings = importSessions(scanResult, opts);
    if (learnings) {
      ok(`Sessions \u2192 .partner/imported-learnings.md (${learnings.corrections.length} corrections, ${learnings.preferences.length} preferences)`);
    }
  }

  // 4. Daily notes → memory/daily/
  if (scanResult.dailyFiles.length > 0) {
    const dailyResult = importDailyNotes(scanResult, opts);
    const skippedNote = dailyResult.skipped > 0
      ? `, ${dailyResult.skipped} skipped \u2014 already exist`
      : '';
    ok(`Daily notes \u2192 memory/daily/ (${dailyResult.imported} files${skippedNote})`);
  }

  // --- Done ---
  console.log(`\n\x1b[36m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\x1b[0m\n`);
  console.log(`  \x1b[1m\x1b[32mDone.\x1b[0m Your partner's history is now part of the Alien Kind architecture.`);
  console.log(`  \x1b[2mThe partnership continues. The ceiling disappears.\x1b[0m\n`);
}

main();
