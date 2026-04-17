#!/usr/bin/env node

/**
 * Context Doctor — Diagnostic tool for Claude Code context window health.
 *
 * Reads the current boot configuration (CLAUDE.md + @imports, hooks, daily
 * file, session state) and reports what's consuming the 1M-token context
 * window. Surfaces the biggest consumers and suggests evictions.
 *
 * This is the Keel equivalent of Letta Code's `context_doctor` skill —
 * a zero-dependency diagnostic that helps operators understand and manage
 * context pressure.
 *
 * Usage:
 *   npx tsx scripts/tools/context-doctor.ts           # full diagnostic
 *   npx tsx scripts/tools/context-doctor.ts --json     # machine-readable output
 *   npx tsx scripts/tools/context-doctor.ts --brief    # one-line summary
 *
 * Readers: interactive sessions, partner operator cycle, memory-checkpoint hook.
 * Writers: stateless — reads file system only.
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CONTEXT_LIMIT_TOKENS = 1_000_000;
// Rough approximation: 1 token ≈ 4 characters for English text.
// Claude's tokenizer varies, but this is close enough for diagnostics.
const CHARS_PER_TOKEN = 4;

interface FileEntry {
  path: string;
  label: string;
  bytes: number;
  tokens: number;
  category: 'identity' | 'boot' | 'daily' | 'state' | 'hook-config';
}

interface HookEntry {
  event: string;
  matcher?: string;
  count: number;
  scripts: string[];
}

interface DiagnosticReport {
  timestamp: string;
  contextLimitTokens: number;
  bootFiles: FileEntry[];
  hooks: HookEntry[];
  totalBootTokens: number;
  totalBootPct: number;
  dailyFileTokens: number;
  dailyFilePct: number;
  suggestions: string[];
  summary: string;
}

function measureFile(filePath: string, label: string, category: FileEntry['category']): FileEntry | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      path: filePath.replace(ALIENKIND_DIR + '/', ''),
      label,
      bytes,
      tokens: Math.ceil(bytes / CHARS_PER_TOKEN),
      category,
    };
  } catch {
    return null;
  }
}

function parseImports(claudeMdPath: string): string[] {
  /** Extract @import paths from CLAUDE.md (e.g., @identity/character.md) */
  try {
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    const imports: string[] = [];
    for (const line of content.split('\n')) {
      const match = line.match(/^@(.+\.md)\s*$/);
      if (match) {
        imports.push(path.resolve(ALIENKIND_DIR, match[1]));
      }
    }
    return imports;
  } catch {
    return [];
  }
}

function parseHooks(settingsPath: string): HookEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks: HookEntry[] = [];
    const hooksConfig = raw.hooks || {};

    for (const [event, groups] of Object.entries(hooksConfig)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups as any[]) {
        const hookList = group.hooks || [group];
        const matcher = group.matcher || undefined;
        const scripts: string[] = [];
        for (const h of hookList) {
          if (h.command) {
            scripts.push(h.command.replace(ALIENKIND_DIR + '/', '').replace('__REPO_ROOT__/', ''));
          }
        }
        if (scripts.length > 0) {
          hooks.push({ event, matcher, count: scripts.length, scripts });
        }
      }
    }
    return hooks;
  } catch {
    return [];
  }
}

function getDailyFilePath(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return path.join(ALIENKIND_DIR, 'memory', 'daily', `${yyyy}-${mm}-${dd}.md`);
}

function generateSuggestions(report: DiagnosticReport): string[] {
  const suggestions: string[] = [];

  // Check if boot cost is high
  if (report.totalBootPct > 12) {
    suggestions.push(
      `Boot files consume ${report.totalBootPct.toFixed(1)}% of context (target: <10%). ` +
      `Consider moving reference material from harness.md to harness-reference.md (loaded on demand).`
    );
  }

  // Check for oversized individual files
  const sortedFiles = [...report.bootFiles].sort((a, b) => b.tokens - a.tokens);
  for (const f of sortedFiles) {
    if (f.tokens > 10000) {
      suggestions.push(
        `${f.label} (${f.path}) is ${(f.tokens / 1000).toFixed(1)}K tokens. ` +
        `Review for sections that could be moved to on-demand reference files.`
      );
    }
  }

  // Check daily file size
  if (report.dailyFileTokens > 8000) {
    suggestions.push(
      `Today's daily file is ${(report.dailyFileTokens / 1000).toFixed(1)}K tokens. ` +
      `Large daily files consume context on every boot. Consider extracting verbose entries ` +
      `(red team analysis, audit reports) to memory/deliberations/ and linking from daily.`
    );
  }

  // Check hook density
  const totalHookScripts = report.hooks.reduce((sum, h) => sum + h.count, 0);
  if (totalHookScripts > 40) {
    suggestions.push(
      `${totalHookScripts} hook scripts registered. Each hook that produces output adds to context. ` +
      `Audit hooks for ones that produce verbose output — consolidate or silence non-essential messages.`
    );
  }

  // Check for Edit-matcher hooks (fire most frequently)
  const editHooks = report.hooks.filter(h => h.matcher?.includes('Edit'));
  const editHookCount = editHooks.reduce((sum, h) => sum + h.count, 0);
  if (editHookCount > 8) {
    suggestions.push(
      `${editHookCount} hooks fire on every Edit call. High-frequency hooks compound context quickly. ` +
      `Review which produce output vs. silently exit 0.`
    );
  }

  if (suggestions.length === 0) {
    suggestions.push('Context budget is healthy. No immediate evictions recommended.');
  }

  return suggestions;
}

function runDiagnostic(): DiagnosticReport {
  const bootFiles: FileEntry[] = [];

  // 1. CLAUDE.md
  const claudeMd = measureFile(path.join(ALIENKIND_DIR, 'CLAUDE.md'), 'CLAUDE.md (operational identity)', 'boot');
  if (claudeMd) bootFiles.push(claudeMd);

  // 2. @imported identity kernel files
  const imports = parseImports(path.join(ALIENKIND_DIR, 'CLAUDE.md'));
  for (const imp of imports) {
    const label = `@import: ${path.basename(imp)}`;
    const entry = measureFile(imp, label, 'identity');
    if (entry) bootFiles.push(entry);
  }

  // 3. Session state
  const sessionState = measureFile(
    'state',
  );
  if (sessionState) bootFiles.push(sessionState);

  // 4. Daily file (loaded at boot)
  const dailyPath = getDailyFilePath();
  const dailyFile = measureFile(dailyPath, `daily file (${path.basename(dailyPath)})`, 'daily');
  if (dailyFile) bootFiles.push(dailyFile);

  // 5. Auto-memory MEMORY.md (loaded by Claude auto-memory system)
  const autoMemory = measureFile(
    '__REPO_ROOT__/.claude-auto/projects/__REPO_ROOT__/memory/MEMORY.md',
    'auto-memory MEMORY.md',
    'state',
  );
  if (autoMemory) bootFiles.push(autoMemory);

  // 6. Hooks
  const settingsPath = path.join(ALIENKIND_DIR, '.claude', 'settings.local.json');
  const hooks = parseHooks(settingsPath);

  // Calculate totals
  const totalBootTokens = bootFiles.reduce((sum, f) => sum + f.tokens, 0);
  const totalBootPct = (totalBootTokens / CONTEXT_LIMIT_TOKENS) * 100;
  const dailyFileTokens = dailyFile?.tokens || 0;
  const dailyFilePct = (dailyFileTokens / CONTEXT_LIMIT_TOKENS) * 100;

  const report: DiagnosticReport = {
    timestamp: new Date().toISOString(),
    contextLimitTokens: CONTEXT_LIMIT_TOKENS,
    bootFiles,
    hooks,
    totalBootTokens,
    totalBootPct,
    dailyFileTokens,
    dailyFilePct,
    suggestions: [],
    summary: '',
  };

  report.suggestions = generateSuggestions(report);
  report.summary =
    `Boot cost: ~${(totalBootTokens / 1000).toFixed(0)}K tokens (${totalBootPct.toFixed(1)}% of 1M). ` +
    `Daily file: ~${(dailyFileTokens / 1000).toFixed(0)}K tokens. ` +
    `${hooks.reduce((s, h) => s + h.count, 0)} hook scripts across ${hooks.length} event groups. ` +
    `${report.suggestions.length} suggestion(s).`;

  return report;
}

function formatReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  lines.push('## Context Doctor — Diagnostic Report');
  lines.push('');

  // Boot files table
  lines.push('### Boot Files (loaded at session start)');
  lines.push('');
  lines.push('| File | Category | Size | Tokens | % of 1M |');
  lines.push('|------|----------|------|--------|---------|');

  const sortedFiles = [...report.bootFiles].sort((a, b) => b.tokens - a.tokens);
  for (const f of sortedFiles) {
    const sizeKb = (f.bytes / 1024).toFixed(1);
    const tokensK = (f.tokens / 1000).toFixed(1);
    const pct = ((f.tokens / CONTEXT_LIMIT_TOKENS) * 100).toFixed(2);
    lines.push(`| ${f.label} | ${f.category} | ${sizeKb} KB | ${tokensK}K | ${pct}% |`);
  }

  lines.push('');
  lines.push(`**Total boot cost:** ~${(report.totalBootTokens / 1000).toFixed(0)}K tokens (${report.totalBootPct.toFixed(1)}% of context)`);
  lines.push('');

  // Hooks table
  lines.push('### Hooks (context-producing lifecycle scripts)');
  lines.push('');
  lines.push('| Event | Matcher | Scripts |');
  lines.push('|-------|---------|---------|');
  for (const h of report.hooks) {
    const matcher = h.matcher || '(all)';
    lines.push(`| ${h.event} | ${matcher} | ${h.count} |`);
  }
  const totalScripts = report.hooks.reduce((s, h) => s + h.count, 0);
  lines.push('');
  lines.push(`**Total hook scripts:** ${totalScripts}`);
  lines.push('');

  // Suggestions
  lines.push('### Suggestions');
  lines.push('');
  for (const s of report.suggestions) {
    lines.push(`- ${s}`);
  }

  return lines.join('\n');
}

// === CLI ===
async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const briefMode = args.includes('--brief');

  const report = runDiagnostic();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (briefMode) {
    process.stdout.write(report.summary + '\n');
  } else {
    process.stdout.write(formatReport(report) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`context-doctor error: ${err?.message || err}\n`);
  process.exit(1);
});

// Export for programmatic use
module.exports = { runDiagnostic, formatReport };
