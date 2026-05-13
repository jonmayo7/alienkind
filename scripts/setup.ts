#!/usr/bin/env npx tsx

/**
 * AlienKind Setup Wizard — one command to your first partner.
 *
 * Usage:
 *   npm run setup
 *   npx tsx scripts/setup.ts
 *
 * Flow (matches alienkind.ai promise):
 *   0. Preflight — git / Node / Claude Code / gh / psql / PS-policy, offer install for missing
 *   1. Banner + mental-model primer (instance / upstream / origin / Supabase)
 *   2. Path: Claude Code subscription, or AlienKind CLI + API key
 *   3. Provider + key (CLI path only)
 *   4. Partner name
 *   5. GitHub backup — create new private repo / paste existing / skip (origin remote)
 *   6. Supabase (data core — separate from GitHub which is just code/identity)
 *   7. Scaffold .env, partner-config.json, identity, CLAUDE.md, hooks
 *   8. Run migrations
 *   9. Channels (optional)
 *   10. Capability scorecard
 *   11. Shell alias — OS-aware (.zshrc/.bashrc on POSIX, $PROFILE function on Windows)
 *   12. Auto-launch chat
 *
 * Idempotent. Safe to re-run — re-runs detect existing config (origin remote,
 * Supabase env, partner-config.json) and skip or update in place.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { runPreflight } = require('./lib/preflight');

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

/**
 * Read existing wizard outputs so re-runs can skip already-answered questions.
 * Returns whatever it can find from prior runs: partner name, Supabase config,
 * runtime path. Missing files / fields return empty defaults — never throws.
 */
function loadPriorConfig(rootDir: string): {
  partnerName: string;
  supabaseUrl: string;
  supabaseKey: string;
  supabaseDbPassword: string;
} {
  const out = { partnerName: '', supabaseUrl: '', supabaseKey: '', supabaseDbPassword: '' };

  // .env — has Supabase creds + PARTNER_NAME
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k === 'SUPABASE_URL') out.supabaseUrl = v;
      else if (k === 'SUPABASE_SERVICE_ROLE_KEY' || k === 'SUPABASE_SERVICE_KEY' || k === 'SUPABASE_KEY') out.supabaseKey = v;
      else if (k === 'PARTNER_NAME') out.partnerName = v;
      else if (k === 'DATABASE_URL') {
        // postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
        const m = v.match(/postgresql:\/\/postgres:([^@]+)@db\./);
        if (m) { try { out.supabaseDbPassword = decodeURIComponent(m[1]); } catch { out.supabaseDbPassword = m[1]; } }
      }
    }
  }

  // partner-config.json — definitive source of name
  const cfgPath = path.join(rootDir, 'partner-config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && typeof cfg.name === 'string' && cfg.name !== 'Partner' && !out.partnerName) {
        out.partnerName = cfg.name;
      }
    } catch {}
  }

  return out;
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

  // ============ Step 0: Preflight ============
  // Skip with SKIP_PREFLIGHT=1 (e.g. inside CI or bootstrap scripts that already verified).
  if (process.env.SKIP_PREFLIGHT !== '1') {
    console.log('  \x1b[1mChecking your environment...\x1b[0m');
    const { ok } = await runPreflight('fix');
    if (!ok) {
      console.log('\n  \x1b[31m✗\x1b[0m Required tools are still missing. Fix above issues and re-run \x1b[36mnpm run setup\x1b[0m.\n');
      process.exit(1);
    }
    divider();
  }

  // Mental-model primer — shown once at the start so every following step has context.
  // The recurring source of confusion in onboarding has been "where does this go?".
  // Answering it up front collapses the rest of the wizard's decisions.
  console.log('  \x1b[1mHow AlienKind is laid out\x1b[0m\n');
  console.log('  \x1b[36mThis directory\x1b[0m       → your partnership instance. Lives only on this machine.');
  console.log('  \x1b[36mupstream remote\x1b[0m     → the canonical AlienKind architecture. You pull updates from here. You never push.');
  console.log('  \x1b[36morigin remote\x1b[0m       → optional. Your own private GitHub backup of this instance. Configure in step 3.');
  console.log('  \x1b[36mSupabase data core\x1b[0m  → conversations + learning ledger + memory. Your project, your keys. Configure in step 4.\n');
  console.log('  \x1b[2m  Your partner is everything in identity/*.md + the corrections you give it over time.\x1b[0m');
  console.log('  \x1b[2m  The substrate (Claude / OpenAI / local) is rented; the partnership is yours.\x1b[0m\n');
  divider();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Re-run idempotency: load whatever the user already configured. Each prompt
  // below uses these as defaults so re-running the wizard doesn't ask the same
  // questions twice. Empty strings = nothing prior, ask fresh.
  const prior = loadPriorConfig(ROOT);
  if (prior.partnerName || prior.supabaseUrl) {
    console.log(`  \x1b[2m  (detected existing config from a prior run — re-using values as defaults)\x1b[0m\n`);
  }

  let runtimePath = 'claude-code';
  let provider = 'anthropic';
  let envKeyName = 'ANTHROPIC_API_KEY';
  let apiKey = '';
  let partnerName = prior.partnerName || '';
  let supabaseUrl = prior.supabaseUrl || '';
  let supabaseKey = prior.supabaseKey || '';
  let supabaseDbPassword = prior.supabaseDbPassword || '';
  let storageMode = (prior.supabaseUrl && prior.supabaseKey) ? 'supabase' : 'file';

  try {
    // ============ Step 1: Path selection ============
    runtimePath = await select(rl, 'Step 1 — how will you talk to your partner?', [
      { label: 'Claude Code + Anthropic Pro or Max plan (recommended)', value: 'claude-code' },
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
    if (partnerName) {
      console.log(`  \x1b[32m✓\x1b[0m Partner already named: \x1b[36m${partnerName}\x1b[0m`);
      const keep = await ask(rl, 'Keep this name? (y/n)', 'y');
      if (keep.toLowerCase() !== 'y') partnerName = '';
    }
    if (!partnerName) {
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
    }

    // ============ Step 4: GitHub backup (origin remote) ============
    // Placed here, before Supabase, because:
    //   - It depends on partnerName (default repo name = alienkind-{slug}).
    //   - Recurring user instinct is "let me push this" — better to answer
    //     "where does it go?" before the partnership accumulates state.
    //   - Architecture: bootstrap renamed origin → upstream (read-only).
    //     This step optionally adds an 'origin' that points at the user's
    //     OWN private repo. Hardcoded private — never public.
    divider();
    console.log('  \x1b[1mStep 4 — GitHub backup\x1b[0m');
    console.log('  \x1b[2m  Optional. Recommended. Lets you restore on a new machine or sync across devices.\x1b[0m\n');

    const partnerSlug = (partnerName && partnerName !== 'Partner')
      ? partnerName.toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'alien';

    // Detect existing origin (idempotent across wizard re-runs).
    let originUrl = '';
    try {
      const probe = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
      originUrl = (probe.stdout || '').trim();
    } catch {}

    if (originUrl) {
      console.log(`  \x1b[32m✓\x1b[0m origin already configured: \x1b[36m${originUrl}\x1b[0m`);
      console.log('  \x1b[2m  To change: git remote set-url origin <new-url>\x1b[0m\n');
    } else {
      const githubChoice = await select(rl, 'How do you want to back up this partnership?', [
        { label: `Create a new private GitHub repo (uses gh CLI)`, value: 'create' },
        { label: 'I have a repo — paste the URL',                  value: 'existing' },
        { label: 'Local only — skip GitHub for now',               value: 'skip' },
      ]);

      if (githubChoice === 'create') {
        const ghPresent = spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
        if (!ghPresent) {
          console.log('\n  \x1b[33m⚠\x1b[0m gh (GitHub CLI) is not installed.');
          console.log('  \x1b[2m  Install: Mac → brew install gh · Windows → winget install GitHub.cli · Linux → see https://cli.github.com/\x1b[0m');
          console.log('  \x1b[2m  Then re-run \x1b[36mnpm run setup\x1b[0m\x1b[2m or pick "I have a repo" with a manually-created repo URL.\x1b[0m\n');
        } else {
          const authed = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
          if (!authed) {
            console.log('\n  \x1b[36m→\x1b[0m gh is not authenticated. Running \x1b[36mgh auth login\x1b[0m now...');
            console.log('  \x1b[2m  Pick GitHub.com → HTTPS → Login with web browser.\x1b[0m\n');
            try { execSync('gh auth login', { cwd: ROOT, stdio: 'inherit' }); } catch {}
          }
          const repoName = await ask(rl, `Repository name`, `alienkind-${partnerSlug}`);
          console.log(`\n  \x1b[36m→\x1b[0m Creating PRIVATE repo \x1b[36m${repoName}\x1b[0m and pushing current HEAD...\n`);
          try {
            execSync(`gh repo create "${repoName}" --private --source=. --remote=origin --push`, {
              cwd: ROOT,
              stdio: 'inherit',
              timeout: 120000,
            });
            console.log(`\n  \x1b[32m✓\x1b[0m GitHub backup created. \x1b[36morigin\x1b[0m points at your private repo.\n`);
          } catch {
            console.log('\n  \x1b[33m⚠\x1b[0m gh repo create failed. Retry later with:');
            console.log(`  \x1b[36m  gh repo create ${repoName} --private --source=. --remote=origin --push\x1b[0m\n`);
          }
        }
      } else if (githubChoice === 'existing') {
        console.log(`\n  \x1b[2m  Don't have a repo yet? Create one at \x1b[36mhttps://github.com/new\x1b[0m\x1b[2m — set it to Private,\x1b[0m`);
        console.log(`  \x1b[2m  do NOT add a README/license (leave it empty), then paste the URL below.\x1b[0m\n`);
        const repoUrl = await ask(rl, 'GitHub repo URL (e.g. git@github.com:you/alienkind-sceptre.git)');
        if (repoUrl) {
          if (/jonmayo7\/alienkind(?:\.git)?$/i.test(repoUrl)) {
            console.log(`\n  \x1b[31m✗\x1b[0m That's the canonical AlienKind template — use your own private repo instead.\n`);
          } else {
            try {
              execSync(`git remote add origin "${repoUrl}"`, { cwd: ROOT, stdio: 'pipe' });
              console.log(`\n  \x1b[32m✓\x1b[0m origin set to ${repoUrl}`);
              const pushNow = await ask(rl, 'Push current HEAD to origin now? (y/n)', 'y');
              if (pushNow.toLowerCase() === 'y') {
                try {
                  execSync('git push -u origin main', { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
                  console.log(`\n  \x1b[32m✓\x1b[0m Pushed to ${repoUrl}\n`);
                } catch {
                  console.log('\n  \x1b[33m⚠\x1b[0m Push failed. Common causes: auth, non-empty target repo, branch name mismatch.');
                  console.log('  \x1b[2m  Retry with: \x1b[36mgit push -u origin main\x1b[0m\n');
                }
              }
            } catch (e: any) {
              console.log(`\n  \x1b[31m✗\x1b[0m Could not set remote: ${e.message}\n`);
            }
          }
        }
      } else {
        console.log(`\n  \x1b[2m  Local only. Add a backup later: \x1b[36mgit remote add origin <url>\x1b[0m\n`);
      }
    }

    // ============ Step 5: Supabase ============
    divider();
    console.log('  \x1b[1mStep 5 — Persistent memory (Supabase data core)\x1b[0m\n');

    let supaChoice = '';

    // Idempotency: detect prior Supabase config and offer to reuse.
    if (supabaseUrl && supabaseKey) {
      console.log(`  \x1b[32m✓\x1b[0m Existing Supabase config detected:`);
      console.log(`    \x1b[2murl:\x1b[0m  \x1b[36m${supabaseUrl}\x1b[0m`);
      console.log(`    \x1b[2mkey:\x1b[0m  \x1b[36m${supabaseKey.slice(0, 12)}…${supabaseKey.slice(-4)}\x1b[0m`);
      if (supabaseDbPassword) console.log(`    \x1b[2mdb-password:\x1b[0m  \x1b[36m(present)\x1b[0m`);
      console.log('  \x1b[2m  Testing reachability...\x1b[0m');
      const ok = await testSupabase(supabaseUrl, supabaseKey);
      if (ok) {
        console.log('  \x1b[32m✓\x1b[0m REST API reachable\n');
        const reuse = await ask(rl, 'Re-use this Supabase project? (y/n)', 'y');
        if (reuse.toLowerCase() === 'y') {
          storageMode = 'supabase';
          supaChoice = 'reuse';
        } else {
          supabaseUrl = ''; supabaseKey = ''; supabaseDbPassword = ''; storageMode = 'file';
        }
      } else {
        console.log('  \x1b[33m⚠\x1b[0m Existing config unreachable — re-prompting.\n');
        supabaseUrl = ''; supabaseKey = ''; supabaseDbPassword = ''; storageMode = 'file';
      }
    }

    if (!supaChoice) {
      console.log('  Your partner works without Supabase, but conversations save to local files only.');
      console.log('  Supabase unlocks: durable memory, learning ledger, nightly evolution, multi-terminal.');
      console.log('  \x1b[1mFree tier covers everything.\x1b[0m\n');
      supaChoice = await select(rl, 'Set up Supabase?', [
        { label: 'I have a project — enter credentials', value: 'existing' },
        { label: "Create one now — I'll wait (opens supabase.com)", value: 'create' },
        { label: 'Skip — local files only (no nightly evolution)', value: 'skip' },
      ]);
    }

    if (supaChoice === 'create') {
      try {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${openCmd} "https://supabase.com/dashboard" 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
        console.log('\n  \x1b[36m→\x1b[0m Opening supabase.com in your browser...');
      } catch {
        console.log('\n  \x1b[36m→\x1b[0m Go to: \x1b[4mhttps://supabase.com/dashboard\x1b[0m');
      }
      console.log('  \x1b[2m1. Create a new project (any name, any region)\x1b[0m');
      console.log('  \x1b[2m2. WRITE DOWN the database password you set during creation — you need it below\x1b[0m');
      console.log('  \x1b[2m3. Settings → API → copy the Project URL and the service_role key\x1b[0m\n');
      await ask(rl, 'Press enter when ready...');
    }

    if (supaChoice === 'existing' || supaChoice === 'create') {
      supabaseUrl = await ask(rl, 'Supabase Project URL (https://xxx.supabase.co)');
      supabaseKey = await ask(rl, 'Supabase service_role key');

      if (supabaseUrl && supabaseKey) {
        console.log('\n  \x1b[2mTesting REST connection...\x1b[0m');
        const ok = await testSupabase(supabaseUrl, supabaseKey);
        if (ok) {
          console.log('  \x1b[32m✓\x1b[0m REST API reachable\n');
          storageMode = 'supabase';

          // Capture DB password — required for migrations to actually run.
          // (Service role key gives REST access; psql needs the DB password.)
          console.log('  \x1b[1mOne more credential:\x1b[0m');
          console.log('  Migrations apply via psql. We need your database password.');
          console.log('  \x1b[2mFind it: Supabase → Settings → Database → "Database password" (reset if forgotten)\x1b[0m\n');
          supabaseDbPassword = await ask(rl, 'Database password');
          if (!supabaseDbPassword) {
            console.log('  \x1b[33m⚠\x1b[0m No password — migrations will fall back to manual SQL Editor paste.\n');
          }
        } else {
          console.log('  \x1b[31m✗\x1b[0m Connection failed. Check URL + key.');
          console.log('  \x1b[2mContinuing — you can fix .env and re-run setup.\x1b[0m\n');
          supabaseUrl = ''; supabaseKey = '';
        }
      }
    } else {
      console.log('\n  \x1b[33m⚠\x1b[0m Skipping Supabase. Add it later — re-run setup any time.\n');
    }

    // ============ Step 6: Scaffold ============
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

      if (supabaseDbPassword) {
        // Construct DATABASE_URL for psql migrations.
        // Format: postgresql://postgres:<password>@db.<project_ref>.supabase.co:5432/postgres
        const projectRef = supabaseUrl.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1];
        if (projectRef) {
          // URL-encode the password to handle special characters.
          const encodedPassword = encodeURIComponent(supabaseDbPassword);
          const dbUrl = `postgresql://postgres:${encodedPassword}@db.${projectRef}.supabase.co:5432/postgres`;
          envLines.push(`DATABASE_URL=${dbUrl}`);
        }
      }
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

    // Identity kernel — scaffold each file from its .template if missing.
    // identity/*.md are gitignored (user-evolving partnership data);
    // identity/*.md.template are tracked (shipped guidance). Pulling
    // upstream changes templates without ever conflicting with the user's
    // evolved kernel.
    const identityFiles = ['character', 'commitments', 'tenets', 'orientation', 'harness'] as const;
    for (const name of identityFiles) {
      const dst = path.join(ROOT, 'identity', `${name}.md`);
      const src = path.join(ROOT, 'identity', `${name}.md.template`);
      if (fs.existsSync(dst)) {
        console.log(`  \x1b[33m⚠\x1b[0m identity/${name}.md already exists — not overwriting`);
        continue;
      }
      if (!fs.existsSync(src)) {
        console.log(`  \x1b[33m⚠\x1b[0m identity/${name}.md.template missing — skipping`);
        continue;
      }
      const content = fs.readFileSync(src, 'utf8').replace(/\{\{PARTNER_NAME\}\}/g, partnerName);
      fs.writeFileSync(dst, content, 'utf8');
      console.log(`  \x1b[32m✓\x1b[0m Scaffolded identity/${name}.md from template`);
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

    // ============ Step 7: Run migrations ============
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
          console.log('\n  \x1b[33m⚠\x1b[0m Migration runner had issues — you can retry: \x1b[36mnpm run migrate\x1b[0m\n');
        }
      }
    }

    // ============ Step 8: Channels ============
    divider();
    console.log('  \x1b[1mChannels — talk to your partner from anywhere\x1b[0m\n');
    console.log('  Channels let you reach your partner from Telegram, Discord, etc — not just');
    console.log('  the terminal. Each is substrate-agnostic (works with Claude / OpenAI / local).\n');

    const wantChannels = await ask(rl, 'Add a channel now? (y/n)', 'n');
    if (wantChannels.toLowerCase() === 'y') {
      let addAnother = true;
      while (addAnother) {
        try {
          execSync(
            `npx tsx "${path.join(ROOT, 'scripts/tools/add-channel.ts')}"`,
            { cwd: ROOT, stdio: 'inherit' }
          );
        } catch {
          console.log('\n  \x1b[33m⚠\x1b[0m Channel install had issues — you can retry: \x1b[36mnpm run channels\x1b[0m\n');
        }
        const more = await ask(rl, 'Add another channel? (y/n)', 'n');
        addAnother = more.toLowerCase() === 'y';
      }
    } else {
      console.log('  \x1b[2mYou can add channels any time with \x1b[36mnpm run channels\x1b[0m\n');
    }

    // ============ Step 9: Capability scorecard ============
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

    // ============ Step 10: Shell alias ============
    console.log('');
    divider();
    const aliasName = (partnerName && partnerName !== 'Partner')
      ? partnerName.toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'alien';
    const isWin = process.platform === 'win32';

    console.log('  \x1b[1mShortcut\x1b[0m\n');
    console.log(`  Type \x1b[36m${aliasName}\x1b[0m in any terminal to talk to your partner.\n`);

    let aliasWritten = false;
    let aliasTarget = '';
    let aliasCmd = '';

    if (isWin) {
      // Windows: append a function to the PowerShell $PROFILE so `aliasName` works
      // from PowerShell + Windows Terminal. We resolve $PROFILE by asking PowerShell.
      const launchCmd = runtimePath === 'claude-code'
        ? `Set-Location '${ROOT}'; claude`
        : `Set-Location '${ROOT}'; npm run chat`;
      aliasCmd = `function ${aliasName} { ${launchCmd} }`;
      try {
        const profileProbe = spawnSync('powershell', ['-NoProfile', '-Command', '$PROFILE'], { encoding: 'utf8' });
        const profilePath = (profileProbe.stdout || '').trim();
        if (!profilePath) throw new Error('could not resolve $PROFILE');
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
        const cleaned = existing.replace(/\r?\n# AlienKind — talk to your partner\r?\nfunction \w+ \{[^}]*\}\r?\n?/g, '');
        const next = cleaned.trimEnd() + `\r\n\r\n# AlienKind — talk to your partner\r\n${aliasCmd}\r\n`;
        fs.writeFileSync(profilePath, next, 'utf8');
        aliasWritten = true;
        aliasTarget = profilePath;
        console.log(`  \x1b[32m✓\x1b[0m PowerShell function added to $PROFILE`);
        console.log(`  \x1b[2m  (${profilePath})\x1b[0m`);
        console.log(`  \x1b[2m  Open a new PowerShell window, or run: . $PROFILE\x1b[0m`);
      } catch (e: any) {
        console.log(`  \x1b[31m✗\x1b[0m Could not write PowerShell profile (${e.message}). Add this manually to $PROFILE:\n`);
        console.log(`    \x1b[33m${aliasCmd}\x1b[0m`);
      }
    } else {
      // POSIX shells (zsh / bash)
      const shell = process.env.SHELL || '/bin/zsh';
      const rcFile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
      const rcFilePath = rcFile.replace('~', os.homedir());
      const launchCmd = runtimePath === 'claude-code'
        ? `cd ${ROOT} && claude`
        : `cd ${ROOT} && npm run chat`;
      aliasCmd = `alias ${aliasName}="${launchCmd}"`;
      try {
        const existingRc = fs.existsSync(rcFilePath) ? fs.readFileSync(rcFilePath, 'utf8') : '';
        const cleanedRc = existingRc.replace(/\n# AlienKind — talk to your partner\nalias \w+="[^"]*"\n?/g, '');
        const newRc = cleanedRc.trimEnd() + `\n\n# AlienKind — talk to your partner\n${aliasCmd}\n`;
        fs.writeFileSync(rcFilePath, newRc, 'utf8');
        aliasWritten = true;
        aliasTarget = rcFilePath;
        console.log(`  \x1b[32m✓\x1b[0m Shell alias added to ${rcFile}`);
        console.log(`  \x1b[2m  (open a new terminal, or run: source ${rcFile})\x1b[0m`);
      } catch {
        console.log(`  \x1b[31m✗\x1b[0m Could not write to ${rcFile}. Add this manually:\n`);
        console.log(`    \x1b[33m${aliasCmd}\x1b[0m`);
      }
    }
    void aliasWritten; void aliasTarget;

    // ============ Step 11: Auto-launch ============
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
