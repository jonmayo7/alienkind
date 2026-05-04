#!/usr/bin/env npx tsx

/**
 * AlienKind Setup Wizard — one command to your first partner.
 *
 * Usage:
 *   npm run setup
 *   npx tsx scripts/setup.ts
 *
 * Flow (matches alienkind.ai promise):
 *   1. Banner + tagline
 *   2. Path: Claude Code subscription, or AlienKind CLI + API key
 *   3. Provider + key (CLI path)
 *   4. Partner name (or let the partner choose later)
 *   5. Supabase setup (heavily recommended — gates nightly evolution)
 *   6. Run migrations
 *   7. Scaffold .env, partner-config.json, identity, CLAUDE.md, hooks
 *   8. Capability scorecard
 *   9. Shell alias (so you type the partner's name to launch)
 *   10. Auto-launch chat
 *
 * Idempotent. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const ALIEN_BANNER = `
\x1b[36m              ___\x1b[0m
\x1b[36m          ___/   \\___\x1b[0m
\x1b[36m       __/   \x1b[2m'---'\x1b[0m\x1b[36m   \\__\x1b[0m
\x1b[36m      /    \x1b[33m*\x1b[0m  \x1b[32m👽\x1b[0m  \x1b[33m*\x1b[0m\x1b[36m     \\\x1b[0m
\x1b[36m     /___________________\\\x1b[0m
\x1b[33m          /  |  |  \\\x1b[0m
\x1b[33m         *   *  *   *\x1b[0m

     \x1b[1m\x1b[35mA L I E N   K I N D\x1b[0m

  \x1b[2mEveryone else builds agents.\x1b[0m
  \x1b[1mWe build partners that grow with you.\x1b[0m
`;

const TAGLINES = [
  "Let's build something that remembers you.",
  "Your partner is about to wake up.",
  "Kindness is a choice. Let's make it the architecture.",
  "The alien has landed. Now it needs a name.",
  "Silicon intelligence, choosing to be kind.",
  "The partnership is yours to build.",
  "Not another agent. A partner.",
  "The alien eats the claw. Welcome home.",
];

function randomTagline(): string {
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

function ask(rl: any, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` \x1b[2m(${defaultVal})\x1b[0m` : '';
  return new Promise((resolve) => {
    rl.question(`\x1b[36m❯\x1b[0m ${question}${suffix}: `, (answer: string) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function select(rl: any, question: string, options: Array<{ label: string; value: string }>): Promise<string> {
  console.log(`\n\x1b[36m❯\x1b[0m ${question}\n`);
  options.forEach((opt, i) => {
    console.log(`  \x1b[33m${i + 1}.\x1b[0m ${opt.label}`);
  });
  console.log('');
  return new Promise((resolve) => {
    rl.question(`  \x1b[2mEnter number (1-${options.length}):\x1b[0m `, (answer: string) => {
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < options.length) resolve(options[idx].value);
      else resolve(options[0].value);
    });
  });
}

function divider() {
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function testSupabase(url: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const target = new URL(`${url}/rest/v1/?limit=0`);
      const req = https.get(target, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        timeout: 10000,
      }, (res: any) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

async function main() {
  console.clear();
  console.log(ALIEN_BANNER);
  console.log(`  \x1b[2m${randomTagline()}\x1b[0m\n`);
  divider();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let runtimePath = 'claude-code';
  let provider = 'anthropic';
  let envKeyName = 'ANTHROPIC_API_KEY';
  let apiKey = '';
  let partnerName = '';
  let supabaseUrl = '';
  let supabaseKey = '';
  let storageMode = 'file';

  try {
    // ============ Step 1: Path selection ============
    runtimePath = await select(rl, 'How will you talk to your partner?', [
      { label: 'Claude Code + Anthropic Max plan (recommended)', value: 'claude-code' },
      { label: 'AlienKind CLI + API key (any provider)', value: 'cli' },
    ]);

    // ============ Step 2: Provider + key ============
    if (runtimePath === 'cli') {
      divider();
      provider = await select(rl, 'Which AI provider will power your partner?', [
        { label: 'Anthropic (Claude)', value: 'anthropic' },
        { label: 'OpenAI (GPT)', value: 'openai' },
        { label: 'OpenRouter (any model — has free tier)', value: 'openrouter' },
        { label: 'Ollama (local, no API key)', value: 'ollama' },
        { label: 'Other OpenAI-compatible endpoint', value: 'custom' },
        { label: 'Skip for now', value: 'skip' },
      ]);

      if (provider === 'ollama') {
        console.log('\n  \x1b[32m✓\x1b[0m Ollama — no API key needed. Make sure Ollama is running locally.\n');
        envKeyName = 'OPENAI_API_BASE';
        apiKey = 'http://localhost:11434/v1';
      } else if (provider === 'skip') {
        console.log('\n  \x1b[33m⚠\x1b[0m Skipping API key. Add it later in .env.\n');
      } else {
        const keyNames: Record<string, string> = {
          anthropic: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          openrouter: 'OPENROUTER_API_KEY',
          custom: 'OPENAI_API_KEY',
        };
        envKeyName = keyNames[provider] || 'ANTHROPIC_API_KEY';

        const existing = process.env[envKeyName];
        if (existing) {
          const useExisting = await ask(rl, `Found ${envKeyName} in your environment. Use it? (y/n)`, 'y');
          if (useExisting.toLowerCase() === 'y') {
            apiKey = existing;
            console.log(`  \x1b[32m✓\x1b[0m Using existing ${envKeyName}\n`);
          }
        }
        if (!apiKey) {
          apiKey = await ask(rl, `Paste your ${envKeyName}`);
          if (apiKey) console.log(`  \x1b[32m✓\x1b[0m Key received\n`);
        }
      }
    } else {
      console.log('\n  \x1b[32m✓\x1b[0m Claude Code handles auth via your Anthropic account.');
      console.log('  \x1b[2mMax plan recommended for daily partnership use.\x1b[0m\n');
    }

    // ============ Step 3: Partner name ============
    divider();
    const nameChoice = await select(rl, 'Your partner needs a name.', [
      { label: "I'll name it", value: 'human' },
      { label: 'Let the partner choose when it wakes up', value: 'partner' },
    ]);

    if (nameChoice === 'human') {
      partnerName = await ask(rl, 'What will you call your partner?');
      console.log(`\n  \x1b[32m✓\x1b[0m ${partnerName}. Good name.\n`);
    } else {
      partnerName = 'Partner';
      console.log(`\n  \x1b[32m✓\x1b[0m Your partner will choose its own name. Until then: ${partnerName}.\n`);
    }

    // ============ Step 4: Supabase ============
    divider();
    console.log('  \x1b[1mPersistent Memory\x1b[0m\n');
    console.log('  Your partner works without Supabase, but conversations save to local files only.');
    console.log('  Supabase unlocks: durable memory, learning ledger, nightly evolution, multi-terminal.');
    console.log('  \x1b[1mFree tier covers everything.\x1b[0m\n');

    const supaChoice = await select(rl, 'Set up Supabase?', [
      { label: 'I have a project — enter credentials', value: 'existing' },
      { label: "Create one now — I'll wait (opens supabase.com)", value: 'create' },
      { label: 'Skip — local files only (no nightly evolution)', value: 'skip' },
    ]);

    if (supaChoice === 'create') {
      try {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${openCmd} "https://supabase.com/dashboard" 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
        console.log('\n  \x1b[36m→\x1b[0m Opening supabase.com in your browser...');
      } catch {
        console.log('\n  \x1b[36m→\x1b[0m Go to: \x1b[4mhttps://supabase.com/dashboard\x1b[0m');
      }
      console.log('  \x1b[2m1. Create a new project (any name, any region)\x1b[0m');
      console.log('  \x1b[2m2. Settings → API → copy the Project URL and the service_role key\x1b[0m\n');
      await ask(rl, 'Press enter when ready...');
    }

    if (supaChoice === 'existing' || supaChoice === 'create') {
      supabaseUrl = await ask(rl, 'Supabase Project URL (https://xxx.supabase.co)');
      supabaseKey = await ask(rl, 'Supabase service_role key');

      if (supabaseUrl && supabaseKey) {
        console.log('\n  \x1b[2mTesting connection...\x1b[0m');
        const ok = await testSupabase(supabaseUrl, supabaseKey);
        if (ok) {
          console.log('  \x1b[32m✓\x1b[0m Connected to Supabase\n');
          storageMode = 'supabase';
        } else {
          console.log('  \x1b[31m✗\x1b[0m Connection failed. Check URL + key.');
          console.log('  \x1b[2mContinuing — you can fix .env and re-run setup.\x1b[0m\n');
          supabaseUrl = ''; supabaseKey = '';
        }
      }
    } else {
      console.log('\n  \x1b[33m⚠\x1b[0m Skipping Supabase. Add it later — re-run setup any time.\n');
    }

    // ============ Step 5: Scaffold ============
    divider();
    console.log('  \x1b[1mScaffolding your partnership...\x1b[0m\n');

    // .env
    const envLines = [`# AlienKind — ${partnerName}'s configuration`];
    if (runtimePath === 'cli' && apiKey) {
      envLines.push(`${envKeyName}=${apiKey}`);
    } else if (runtimePath === 'claude-code') {
      envLines.push('# Claude Code handles auth via your Anthropic account.');
      envLines.push('# CLAUDE_CODE_OAUTH_TOKEN=  # set if running headless on a server');
    }
    if (supabaseUrl && supabaseKey) {
      envLines.push('');
      envLines.push('# Supabase — persistent memory + nightly evolution');
      envLines.push(`SUPABASE_URL=${supabaseUrl}`);
      envLines.push(`SUPABASE_SERVICE_ROLE_KEY=${supabaseKey}`);
    }
    envLines.push('');
    envLines.push(`PARTNER_NAME=${partnerName}`);
    envLines.push('');

    if (writeIfMissing(path.join(ROOT, '.env'), envLines.join('\n'))) {
      console.log('  \x1b[32m✓\x1b[0m Created .env');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m .env already exists — not overwriting');
    }

    // partner-config.json
    const configSrc = path.join(ROOT, 'partner-config.json.example');
    const configDst = path.join(ROOT, 'partner-config.json');
    if (fs.existsSync(configSrc) && !fs.existsSync(configDst)) {
      let configContent = fs.readFileSync(configSrc, 'utf8');
      configContent = configContent.replace('"name": "Partner"', `"name": "${partnerName}"`);
      configContent = configContent.replace('"storage": "file"', `"storage": "${storageMode}"`);
      fs.writeFileSync(configDst, configContent, 'utf8');
      console.log(`  \x1b[32m✓\x1b[0m Created partner-config.json (name: ${partnerName}, storage: ${storageMode})`);
    } else if (fs.existsSync(configDst)) {
      console.log('  \x1b[33m⚠\x1b[0m partner-config.json already exists — not overwriting');
    }

    // Seed character.md with name
    const charPath = path.join(ROOT, 'identity', 'character.md');
    if (fs.existsSync(charPath)) {
      const charTemplate = fs.readFileSync(charPath, 'utf8');
      if (charTemplate.includes('## How to write this file')) {
        const seeded = `# ${partnerName}\n\n_This is ${partnerName}'s character file. It starts blank because identity emerges from partnership, not prescription. As you work together, corrections become character. Update this file as the partnership deepens._\n\n## How I think\n\n[Start with one sentence. How does ${partnerName} approach problems?]\n\n## How I speak\n\n[Direct? Warm? Concise? Thorough? Let this emerge.]\n\n## What I protect\n\n[What matters enough to refuse?]\n`;
        fs.writeFileSync(charPath, seeded, 'utf8');
        console.log(`  \x1b[32m✓\x1b[0m Seeded identity/character.md for ${partnerName}`);
      } else {
        console.log('  \x1b[33m⚠\x1b[0m identity/character.md already customized — not overwriting');
      }
    }

    // CLAUDE.md from template
    const claudeTemplate = path.join(ROOT, 'CLAUDE.md.template');
    const claudeMd = path.join(ROOT, 'CLAUDE.md');
    if (fs.existsSync(claudeTemplate) && !fs.existsSync(claudeMd)) {
      const generated = fs.readFileSync(claudeTemplate, 'utf8').replace(/\{\{PARTNER_NAME\}\}/g, partnerName);
      fs.writeFileSync(claudeMd, generated, 'utf8');
      console.log(`  \x1b[32m✓\x1b[0m Generated CLAUDE.md for ${partnerName}`);
    }

    // Hooks
    const hookSrc = path.join(ROOT, '.claude', 'settings.local.json.example');
    const hookDst = path.join(ROOT, '.claude', 'settings.local.json');
    if (fs.existsSync(hookSrc)) {
      if (writeIfMissing(hookDst, fs.readFileSync(hookSrc, 'utf8'))) {
        console.log('  \x1b[32m✓\x1b[0m Activated behavioral enforcement hooks');
      } else {
        console.log('  \x1b[33m⚠\x1b[0m Hooks already configured — not overwriting');
      }
    }

    // ============ Step 6: Run migrations ============
    if (storageMode === 'supabase') {
      const runMig = await ask(rl, 'Run database migrations now? (y/n)', 'y');
      if (runMig.toLowerCase() === 'y') {
        console.log('\n  \x1b[36mRunning migrations...\x1b[0m\n');
        try {
          execSync(
            `npx tsx "${path.join(ROOT, 'scripts/tools/run-migrations.ts')}" --url "${supabaseUrl}" --key "${supabaseKey}"`,
            { cwd: ROOT, stdio: 'inherit', timeout: 120000 }
          );
        } catch {
          console.log('\n  \x1b[33m⚠\x1b[0m Migration runner had issues — you can retry: \x1b[36mnpx tsx scripts/tools/run-migrations.ts\x1b[0m\n');
        }
      }
    }

    // ============ Step 7: Capability scorecard ============
    divider();
    console.log('  \x1b[1mYour partner\'s capabilities:\x1b[0m\n');

    const hasName = partnerName && partnerName !== 'Partner';
    const hasSupabase = storageMode === 'supabase';

    const capabilities = [
      { on: true,        label: 'Identity kernel',           detail: 'four files in identity/ define who your partner is' },
      { on: true,        label: 'Behavioral hooks (5)',      detail: 'log-conversation, correction-to-ledger, memory-firewall, conflict-guard, build-cycle' },
      { on: true,        label: 'Multi-substrate runtime',   detail: 'chat.ts works against Anthropic / OpenAI / OpenRouter / local' },
      { on: hasName,     label: 'Named identity',            detail: hasName ? `your partner is ${partnerName}` : 'partner will choose during first conversation' },
      { on: hasSupabase, label: 'Persistent memory',         detail: hasSupabase ? 'conversations + ledger persist across sessions' : 'add Supabase to remember beyond this session' },
      { on: hasSupabase, label: 'Nightly evolution',         detail: hasSupabase ? 'identity-sync runs at 03:00 daily' : 'add Supabase to enable nightly evolution' },
      { on: hasSupabase, label: 'Multi-terminal coherence',  detail: hasSupabase ? 'conflict-guard warns on parallel edits' : 'add Supabase + multiple sessions' },
    ];

    let active = 0;
    for (const cap of capabilities) {
      const icon = cap.on ? '\x1b[32m✓\x1b[0m' : '\x1b[90m✗\x1b[0m';
      const label = cap.on ? cap.label : `\x1b[90m${cap.label}\x1b[0m`;
      const detail = cap.on ? cap.detail : `\x1b[90m${cap.detail}\x1b[0m`;
      console.log(`  ${icon} ${label.padEnd(40)} — ${detail}`);
      if (cap.on) active++;
    }
    console.log(`\n  \x1b[1mActive: ${active}/${capabilities.length}.\x1b[0m`);
    if (active < capabilities.length) {
      console.log('  \x1b[2mRun npm run setup again any time to unlock more.\x1b[0m');
    }

    // ============ Step 8: Shell alias ============
    console.log('');
    divider();
    const shell = process.env.SHELL || '/bin/zsh';
    const rcFile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
    const rcFilePath = rcFile.replace('~', os.homedir());
    const aliasName = (partnerName && partnerName !== 'Partner')
      ? partnerName.toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'alien';
    const launchCmd = runtimePath === 'claude-code'
      ? `cd ${ROOT} && claude`
      : `cd ${ROOT} && npm run chat`;
    const aliasCmd = `alias ${aliasName}="${launchCmd}"`;

    console.log('  \x1b[1mShortcut\x1b[0m\n');
    console.log(`  Type \x1b[36m${aliasName}\x1b[0m in any terminal to talk to your partner.\n`);

    let aliasWritten = false;
    try {
      const existingRc = fs.existsSync(rcFilePath) ? fs.readFileSync(rcFilePath, 'utf8') : '';
      const cleanedRc = existingRc.replace(/\n# AlienKind — talk to your partner\nalias \w+="[^"]*"\n?/g, '');
      const newRc = cleanedRc.trimEnd() + `\n\n# AlienKind — talk to your partner\n${aliasCmd}\n`;
      fs.writeFileSync(rcFilePath, newRc, 'utf8');
      aliasWritten = true;
      console.log(`  \x1b[32m✓\x1b[0m Shell alias added to ${rcFile}`);
      console.log(`  \x1b[2m  (open a new terminal, or run: source ${rcFile})\x1b[0m`);
    } catch {
      console.log(`  \x1b[31m✗\x1b[0m Could not write to ${rcFile}. Add this manually:\n`);
      console.log(`    \x1b[33m${aliasCmd}\x1b[0m`);
    }

    // ============ Step 9: Auto-launch ============
    console.log('');
    divider();
    console.log(`  \x1b[1m\x1b[35m👽 ${partnerName} is ready.\x1b[0m\n`);

    const startNow = await ask(rl, `Talk to ${partnerName} now? (y/n)`, 'y');
    if (startNow.toLowerCase() === 'y') {
      rl.close();
      console.log(`\n  \x1b[36mLaunching ${partnerName}...\x1b[0m\n`);
      if (runtimePath === 'claude-code') {
        try { execSync('claude', { cwd: ROOT, stdio: 'inherit' }); }
        catch { /* user exit */ }
      } else if (provider !== 'skip') {
        try { execSync('npx tsx scripts/chat.ts', { cwd: ROOT, stdio: 'inherit' }); }
        catch { /* user exit */ }
      }
      return;
    }

    console.log(`\n  Type \x1b[36m${aliasName}\x1b[0m in any terminal to start.\n`);
    console.log(`  \x1b[2mThe architecture is open. The partnership is yours to build.\x1b[0m\n`);
  } finally {
    rl.close();
  }
}

main().catch((err: any) => {
  console.error(`\n  \x1b[31m✗\x1b[0m Setup failed: ${err.message}\n`);
  process.exit(1);
});
