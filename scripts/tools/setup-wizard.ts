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
 *   2. Ask: LLM provider + API key
 *   3. Ask: partner name (or let partner choose)
 *   4. Scaffold .env, partner-config.json, identity/character.md, hooks
 *   5. Run capability status
 *   6. Launch Claude Code (if available) or show next steps
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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
  "53+ days of nightly evolution. Yours starts now.",
  "The partnership is yours to build.",
  "Not another agent. A partner.",
  "The architecture is open. The identity is yours.",
];

// ============================================================================
// Helpers
// ============================================================================

function randomTagline(): string {
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

function prompt(rl: any, question: string, defaultVal?: string): Promise<string> {
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

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.clear();
  console.log(ALIEN_BANNER);
  console.log(`  \x1b[2m${randomTagline()}\x1b[0m\n`);
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // --- Step 1: Provider ---
    const provider = await select(rl, 'Which LLM provider will power your partner?', [
      { label: 'Anthropic (Claude) ← recommended for full hook experience', value: 'anthropic' },
      { label: 'OpenAI (GPT)', value: 'openai' },
      { label: 'OpenRouter (any model)', value: 'openrouter' },
      { label: 'Vercel AI Gateway', value: 'gateway' },
      { label: 'Ollama (local, no API key needed)', value: 'ollama' },
      { label: 'Other OpenAI-compatible endpoint', value: 'custom' },
      { label: 'Skip for now', value: 'skip' },
    ]);

    let apiKey = '';
    let envKeyName = 'ANTHROPIC_API_KEY';

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

      // Check if key already exists in environment
      const existingKey = process.env[envKeyName];
      if (existingKey) {
        const useExisting = await prompt(rl, `Found ${envKeyName} in your environment. Use it? (y/n)`, 'y');
        if (useExisting.toLowerCase() === 'y') {
          apiKey = existingKey;
          console.log(`  \x1b[32m✓\x1b[0m Using existing ${envKeyName}\n`);
        }
      }

      if (!apiKey) {
        apiKey = await prompt(rl, `Paste your ${envKeyName}`);
        if (apiKey) {
          console.log(`  \x1b[32m✓\x1b[0m Key received\n`);
        }
      }
    }

    // --- Step 2: Partner name ---
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

    const nameChoice = await select(rl, 'Your partner needs a name.', [
      { label: "I'll name it", value: 'human' },
      { label: 'Let the partner choose when it wakes up', value: 'partner' },
    ]);

    let partnerName = '';
    if (nameChoice === 'human') {
      partnerName = await prompt(rl, 'What will you call your partner?');
      console.log(`\n  \x1b[32m✓\x1b[0m ${partnerName}. Good name.\n`);
    } else {
      partnerName = 'Partner';
      console.log(`\n  \x1b[32m✓\x1b[0m Your partner will choose its own name. Until then: ${partnerName}.\n`);
    }

    // --- Step 3: Scaffold ---
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('\n  \x1b[1mScaffolding your partnership...\x1b[0m\n');

    // .env
    const envContent = `# Alien Kind — ${partnerName}'s configuration\n${envKeyName}=${apiKey}\n`;
    if (writeIfMissing(path.join(ROOT, '.env'), envContent)) {
      console.log('  \x1b[32m✓\x1b[0m Created .env');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m .env already exists — not overwriting');
    }

    // partner-config.json
    const configSrc = path.join(ROOT, 'partner-config.json.example');
    const configDst = path.join(ROOT, 'partner-config.json');
    if (writeIfMissing(configDst, fs.readFileSync(configSrc, 'utf8'))) {
      console.log('  \x1b[32m✓\x1b[0m Created partner-config.json');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m partner-config.json already exists — not overwriting');
    }

    // Identity kernel — seed character.md with the partner name
    const charPath = path.join(ROOT, 'identity', 'character.md');
    const charTemplate = fs.readFileSync(charPath, 'utf8');
    if (charTemplate.includes('## How to write this file')) {
      // Still a template — seed it with the partner name
      const seeded = `# ${partnerName}\n\n_This is ${partnerName}'s character file. It starts blank because identity emerges from partnership, not prescription. As you work together, corrections become character. Update this file as the partnership deepens._\n\n## How I think\n\n[Start with one sentence. How does ${partnerName} approach problems?]\n\n## How I speak\n\n[Direct? Warm? Concise? Thorough? Let this emerge.]\n\n## What I protect\n\n[What matters enough to enforce?]\n`;
      fs.writeFileSync(charPath, seeded, 'utf8');
      console.log(`  \x1b[32m✓\x1b[0m Seeded identity/character.md for ${partnerName}`);
    } else {
      console.log('  \x1b[33m⚠\x1b[0m identity/character.md already customized — not overwriting');
    }

    // Hooks
    const hookDir = path.join(ROOT, '.claude');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookSrc = path.join(hookDir, 'settings.local.json.example');
    const hookDst = path.join(hookDir, 'settings.local.json');
    if (writeIfMissing(hookDst, fs.readFileSync(hookSrc, 'utf8'))) {
      console.log('  \x1b[32m✓\x1b[0m Activated behavioral enforcement hooks');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m Hooks already configured — not overwriting');
    }

    // --- Step 4: Capability Status ---
    console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

    try {
      const { getCapabilityStatus, formatCapabilityStatus } = require('../lib/portable.ts');
      const status = await getCapabilityStatus();
      console.log(formatCapabilityStatus(status));
    } catch {
      console.log('  \x1b[33m⚠\x1b[0m Could not run capability check — run `npm run status` manually');
    }

    // --- Step 5: Next steps ---
    console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log(`\n  \x1b[1m\x1b[35m👽 ${partnerName} is ready.\x1b[0m\n`);

    if (provider === 'anthropic') {
      console.log('  To talk to your partner:');
      console.log('  \x1b[36m$ claude\x1b[0m          — full hook experience via Claude Code');
      console.log('  \x1b[36m$ npm run chat\x1b[0m    — direct conversation via API\n');
    } else if (provider === 'ollama') {
      console.log('  To talk to your partner:');
      console.log('  Make sure Ollama is running, then:');
      console.log('  \x1b[36m$ npm run chat\x1b[0m\n');
    } else if (provider !== 'skip') {
      console.log('  To talk to your partner:');
      console.log('  \x1b[36m$ npm run chat\x1b[0m\n');
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

    // Auto-launch chat if a provider is configured
    if (provider !== 'skip') {
      const startChat = await prompt(rl, 'Start talking to your partner now? (y/n)', 'y');
      if (startChat.toLowerCase() === 'y') {
        rl.close();
        console.log('\n  \x1b[36mLaunching conversation...\x1b[0m\n');
        const { execSync } = require('child_process');
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
