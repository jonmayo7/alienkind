#!/usr/bin/env node

/**
 * Name Change Hook — PostToolUse (Edit|Write) hook.
 *
 * Detects when the partner's name changes in identity/character.md
 * or CLAUDE.md. When a name change is detected, propagates to:
 *
 *   1. partner-config.json (name field)
 *   2. CLAUDE.md / character.md (sync the other file)
 *   3. Shell alias in the user's shell rc file
 *
 * BLOCKING: if any of the three required steps fails, the hook exits 2
 * with a summary on stderr. Claude Code surfaces the failure; the user
 * fixes and retries. The name does not half-stick.
 *
 * Cross-platform: supports zsh, bash, fish on Unix-like systems and
 * PowerShell on Windows. Unknown shells fall through to a manual
 * instruction and count as a failure (exit 2) because the alias step
 * is required for the name to truly stick.
 *
 * Insert-if-missing: if the shell rc file has no Alien Kind alias block
 * yet (e.g., user edited rc file manually after setup), the hook
 * inserts the block rather than silently skipping.
 *
 * Runtime detection: reads .env — if ANTHROPIC_API_KEY / OPENAI_API_KEY
 * is set, assumes CLI path (Path B). Otherwise claude-code (Path A).
 *
 * Fires on: PostToolUse (Edit, Write).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}

const ROOT = resolveRepoRoot();
const CONFIG_PATH = path.join(ROOT, 'partner-config.json');
const CLAUDE_MD_PATH = path.join(ROOT, 'CLAUDE.md');
const CHARACTER_PATH = path.join(ROOT, 'identity', 'character.md');
const ENV_PATH = path.join(ROOT, '.env');

const ALIAS_MARKER = '# Alien Kind — talk to your partner';

interface StepResult {
  name: string;
  ok: boolean;
  detail?: string;
  error?: string;
  manualFix?: string;
}

interface ShellProfile {
  shell: 'zsh' | 'bash' | 'fish' | 'pwsh' | 'unknown';
  rcFile: string | null;
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData: any;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const filePath: string = hookData.tool_input?.file_path || hookData.tool_input?.path || '';
  const isCharacter = filePath.endsWith('identity/character.md');
  const isClaudeMd = filePath.endsWith('CLAUDE.md');
  if (!isCharacter && !isClaudeMd) process.exit(0);

  // Must have a config — if there isn't one, partner isn't set up and the
  // wizard is the authority, not this hook.
  let config: any = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { process.exit(0); }

  const oldName: string = config.name || 'Partner';

  // Read the new name from the file that was edited.
  const sourcePath = isCharacter ? CHARACTER_PATH : CLAUDE_MD_PATH;
  let newName = '';
  try {
    const content = fs.readFileSync(sourcePath, 'utf8');
    const h1Match = content.match(/^#\s+(.+)/m);
    if (h1Match) newName = h1Match[1].trim();
  } catch {
    // If we can't even read the file, nothing to do — skip silently.
    process.exit(0);
  }

  // No H1, unchanged, or placeholder — nothing to propagate.
  if (!newName) process.exit(0);
  if (newName === oldName) process.exit(0);
  const UNSUBSTITUTED_PLACEHOLDER = /^\{\{[A-Z_]+\}\}$/;
  if (newName === 'Character' || UNSUBSTITUTED_PLACEHOLDER.test(newName)) process.exit(0);
  if (newName.includes('[') || /^How to/i.test(newName)) process.exit(0);

  // Name actually changed. Run the three required steps.
  const aliasOld = slugifyAlias(oldName);
  const aliasNew = slugifyAlias(newName);
  const runtime = detectRuntime();
  const launchCmd = buildLaunchCmd(ROOT, runtime);

  // Snapshot original config so we can roll back if any step fails.
  // Without rollback, config.name lands but a failed markdown sync
  // leaves CLAUDE.md stale — retry would see oldName===newName and skip.
  const originalConfigJson = (() => {
    try { return fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { return null; }
  })();

  const results: StepResult[] = [];

  // --- Step 1: partner-config.json ---
  results.push(runStep('partner-config.json', () => {
    config.name = newName;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return `name: ${oldName} → ${newName}`;
  }));

  // --- Step 2: sync the sibling markdown file ---
  results.push(runStep('markdown sync', () => {
    if (isCharacter) {
      let claudeMd = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
      if (oldName && oldName !== 'Partner') {
        claudeMd = claudeMd.replace(new RegExp(escapeRegex(oldName), 'g'), newName);
      } else {
        claudeMd = claudeMd.replace(/^# Partner$/m, `# ${newName}`);
        claudeMd = claudeMd.replace(/\bPartner\b/g, newName);
      }
      fs.writeFileSync(CLAUDE_MD_PATH, claudeMd, 'utf8');
      return 'CLAUDE.md synced from character.md';
    } else {
      let charContent = fs.readFileSync(CHARACTER_PATH, 'utf8');
      charContent = charContent.replace(/^#\s+.+/m, `# ${newName}`);
      fs.writeFileSync(CHARACTER_PATH, charContent, 'utf8');
      return 'character.md synced from CLAUDE.md';
    }
  }));

  // --- Step 3: shell alias (cross-platform, upsert) ---
  if (aliasNew === aliasOld) {
    results.push({ name: 'shell alias', ok: true, detail: 'unchanged (same slug)' });
  } else {
    const profile = detectShellProfile();
    if (profile.shell === 'unknown' || !profile.rcFile) {
      results.push({
        name: 'shell alias',
        ok: false,
        error: 'could not detect a supported shell (zsh/bash/fish/PowerShell)',
        manualFix: `Add this to your shell rc file manually:\n    alias ${aliasNew}="${launchCmd}"`,
      });
    } else {
      const r = runStep('shell alias', () => {
        const action = upsertAlias(profile.rcFile!, profile.shell, aliasNew, launchCmd);
        return `${action} in ${profile.rcFile} (${profile.shell})`;
      });
      if (!r.ok) {
        r.manualFix = `Add this to ${profile.rcFile} manually:\n    ${buildAliasBlock(profile.shell, aliasNew, launchCmd)}`;
      }
      results.push(r);
    }
  }

  // --- Aggregate ---
  const failures = results.filter(r => !r.ok);
  if (failures.length > 0) {
    // Roll back config.name so the next Edit/Write re-triggers the cascade.
    // Without this, oldName===newName on retry and the hook exits silent,
    // leaving the markdown/alias drift in place permanently.
    if (originalConfigJson !== null) {
      try { fs.writeFileSync(CONFIG_PATH, originalConfigJson, 'utf8'); } catch { /* best-effort rollback */ }
    }

    process.stderr.write('\n');
    process.stderr.write('name-change hook FAILED — the partner\'s name did not fully land.\n\n');
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗';
      const tail = r.error ? `: ${r.error}` : (r.detail ? ` (${r.detail})` : '');
      process.stderr.write(`  ${mark} ${r.name}${tail}\n`);
    }
    process.stderr.write('\n');
    for (const r of failures) {
      if (r.manualFix) {
        process.stderr.write(`Manual fix for "${r.name}":\n${r.manualFix}\n\n`);
      }
    }
    process.stderr.write(`Partner name is in transition (old: "${oldName}", requested: "${newName}"). Fix the failed step(s), then re-save the file to re-trigger this hook.\n\n`);
    process.exit(2);
  }

  // --- Success banner (kept minimal — the partner itself tells the user)
  console.log('');
  console.log(`  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │  Your partner's name is now: ${newName.padEnd(23)}│`);
  if (aliasNew !== aliasOld) {
    console.log(`  │                                                     │`);
    console.log(`  │  Open a new terminal and type: ${aliasNew.padEnd(21)}│`);
  }
  console.log(`  └─────────────────────────────────────────────────────┘`);
  console.log('');

  process.exit(0);
}

// --------------------------------------------------------------------------
// Step runner
// --------------------------------------------------------------------------

function runStep(name: string, fn: () => string): StepResult {
  try {
    const detail = fn();
    return { name, ok: true, detail };
  } catch (e: any) {
    return { name, ok: false, error: e?.message || String(e) };
  }
}

// --------------------------------------------------------------------------
// Name slugification — same rule everywhere
// --------------------------------------------------------------------------

function slugifyAlias(name: string): string {
  if (!name || name === 'Partner') return 'alien';
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug || 'alien';
}

// --------------------------------------------------------------------------
// Runtime detection — .env scan
// --------------------------------------------------------------------------

function detectRuntime(): 'claude-code' | 'cli' {
  try {
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    if (/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY)\s*=\s*\S+/m.test(env)) {
      return 'cli';
    }
  } catch { /* no .env = default */ }
  return 'claude-code';
}

function buildLaunchCmd(root: string, runtime: 'claude-code' | 'cli'): string {
  if (runtime === 'cli') {
    return `cd ${root} && git pull --ff-only -q 2>/dev/null; npm run chat`;
  }
  return `cd ${root} && git pull --ff-only -q 2>/dev/null; claude`;
}

// --------------------------------------------------------------------------
// Shell detection
// --------------------------------------------------------------------------

function detectShellProfile(): ShellProfile {
  const home = os.homedir();

  if (process.platform === 'win32') {
    const docs = path.join(process.env.USERPROFILE || home, 'Documents');
    const psProfile = path.join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    return { shell: 'pwsh', rcFile: psProfile };
  }

  const shellPath = process.env.SHELL || '';
  if (shellPath.includes('zsh')) return { shell: 'zsh', rcFile: path.join(home, '.zshrc') };
  if (shellPath.includes('bash')) return { shell: 'bash', rcFile: path.join(home, '.bashrc') };
  if (shellPath.includes('fish')) return { shell: 'fish', rcFile: path.join(home, '.config', 'fish', 'config.fish') };

  // SHELL env missing or exotic — probe filesystem
  const candidates: ShellProfile[] = [
    { shell: 'zsh',  rcFile: path.join(home, '.zshrc') },
    { shell: 'bash', rcFile: path.join(home, '.bashrc') },
    { shell: 'fish', rcFile: path.join(home, '.config', 'fish', 'config.fish') },
  ];
  for (const c of candidates) {
    if (c.rcFile && fs.existsSync(c.rcFile)) return c;
  }

  return { shell: 'unknown', rcFile: null };
}

// --------------------------------------------------------------------------
// Alias upsert — insert if missing, update in place if present
// --------------------------------------------------------------------------

function upsertAlias(rcFile: string, shell: ShellProfile['shell'], aliasName: string, launchCmd: string): 'inserted' | 'updated' | 'unchanged' {
  // Ensure parent directory exists (fish ~/.config/fish, Windows Documents/PowerShell/)
  fs.mkdirSync(path.dirname(rcFile), { recursive: true });

  const existing = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  const block = buildAliasBlock(shell, aliasName, launchCmd);

  if (existing.includes(ALIAS_MARKER)) {
    // Strip any existing Alien Kind block(s) — marker line + following line.
    // The marker line + one command line is the shape we always write.
    const stripped = existing.replace(
      /\n?# Alien Kind — talk to your partner\n[^\n]*\n?/g,
      ''
    );
    const updated = stripped.trimEnd() + '\n\n' + block + '\n';
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(rcFile, updated, 'utf8');
    return 'updated';
  }

  // Insert
  const updated = existing.trimEnd() + (existing ? '\n\n' : '') + block + '\n';
  fs.writeFileSync(rcFile, updated, 'utf8');
  return 'inserted';
}

function buildAliasBlock(shell: ShellProfile['shell'], aliasName: string, launchCmd: string): string {
  if (shell === 'pwsh') {
    // PowerShell uses a function (aliases can only alias single commands)
    const psCmd = launchCmd
      .replace(/^cd\s+/, 'Set-Location ')
      .replace(/&&/g, ';')
      .replace(/2>\/dev\/null/g, '2>$null');
    return `${ALIAS_MARKER}\nfunction ${aliasName} { ${psCmd} }`;
  }
  if (shell === 'fish') {
    return `${ALIAS_MARKER}\nalias ${aliasName} '${launchCmd}'`;
  }
  // zsh / bash
  return `${ALIAS_MARKER}\nalias ${aliasName}="${launchCmd}"`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((e) => {
  process.stderr.write(`\nname-change hook crashed unexpectedly: ${e?.message || e}\n`);
  process.exit(2);
});
