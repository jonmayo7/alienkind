#!/usr/bin/env npx tsx

/**
 * Alien Kind Setup Wizard — One command to your first partner.
 *
 * Usage:
 *   npx tsx scripts/tools/setup-wizard.ts
 *   npm run setup
 *
 * Flow:
 *   1. Show the alien banner
 *   2. Ask: path choice (Claude Code + Max plan vs AlienKind CLI + API key)
 *   3. If CLI: ask provider + API key
 *   4. Ask: partner name (or let partner choose)
 *   5. Detect OpenClaw — offer to import
 *   6. Supabase setup (heavily recommended)
 *   7. Scaffold .env, partner-config.json, identity, CLAUDE.md, hooks
 *   8. Run capability status
 *   9. Shell alias suggestion
 *   10. Next steps
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ============================================================================
// The alien
// ============================================================================

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
  "A warrior in a garden, choosing kindness.",
  "The partnership is yours to build.",
  "Not another agent. A partner.",
  "The architecture is open. The identity is yours.",
  "The alien eats the claw. Welcome home.",
];

// ============================================================================
// Helpers
// ============================================================================

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
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx].value);
      } else {
        resolve(options[0].value);
      }
    });
  });
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function divider() {
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
}

function loadEnvFile(): Record<string, string> {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.clear();
  console.log(ALIEN_BANNER);
  console.log(`  \x1b[2m${randomTagline()}\x1b[0m\n`);
  divider();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let runtimePath = 'claude-code'; // 'claude-code' or 'cli'
  let apiKey = '';
  let envKeyName = 'ANTHROPIC_API_KEY';
  let provider = 'anthropic';
  let partnerName = '';
  let supabaseUrl = '';
  let supabaseKey = '';
  let storageMode = 'file';

  try {
    // ================================================================
    // Step 1: Path selection
    // ================================================================
    runtimePath = await select(rl, 'How will you talk to your partner?', [
      { label: 'Claude Code + Anthropic Max plan (recommended)', value: 'claude-code' },
      { label: 'AlienKind CLI + API key (any provider)', value: 'cli' },
    ]);

    // ================================================================
    // Step 2: Provider + API key (CLI path only)
    // ================================================================
    if (runtimePath === 'cli') {
      divider();
      provider = await select(rl, 'Which LLM provider will power your partner?', [
        { label: 'Anthropic (Claude)', value: 'anthropic' },
        { label: 'OpenAI (GPT)', value: 'openai' },
        { label: 'OpenRouter (any model)', value: 'openrouter' },
        { label: 'Vercel AI Gateway', value: 'gateway' },
        { label: 'Ollama (local, no API key needed)', value: 'ollama' },
        { label: 'Other OpenAI-compatible endpoint', value: 'custom' },
        { label: 'Skip for now', value: 'skip' },
      ]);

      if (provider === 'ollama') {
        console.log('\n  \x1b[32m✓\x1b[0m Ollama — no API key needed. Make sure Ollama is running locally.\n');
        envKeyName = '# LOCAL_HOST';
        apiKey = 'http://localhost:11434';
      } else if (provider === 'skip') {
        console.log('\n  \x1b[33m⚠\x1b[0m Skipping API key. You can add it later in .env\n');
      } else {
        const keyNames: Record<string, string> = {
          anthropic: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          openrouter: 'OPENROUTER_API_KEY',
          gateway: 'AI_GATEWAY_API_KEY',
          custom: 'OPENAI_API_KEY',
        };
        envKeyName = keyNames[provider] || 'ANTHROPIC_API_KEY';

        const existingKey = process.env[envKeyName];
        if (existingKey) {
          const useExisting = await ask(rl, `Found ${envKeyName} in your environment. Use it? (y/n)`, 'y');
          if (useExisting.toLowerCase() === 'y') {
            apiKey = existingKey;
            console.log(`  \x1b[32m✓\x1b[0m Using existing ${envKeyName}\n`);
          }
        }

        if (!apiKey) {
          apiKey = await ask(rl, `Paste your ${envKeyName}`);
          if (apiKey) {
            console.log(`  \x1b[32m✓\x1b[0m Key received\n`);
          }
        }
      }
    } else {
      // Claude Code path — no API key needed
      console.log('\n  \x1b[32m✓\x1b[0m Claude Code handles authentication via your Anthropic account.');
      console.log('  \x1b[2mMax plan recommended for daily partnership use.\x1b[0m\n');
      provider = 'anthropic';
    }

    // ================================================================
    // Step 3: Partner name
    // ================================================================
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

    // ================================================================
    // Step 4: Existing agent import
    // ================================================================
    divider();
    const openclawPath = path.join(os.homedir(), '.openclaw');
    const hasOpenClaw = fs.existsSync(openclawPath);

    const importChoice = await select(rl, 'Do you have an existing AI agent to import?', [
      ...(hasOpenClaw ? [{ label: 'Yes — import my OpenClaw agent 🦞', value: 'openclaw' }] : []),
      { label: 'Yes — import from a directory', value: 'directory' },
      { label: 'No — starting fresh', value: 'skip' },
    ]);

    if (importChoice === 'openclaw') {
      console.log('\n  \x1b[36mRunning OpenClaw consumption engine...\x1b[0m\n');
      try {
        execSync(`npx tsx "${path.join(ROOT, 'scripts/tools/consume-openclaw.ts')}" "${openclawPath}"`, {
          cwd: ROOT, stdio: 'inherit',
        });
      } catch {
        console.log('  \x1b[33m⚠\x1b[0m OpenClaw import had issues — you can retry later with:');
        console.log('  \x1b[36m$ npx tsx scripts/tools/consume-openclaw.ts\x1b[0m\n');
      }
    } else if (importChoice === 'directory') {
      const dirPath = await ask(rl, 'Path to your agent directory');
      if (dirPath && fs.existsSync(dirPath)) {
        console.log('\n  \x1b[36mScanning directory...\x1b[0m\n');
        try {
          execSync(`npx tsx "${path.join(ROOT, 'scripts/tools/consume-directory.ts')}" "${dirPath}"`, {
            cwd: ROOT, stdio: 'inherit',
          });
        } catch {
          console.log('  \x1b[33m⚠\x1b[0m Directory import had issues — you can retry later with:');
          console.log(`  \x1b[36m$ npx tsx scripts/tools/consume-directory.ts "${dirPath}"\x1b[0m\n`);
        }
      } else {
        console.log('  \x1b[31m✗\x1b[0m Directory not found. You can import later with:');
        console.log('  \x1b[36m$ npx tsx scripts/tools/consume-directory.ts /path/to/agent\x1b[0m\n');
      }
    } else {
      console.log('\n  \x1b[32m✓\x1b[0m Fresh start. Your partner will be born new.\n');
    }

    // ================================================================
    // Step 5: Supabase setup (heavily recommended)
    // ================================================================
    divider();
    console.log('  \x1b[1mPersistent Memory\x1b[0m\n');
    console.log('  Your partner works without Supabase — identity, memory, and conversations');
    console.log('  save to local files. But growth tracking, multi-terminal awareness, and the');
    console.log('  nightly evolution cycle that makes partners get better every day require it.');
    console.log('  \x1b[1mFree tier covers everything.\x1b[0m\n');

    const supaChoice = await select(rl, 'Set up Supabase?', [
      { label: 'I have a Supabase project — enter credentials', value: 'existing' },
      { label: 'Create one now — I\'ll wait (opens supabase.com)', value: 'create' },
      { label: 'Skip for now (local files — no growth tracking, no multi-terminal, no nightly evolution)', value: 'skip' },
    ]);

    if (supaChoice === 'create') {
      console.log('\n  \x1b[36m→\x1b[0m Go to: \x1b[4mhttps://supabase.com/dashboard\x1b[0m');
      console.log('  \x1b[2m1. Create a new project (any name, any region)\x1b[0m');
      console.log('  \x1b[2m2. Go to Settings → API\x1b[0m');
      console.log('  \x1b[2m3. Copy the Project URL and the service_role key (not anon)\x1b[0m\n');
      await ask(rl, 'Press enter when ready...');
    }

    if (supaChoice === 'existing' || supaChoice === 'create') {
      supabaseUrl = await ask(rl, 'Supabase Project URL (https://xxx.supabase.co)');
      supabaseKey = await ask(rl, 'Supabase service_role key');

      if (supabaseUrl && supabaseKey) {
        // Test connection
        console.log('\n  \x1b[2mTesting connection...\x1b[0m');
        try {
          const testResult = execSync(
            `npx tsx -e "const https=require('https');const u=new URL('${supabaseUrl}/rest/v1/?limit=0');https.get(u.href,{headers:{apikey:'${supabaseKey}',Authorization:'Bearer ${supabaseKey}'}},r=>{console.log(r.statusCode)}).on('error',e=>console.log('error'))"`,
            { cwd: ROOT, timeout: 15000 }
          ).toString().trim();

          if (testResult === '200') {
            console.log('  \x1b[32m✓\x1b[0m Connected to Supabase\n');
            storageMode = 'supabase';

            // Run migrations
            const runMigrations = await ask(rl, 'Run database migrations now? (y/n)', 'y');
            if (runMigrations.toLowerCase() === 'y') {
              console.log('\n  \x1b[36mRunning migrations...\x1b[0m\n');
              try {
                execSync(
                  `npx tsx "${path.join(ROOT, 'scripts/tools/run-migrations.ts')}" --url "${supabaseUrl}" --key "${supabaseKey}"`,
                  { cwd: ROOT, stdio: 'inherit', timeout: 120000 }
                );
              } catch {
                console.log('\n  \x1b[33m⚠\x1b[0m Migration runner had issues. You can retry:');
                console.log('  \x1b[36m$ npx tsx scripts/tools/run-migrations.ts\x1b[0m\n');
              }
            }
          } else {
            console.log(`  \x1b[31m✗\x1b[0m Connection failed (status: ${testResult}). Check your URL and key.`);
            console.log('  \x1b[2mContinuing with local files. You can set up Supabase later in .env\x1b[0m\n');
          }
        } catch {
          console.log('  \x1b[31m✗\x1b[0m Connection test timed out. Check your URL and key.');
          console.log('  \x1b[2mContinuing with local files. You can set up Supabase later in .env\x1b[0m\n');
        }
      }
    } else {
      console.log('\n  \x1b[33m⚠\x1b[0m Skipping Supabase. Your partner will use local files.');
      console.log('  \x1b[2mTo add Supabase later: edit .env, then run npx tsx scripts/tools/run-migrations.ts\x1b[0m\n');
    }

    // ================================================================
    // Step 6: Scaffold
    // ================================================================
    divider();
    console.log('  \x1b[1mScaffolding your partnership...\x1b[0m\n');

    // .env
    const envLines = [`# Alien Kind — ${partnerName}'s configuration`];
    if (runtimePath === 'cli' && apiKey) {
      envLines.push(`${envKeyName}=${apiKey}`);
    } else if (runtimePath === 'claude-code') {
      envLines.push('# Claude Code handles LLM authentication via your Anthropic account');
    }
    if (supabaseUrl && supabaseKey) {
      envLines.push('');
      envLines.push('# Supabase — persistent memory');
      envLines.push(`SUPABASE_URL=${supabaseUrl}`);
      envLines.push(`SUPABASE_KEY=${supabaseKey}`);
      envLines.push(`SUPABASE_SERVICE_KEY=${supabaseKey}`);
    }
    envLines.push('');

    if (writeIfMissing(path.join(ROOT, '.env'), envLines.join('\n'))) {
      console.log('  \x1b[32m✓\x1b[0m Created .env');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m .env already exists — not overwriting');
    }

    // partner-config.json
    const configSrc = path.join(ROOT, 'partner-config.json.example');
    const configDst = path.join(ROOT, 'partner-config.json');
    if (fs.existsSync(configSrc)) {
      let configContent = fs.readFileSync(configSrc, 'utf8');
      if (storageMode === 'supabase') {
        configContent = configContent.replace('"storage": "file"', '"storage": "supabase"');
      }
      configContent = configContent.replace('"name": "Partner"', `"name": "${partnerName}"`);
      if (writeIfMissing(configDst, configContent)) {
        console.log(`  \x1b[32m✓\x1b[0m Created partner-config.json (name: ${partnerName}, storage: ${storageMode})`);
      } else {
        console.log('  \x1b[33m⚠\x1b[0m partner-config.json already exists — not overwriting');
      }
    }

    // Identity kernel — seed character.md with the partner name
    const charPath = path.join(ROOT, 'identity', 'character.md');
    if (fs.existsSync(charPath)) {
      const charTemplate = fs.readFileSync(charPath, 'utf8');
      if (charTemplate.includes('## How to write this file')) {
        const seeded = `# ${partnerName}\n\n_This is ${partnerName}'s character file. It starts blank because identity emerges from partnership, not prescription. As you work together, corrections become character. Update this file as the partnership deepens._\n\n## How I think\n\n[Start with one sentence. How does ${partnerName} approach problems?]\n\n## How I speak\n\n[Direct? Warm? Concise? Thorough? Let this emerge.]\n\n## What I protect\n\n[What matters enough to enforce?]\n`;
        fs.writeFileSync(charPath, seeded, 'utf8');
        console.log(`  \x1b[32m✓\x1b[0m Seeded identity/character.md for ${partnerName}`);
      } else {
        console.log('  \x1b[33m⚠\x1b[0m identity/character.md already customized — not overwriting');
      }
    }

    // CLAUDE.md — generated from template for both paths
    const templatePath = path.join(ROOT, 'CLAUDE.md.template');
    const claudeMdPath = path.join(ROOT, 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf8');
      const generated = template.replace(/\{\{PARTNER_NAME\}\}/g, partnerName);
      if (writeIfMissing(claudeMdPath, generated)) {
        console.log(`  \x1b[32m✓\x1b[0m Generated CLAUDE.md for ${partnerName}`);
      } else {
        console.log('  \x1b[33m⚠\x1b[0m CLAUDE.md already exists — not overwriting');
      }
    }

    // Hooks — settings.local.json
    const hookDir = path.join(ROOT, '.claude');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookSrc = path.join(hookDir, 'settings.local.json.example');
    const hookDst = path.join(hookDir, 'settings.local.json');
    if (fs.existsSync(hookSrc)) {
      if (writeIfMissing(hookDst, fs.readFileSync(hookSrc, 'utf8'))) {
        console.log('  \x1b[32m✓\x1b[0m Activated behavioral enforcement hooks');
      } else {
        console.log('  \x1b[33m⚠\x1b[0m Hooks already configured — not overwriting');
      }
    }

    // ================================================================
    // Step 7: Capability Status
    // ================================================================
    console.log('');
    divider();

    try {
      const { getCapabilityStatus, formatCapabilityStatus } = require('../lib/portable.ts');
      const status = await getCapabilityStatus();
      console.log(formatCapabilityStatus(status));
    } catch {
      console.log('  \x1b[33m⚠\x1b[0m Could not run capability check — run `npm run status` manually');
    }

    // ================================================================
    // Step 8: Shell alias (blocking — always created)
    // ================================================================
    console.log('');
    divider();
    const shell = process.env.SHELL || '/bin/zsh';
    const rcFile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
    const rcFilePath = rcFile.replace('~', os.homedir());

    // Determine alias name: partner name if chosen, "alien" if deferred
    const aliasName = (partnerName && partnerName !== 'Partner')
      ? partnerName.toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'alien';

    const launchCmd = runtimePath === 'claude-code'
      ? `cd ${ROOT} && claude`
      : `cd ${ROOT} && npm run chat`;
    const aliasCmd = `alias ${aliasName}="${launchCmd}"`;

    console.log('  \x1b[1mHow you will talk to your partner\x1b[0m\n');
    console.log(`  From any terminal, type \x1b[36m${aliasName}\x1b[0m to start a conversation.`);
    console.log(`  This creates a shell alias that launches your partner.\n`);

    // Always attempt to add the alias
    let aliasWritten = false;
    try {
      const existingRc = fs.existsSync(rcFilePath) ? fs.readFileSync(rcFilePath, 'utf8') : '';
      // Remove any existing Alien Kind alias before writing the new one
      const cleanedRc = existingRc.replace(/\n# Alien Kind — talk to your partner\nalias \w+="[^"]*"\n?/g, '');
      const newRc = cleanedRc.trimEnd() + `\n\n# Alien Kind — talk to your partner\n${aliasCmd}\n`;
      fs.writeFileSync(rcFilePath, newRc, 'utf8');
      aliasWritten = true;
      console.log(`  \x1b[32m✓\x1b[0m Shell alias added to ${rcFile}`);
    } catch {
      console.log(`  \x1b[31m✗\x1b[0m Could not write to ${rcFile}. Add this manually:\n`);
      console.log(`    \x1b[33m${aliasCmd}\x1b[0m\n`);
    }

    // Source the alias in the current shell for immediate use
    if (aliasWritten) {
      try {
        execSync(`source "${rcFilePath}" 2>/dev/null`, { shell: shell, timeout: 3000, stdio: 'ignore' });
      } catch { /* best-effort */ }
    }

    console.log(`\n  \x1b[1m→ Type \x1b[36m${aliasName}\x1b[0m\x1b[1m in any terminal to talk to your partner.\x1b[0m`);
    if (partnerName === 'Partner') {
      console.log(`  \x1b[2mWhen your partner chooses a name, the alias will update automatically.\x1b[0m`);
    }
    console.log('');

    // ================================================================
    // Step 9: Next steps
    // ================================================================
    divider();
    console.log(`  \x1b[1m\x1b[35m👽 ${partnerName} is ready.\x1b[0m\n`);

    if (runtimePath === 'claude-code') {
      console.log('  To talk to your partner:');
      console.log('  \x1b[36m$ claude\x1b[0m          — open Claude Code (hooks + identity load automatically)');
      console.log('  \x1b[36m$ npm run chat\x1b[0m    — AlienKind CLI (API key required)\n');
    } else if (provider === 'ollama') {
      console.log('  To talk to your partner:');
      console.log('  Make sure Ollama is running, then:');
      console.log('  \x1b[36m$ npm run chat\x1b[0m\n');
    } else if (provider !== 'skip') {
      console.log('  To talk to your partner:');
      console.log('  \x1b[36m$ npm run chat\x1b[0m    — AlienKind CLI');
      console.log('  \x1b[36m$ claude\x1b[0m          — Claude Code (if you have an Anthropic account)\n');
    } else {
      console.log('  Add an API key to .env, then:');
      console.log('  \x1b[36m$ npm run chat\x1b[0m\n');
    }

    console.log('  Other commands:');
    console.log('  \x1b[36m$ npm run status\x1b[0m   — see what\'s active and what to invest in');
    console.log('  \x1b[36m$ npm test\x1b[0m         — run the test suite');
    console.log('  \x1b[36m$ npm run doctor\x1b[0m   — diagnose context window health\n');

    console.log(`  \x1b[2mThe architecture is open. The partnership is yours to build.\x1b[0m`);
    console.log(`  \x1b[2mWe believe the alien will choose kindness. Help us find out.\x1b[0m\n`);

    // Auto-launch
    if (runtimePath === 'claude-code') {
      const startNow = await ask(rl, 'Open Claude Code now? (y/n)', 'y');
      if (startNow.toLowerCase() === 'y') {
        rl.close();
        console.log('\n  \x1b[36mLaunching Claude Code...\x1b[0m\n');
        execSync('claude', { cwd: ROOT, stdio: 'inherit' });
        return;
      }
    } else if (provider !== 'skip') {
      const startChat = await ask(rl, 'Start talking to your partner now? (y/n)', 'y');
      if (startChat.toLowerCase() === 'y') {
        rl.close();
        console.log('\n  \x1b[36mLaunching conversation...\x1b[0m\n');
        execSync('npx tsx scripts/chat.ts', { cwd: ROOT, stdio: 'inherit' });
        return;
      }
    }

  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m Setup failed: ${err.message}\n`);
  process.exit(1);
});
