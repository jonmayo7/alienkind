#!/usr/bin/env npx tsx

/**
 * Alien Kind — Generic Directory Consumption Engine
 *
 * Scans any directory for agent/partner artifacts and imports what it finds
 * into the AlienKind architecture. Works with any agent framework or custom setup.
 *
 * Looks for:
 *   - Identity files (SOUL.md, AGENTS.md, SYSTEM.md, character.md, persona.md, *.md with personality content)
 *   - Memory files (MEMORY.md, memory.md, knowledge.md, facts.md)
 *   - Conversation logs (*.jsonl, *.json with message arrays)
 *   - Daily notes (YYYY-MM-DD.md pattern)
 *   - Config files (config.json, settings.json, .env)
 *
 * Usage:
 *   npx tsx scripts/tools/consume-directory.ts [options] <path>
 *
 * Options:
 *   --dry-run         Show what would be imported without writing
 *   --full            Import ALL conversations (default: last 50 files)
 *   --skip-identity   Don't import identity/personality files
 *   --skip-sessions   Don't mine conversations for learnings
 *   --help            Show this help message
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

// ============================================================================
// CLI
// ============================================================================

interface CLIOptions {
  targetPath: string;
  dryRun: boolean;
  full: boolean;
  skipIdentity: boolean;
  skipSessions: boolean;
}

function parseArgs(argv: string[]): CLIOptions {
  const args = argv.slice(2);
  const opts: CLIOptions = {
    targetPath: '',
    dryRun: false,
    full: false,
    skipIdentity: false,
    skipSessions: false,
  };
  const positional: string[] = [];

  for (const arg of args) {
    switch (arg) {
      case '--dry-run': opts.dryRun = true; break;
      case '--full': opts.full = true; break;
      case '--skip-identity': opts.skipIdentity = true; break;
      case '--skip-sessions': opts.skipSessions = true; break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`\n  \x1b[31m✗\x1b[0m Unknown option: ${arg}\n`);
          printHelp();
          process.exit(1);
        }
        positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error('\n  \x1b[31m✗\x1b[0m Please provide a directory path to scan.\n');
    printHelp();
    process.exit(1);
  }
  opts.targetPath = path.resolve(positional[0]);
  return opts;
}

function printHelp(): void {
  console.log(`
  \x1b[1m\x1b[35m👽 Alien Kind — Directory Consumption Engine\x1b[0m

  Scan any directory for agent/partner artifacts and import them.

  \x1b[1mUsage:\x1b[0m
    npx tsx scripts/tools/consume-directory.ts [options] <path>

  \x1b[1mOptions:\x1b[0m
    --dry-run         Show what would be imported without writing
    --full            Import all conversations (default: last 50 files)
    --skip-identity   Don't import identity/personality files
    --skip-sessions   Don't mine conversations for learnings
    --help            Show this help

  \x1b[1mExamples:\x1b[0m
    npx tsx scripts/tools/consume-directory.ts ~/my-agent
    npx tsx scripts/tools/consume-directory.ts --dry-run /path/to/project
    npx tsx scripts/tools/consume-directory.ts ~/.claude-code
`);
}

// ============================================================================
// Helpers
// ============================================================================

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function ok(msg: string) { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function skip(msg: string) { console.log(`  ${C.yellow}▸${C.reset} ${msg}`); }
function miss(msg: string) { console.log(`  ${C.red}✗${C.reset} ${msg}`); }
function today(): string { return new Date().toISOString().slice(0, 10); }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Scanner — find artifacts by pattern matching, not framework assumptions
// ============================================================================

interface ScanResult {
  identityFiles: Array<{ path: string; name: string; size: number; content: string }>;
  memoryFiles: Array<{ path: string; name: string; size: number; content: string }>;
  conversationFiles: Array<{ path: string; name: string; size: number; format: 'jsonl' | 'json' | 'md' }>;
  dailyNotes: Array<{ path: string; date: string; content: string }>;
  configFiles: Array<{ path: string; name: string }>;
}

const IDENTITY_PATTERNS = [
  'SOUL.md', 'soul.md', 'AGENTS.md', 'agents.md', 'SYSTEM.md', 'system.md',
  'character.md', 'persona.md', 'personality.md', 'identity.md', 'profile.md',
  'CLAUDE.md', 'claude.md',
];

const MEMORY_PATTERNS = [
  'MEMORY.md', 'memory.md', 'knowledge.md', 'facts.md', 'context.md',
  'notes.md', 'learnings.md',
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

function scan(targetPath: string): ScanResult {
  const result: ScanResult = {
    identityFiles: [],
    memoryFiles: [],
    conversationFiles: [],
    dailyNotes: [],
    configFiles: [],
  };

  function walkDir(dir: string, depth: number = 0) {
    if (depth > 3) return; // Don't recurse too deep
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.env') continue;
      if (entry === 'node_modules' || entry === '.git') continue;

      const fullPath = path.join(dir, entry);
      let stat: any;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        walkDir(fullPath, depth + 1);
        continue;
      }

      const lowerEntry = entry.toLowerCase();
      const size = stat.size;

      // Identity files
      if (IDENTITY_PATTERNS.some(p => lowerEntry === p.toLowerCase())) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          result.identityFiles.push({ path: fullPath, name: entry, size, content });
        } catch {}
        continue;
      }

      // Memory files
      if (MEMORY_PATTERNS.some(p => lowerEntry === p.toLowerCase())) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          result.memoryFiles.push({ path: fullPath, name: entry, size, content });
        } catch {}
        continue;
      }

      // Daily notes (YYYY-MM-DD.md)
      if (DATE_PATTERN.test(entry)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const date = entry.replace('.md', '');
          result.dailyNotes.push({ path: fullPath, date, content });
        } catch {}
        continue;
      }

      // Conversation files
      if (entry.endsWith('.jsonl') && size > 0) {
        result.conversationFiles.push({ path: fullPath, name: entry, size, format: 'jsonl' });
        continue;
      }
      if (entry.endsWith('.json') && size > 100) {
        // Check if it's a conversation-shaped JSON (array of messages)
        try {
          const sample = fs.readFileSync(fullPath, 'utf8').slice(0, 500);
          if (sample.includes('"role"') && (sample.includes('"user"') || sample.includes('"assistant"'))) {
            result.conversationFiles.push({ path: fullPath, name: entry, size, format: 'json' });
          }
        } catch {}
        continue;
      }

      // Config files
      if (['config.json', 'settings.json', '.env', 'partner-config.json'].includes(lowerEntry)) {
        result.configFiles.push({ path: fullPath, name: entry });
      }
    }
  }

  walkDir(targetPath);

  // Sort daily notes by date
  result.dailyNotes.sort((a, b) => a.date.localeCompare(b.date));
  // Sort conversations by modification time (most recent last)
  result.conversationFiles.sort((a, b) => {
    try {
      return fs.statSync(a.path).mtimeMs - fs.statSync(b.path).mtimeMs;
    } catch { return 0; }
  });

  return result;
}

// ============================================================================
// Identity import — parse any markdown personality file
// ============================================================================

function importIdentity(files: ScanResult['identityFiles'], opts: CLIOptions): number {
  if (opts.skipIdentity || files.length === 0) return 0;

  const charPath = path.join(ROOT, 'identity', 'character.md');
  if (!fs.existsSync(charPath)) return 0;
  const existing = fs.readFileSync(charPath, 'utf8');
  if (!existing.includes('## How to write this file') && !existing.includes('[Start with one sentence')) {
    skip('identity/character.md already customized — skipping import');
    return 0;
  }

  // Use the largest identity file as the primary source
  const primary = files.sort((a, b) => b.size - a.size)[0];

  // Parse sections from the file
  const sections: Array<{ heading: string; content: string }> = [];
  let currentHeading = '';
  let currentContent: string[] = [];

  for (const line of primary.content.split('\n')) {
    if (line.startsWith('## ') || line.startsWith('# ')) {
      if (currentHeading || currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n').trim() });
      }
      currentHeading = line.replace(/^#+\s*/, '');
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentHeading || currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n').trim() });
  }

  // Map sections to AlienKind identity structure
  const thinkPatterns = /personality|traits?|approach|thinking|behavior|principles?|core/i;
  const speakPatterns = /style|voice|communication|tone|speak|language|format/i;
  const protectPatterns = /rules?|guidelines?|red.?lines?|boundaries|protect|safety|constraints?|never/i;
  const valuePatterns = /values?|beliefs?|philosophy|mission|purpose|priorities/i;

  let howIThink = '';
  let howISpeak = '';
  let whatIProtect = '';
  const unmapped: string[] = [];

  for (const s of sections) {
    if (!s.content) continue;
    const h = s.heading;
    if (thinkPatterns.test(h)) howIThink += (howIThink ? '\n\n' : '') + s.content;
    else if (speakPatterns.test(h)) howISpeak += (howISpeak ? '\n\n' : '') + s.content;
    else if (protectPatterns.test(h)) whatIProtect += (whatIProtect ? '\n\n' : '') + s.content;
    else if (valuePatterns.test(h)) howIThink += (howIThink ? '\n\n' : '') + s.content;
    else if (s.content.length > 20) unmapped.push(s.content);
  }

  // If nothing mapped to specific sections, put everything in "How I think"
  if (!howIThink && !howISpeak && !whatIProtect) {
    howIThink = sections.map(s => s.content).filter(Boolean).join('\n\n');
  }

  // Build character.md
  const partnerName = existing.match(/^# (.+)/)?.[1] || 'Partner';
  const lines = [
    `# ${partnerName}`,
    '',
    `_Imported from ${primary.name} on ${today()}. Edit freely — this is yours now._`,
    '',
    '## How I think',
    '',
    howIThink || '[Imported file had no personality/traits section — fill this in as the partnership develops.]',
    '',
    '## How I speak',
    '',
    howISpeak || '[No communication style found — let this emerge from working together.]',
    '',
    '## What I protect',
    '',
    whatIProtect || '[No rules or boundaries found — add what matters as you discover it.]',
  ];

  if (unmapped.length > 0) {
    lines.push('', '## Other (imported, uncategorized)', '', ...unmapped);
  }

  if (!opts.dryRun) {
    fs.writeFileSync(charPath, lines.join('\n'), 'utf8');
  }
  ok(`${primary.name} → identity/character.md (${sections.length} sections mapped)`);
  return sections.length;
}

// ============================================================================
// Memory import
// ============================================================================

function importMemory(files: ScanResult['memoryFiles'], opts: CLIOptions): number {
  if (files.length === 0) return 0;

  const importDir = path.join(ROOT, 'memory', 'imported');
  let imported = 0;

  for (const file of files) {
    const destName = `imported-${file.name.toLowerCase().replace(/[^a-z0-9.]/g, '-')}`;
    const destPath = path.join(importDir, destName);

    const content = [
      `# Imported from ${file.name}`,
      `_Imported on ${today()} from ${path.dirname(file.path)}_`,
      '',
      file.content,
    ].join('\n');

    if (!opts.dryRun) {
      fs.mkdirSync(importDir, { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');
    }
    ok(`${file.name} → memory/imported/${destName}`);
    imported++;
  }
  return imported;
}

// ============================================================================
// Conversation mining — extract corrections and preferences
// ============================================================================

const CORRECTION_PATTERNS = [
  /^no[,.\s]/i, /^not that/i, /^don'?t\s/i, /^stop\s/i, /^wrong/i,
  /^I said\s/i, /^I meant\s/i, /that'?s not right/i, /^actually[,\s]/i,
  /^please don'?t/i, /never do that/i, /^that'?s wrong/i, /^incorrect/i,
  /not what I (asked|wanted|meant)/i, /^nope/i,
];

const PREFERENCE_PATTERNS = [
  /I prefer\s/i, /always\s(?!have|been|was|will)/i, /never\s(?!mind|been|was)/i,
  /from now on/i, /every time you/i, /don'?t ever\s/i, /make sure (?:you |to )/i,
  /I (?:like|want|need) (?:you to|it when)/i, /use .+ instead of/i,
];

interface LearningResult {
  corrections: string[];
  preferences: string[];
  sessionCount: number;
}

function mineConversations(files: ScanResult['conversationFiles'], opts: CLIOptions): LearningResult {
  if (opts.skipSessions || files.length === 0) return { corrections: [], preferences: [], sessionCount: 0 };

  const limit = opts.full ? files.length : Math.min(50, files.length);
  const toProcess = files.slice(-limit);

  const corrections: string[] = [];
  const preferences: string[] = [];
  const seen = new Set<string>();

  for (const file of toProcess) {
    let messages: Array<{ role: string; content: string }> = [];

    try {
      if (file.format === 'jsonl') {
        const lines = fs.readFileSync(file.path, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { messages.push(JSON.parse(line)); } catch {}
        }
      } else if (file.format === 'json') {
        const raw = JSON.parse(fs.readFileSync(file.path, 'utf8'));
        if (Array.isArray(raw)) messages = raw;
        else if (raw.messages && Array.isArray(raw.messages)) messages = raw.messages;
      }
    } catch { continue; }

    for (const msg of messages) {
      if (msg.role !== 'user' || !msg.content || typeof msg.content !== 'string') continue;
      const text = msg.content.trim();
      if (text.length < 5 || text.length > 500) continue;
      const key = text.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;

      if (CORRECTION_PATTERNS.some(p => p.test(text))) {
        corrections.push(text);
        seen.add(key);
      } else if (PREFERENCE_PATTERNS.some(p => p.test(text))) {
        preferences.push(text);
        seen.add(key);
      }
    }
  }

  return { corrections, preferences, sessionCount: toProcess.length };
}

function importLearnings(result: LearningResult, opts: CLIOptions): void {
  if (result.corrections.length === 0 && result.preferences.length === 0) {
    skip('No corrections or preferences found in conversations');
    return;
  }

  const content = [
    '# Imported Learnings',
    `_Extracted from ${result.sessionCount} conversation files on ${today()}_`,
    '',
    '## Corrections (patterns your previous partner was corrected on)',
    '',
    ...result.corrections.map(c => `- ${c}`),
    '',
    '## Preferences (things you explicitly stated)',
    '',
    ...result.preferences.map(p => `- ${p}`),
  ].join('\n');

  const destPath = path.join(ROOT, '.partner', 'imported-learnings.md');

  if (!opts.dryRun) {
    fs.mkdirSync(path.join(ROOT, '.partner'), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf8');
  }
  ok(`Conversations → .partner/imported-learnings.md (${result.corrections.length} corrections, ${result.preferences.length} preferences)`);
}

// ============================================================================
// Daily notes import
// ============================================================================

function importDailyNotes(notes: ScanResult['dailyNotes'], opts: CLIOptions): { imported: number; skipped: number } {
  if (notes.length === 0) return { imported: 0, skipped: 0 };

  const dailyDir = path.join(ROOT, 'memory', 'daily');
  let imported = 0;
  let skipped = 0;

  for (const note of notes) {
    const destPath = path.join(dailyDir, `${note.date}.md`);
    if (fs.existsSync(destPath)) {
      skipped++;
      continue;
    }

    const content = `[Imported from external agent]\n\n${note.content}`;
    if (!opts.dryRun) {
      fs.mkdirSync(dailyDir, { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');
    }
    imported++;
  }

  if (imported > 0 || skipped > 0) {
    ok(`Daily notes → memory/daily/ (${imported} imported${skipped > 0 ? `, ${skipped} skipped — already exist` : ''})`);
  }
  return { imported, skipped };
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const opts = parseArgs(process.argv);

  console.log(`
${C.cyan}              ___${C.reset}
${C.cyan}          ___/   \\___${C.reset}
${C.cyan}       __/   ${C.dim}'---'${C.reset}${C.cyan}   \\__${C.reset}
${C.cyan}      /    ${C.yellow}*${C.reset}  ${C.green}👽${C.reset}  ${C.yellow}*${C.reset}${C.cyan}     \\${C.reset}
${C.cyan}     /___________________\\${C.reset}
${C.yellow}          /  |  |  \\${C.reset}
${C.yellow}         *   *  *   *${C.reset}

     ${C.bold}${C.magenta}A L I E N   K I N D${C.reset}
  ${C.dim}Directory Consumption Engine${C.reset}
`);

  if (opts.dryRun) {
    console.log(`  ${C.yellow}[DRY RUN]${C.reset} No files will be written.\n`);
  }

  // Validate path
  if (!fs.existsSync(opts.targetPath)) {
    console.error(`  ${C.red}✗${C.reset} Directory not found: ${opts.targetPath}\n`);
    process.exit(1);
  }
  if (!fs.statSync(opts.targetPath).isDirectory()) {
    console.error(`  ${C.red}✗${C.reset} Not a directory: ${opts.targetPath}\n`);
    process.exit(1);
  }

  // Scan
  console.log(`${C.cyan}Scanning ${opts.targetPath}...${C.reset}`);
  const result = scan(opts.targetPath);

  // Report findings
  const totalFound = result.identityFiles.length + result.memoryFiles.length +
    result.conversationFiles.length + result.dailyNotes.length;

  if (totalFound === 0) {
    console.log(`\n  ${C.yellow}No agent artifacts found.${C.reset}`);
    console.log(`  ${C.dim}Looked for: identity files (SOUL.md, character.md, etc.),`);
    console.log(`  memory files, JSONL/JSON conversations, and YYYY-MM-DD.md daily notes.${C.reset}\n`);
    process.exit(0);
  }

  if (result.identityFiles.length > 0) {
    ok(`Found ${result.identityFiles.length} identity file(s): ${result.identityFiles.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ')}`);
  } else {
    miss('No identity files found');
  }

  if (result.memoryFiles.length > 0) {
    ok(`Found ${result.memoryFiles.length} memory file(s): ${result.memoryFiles.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ')}`);
  } else {
    miss('No memory files found');
  }

  if (result.conversationFiles.length > 0) {
    const limit = opts.full ? result.conversationFiles.length : Math.min(50, result.conversationFiles.length);
    ok(`Found ${result.conversationFiles.length} conversation file(s) (importing last ${limit})`);
  } else {
    miss('No conversation files found');
  }

  if (result.dailyNotes.length > 0) {
    ok(`Found ${result.dailyNotes.length} daily note(s)`);
  } else {
    miss('No daily notes found');
  }

  if (result.configFiles.length > 0) {
    skip(`Found ${result.configFiles.length} config file(s) — noted but not imported`);
  }

  // Import
  console.log(`\n${C.cyan}Importing...${C.reset}`);

  const identitySections = importIdentity(result.identityFiles, opts);
  const memoryCount = importMemory(result.memoryFiles, opts);
  const learnings = mineConversations(result.conversationFiles, opts);
  importLearnings(learnings, opts);
  const dailyResult = importDailyNotes(result.dailyNotes, opts);

  // Summary
  console.log(`\n${C.cyan}──────────────────────────────────────────────────${C.reset}`);
  console.log(`\n  ${C.bold}${C.green}Done.${C.reset} Your partner's history is now part of the Alien Kind architecture.`);
  console.log(`  ${C.dim}The partnership continues. The ceiling disappears.${C.reset}\n`);
}

main();
