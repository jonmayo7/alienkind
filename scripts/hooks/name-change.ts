#!/usr/bin/env node

/**
 * Name Change Hook — PostToolUse (Edit|Write) hook.
 *
 * Detects when the partner's name changes in identity/character.md
 * or CLAUDE.md. When a name change is detected:
 *
 *   1. Updates partner-config.json with the new name
 *   2. Updates CLAUDE.md (replaces old name with new)
 *   3. Updates the shell alias in ~/.zshrc or ~/.bashrc
 *   4. Outputs instructions so the human knows
 *
 * This is tier 1 enforcement — the partner doesn't need to remember
 * to update the alias. The code handles it.
 *
 * Fires on: PostToolUse (Edit, Write)
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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  // Only trigger on edits to identity/character.md or CLAUDE.md
  const filePath = hookData.tool_input?.file_path || hookData.tool_input?.path || '';
  const isCharacter = filePath.endsWith('identity/character.md');
  const isClaudeMd = filePath.endsWith('CLAUDE.md');
  if (!isCharacter && !isClaudeMd) process.exit(0);

  // Read current config to get the stored name
  let config: any = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { process.exit(0); } // no config = not set up yet

  const currentName = config.name || 'Partner';

  // Detect the new name from the edited file
  let newName = '';

  if (isCharacter) {
    // character.md: first H1 is the partner name (e.g., "# Forge")
    try {
      const content = fs.readFileSync(CHARACTER_PATH, 'utf8');
      const h1Match = content.match(/^#\s+(.+)/m);
      if (h1Match) {
        newName = h1Match[1].trim();
      }
    } catch { process.exit(0); }
  } else if (isClaudeMd) {
    // CLAUDE.md: first H1 is the partner name (e.g., "# Forge")
    try {
      const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
      const h1Match = content.match(/^#\s+(.+)/m);
      if (h1Match) {
        newName = h1Match[1].trim();
      }
    } catch { process.exit(0); }
  }

  // Skip if name didn't actually change, or is empty/template
  if (!newName || newName === currentName) process.exit(0);
  if (newName === 'Character' || newName === '{{PARTNER_NAME}}') process.exit(0);
  // Skip template-like names
  if (newName.includes('[') || newName.includes('How to')) process.exit(0);

  // --- Name changed. Propagate everywhere. ---

  const oldName = currentName;
  const aliasOld = (oldName && oldName !== 'Partner')
    ? oldName.toLowerCase().replace(/[^a-z0-9]/g, '')
    : 'alien';
  const aliasNew = newName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'alien';

  // 1. Update partner-config.json
  try {
    config.name = newName;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch { /* best effort */ }

  // 2. Update CLAUDE.md — replace old name with new name throughout
  if (isCharacter) {
    // character.md was edited, so sync CLAUDE.md
    try {
      let claudeMd = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
      if (oldName && oldName !== 'Partner') {
        claudeMd = claudeMd.replace(new RegExp(escapeRegex(oldName), 'g'), newName);
      } else {
        // Replace "Partner" placeholder with actual name
        claudeMd = claudeMd.replace(/^# Partner$/m, `# ${newName}`);
        claudeMd = claudeMd.replace(/\bPartner\b/g, newName);
      }
      fs.writeFileSync(CLAUDE_MD_PATH, claudeMd, 'utf8');
    } catch { /* best effort */ }
  } else if (isClaudeMd) {
    // CLAUDE.md was edited, so sync character.md H1
    try {
      let charContent = fs.readFileSync(CHARACTER_PATH, 'utf8');
      charContent = charContent.replace(/^#\s+.+/m, `# ${newName}`);
      fs.writeFileSync(CHARACTER_PATH, charContent, 'utf8');
    } catch { /* best effort */ }
  }

  // 3. Update shell alias
  if (aliasNew !== aliasOld) {
    const shell = process.env.SHELL || '/bin/zsh';
    const rcFile = shell.includes('zsh')
      ? path.join(os.homedir(), '.zshrc')
      : path.join(os.homedir(), '.bashrc');

    try {
      let rcContent = fs.readFileSync(rcFile, 'utf8');
      // Replace existing Alien Kind alias line
      const aliasPattern = /\n# Alien Kind — talk to your partner\nalias \w+="([^"]*)"\n?/;
      const match = rcContent.match(aliasPattern);
      if (match) {
        let launchCmd = match[1]; // preserve the launch command
        // Ensure git pull is in the alias (may be missing from pre-plugin installs)
        if (!launchCmd.includes('git pull')) {
          launchCmd = launchCmd.replace(/(cd [^&]+&&)\s*/, '$1 git pull --ff-only -q 2>/dev/null; ');
        }
        const newAlias = `\n# Alien Kind — talk to your partner\nalias ${aliasNew}="${launchCmd}"\n`;
        rcContent = rcContent.replace(aliasPattern, newAlias);
        fs.writeFileSync(rcFile, rcContent, 'utf8');
      }
    } catch { /* best effort */ }
  }

  // 4. Output to the human — plain language, lowest common denominator
  console.log('');
  console.log(`  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │  Your partner's name is now: ${newName.padEnd(23)}│`);
  if (aliasNew !== aliasOld) {
    console.log(`  │                                                     │`);
    console.log(`  │  To start a conversation, open any terminal and     │`);
    console.log(`  │  type: ${aliasNew.padEnd(46)}│`);
    console.log(`  │                                                     │`);
    console.log(`  │  (Open a new terminal for the change to take effect)│`);
  }
  console.log(`  └─────────────────────────────────────────────────────┘`);
  console.log('');

  process.exit(0);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch(() => process.exit(0));
