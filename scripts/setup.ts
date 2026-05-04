#!/usr/bin/env npx tsx

/**
 * setup — first-run wizard.
 *
 * Walks through:
 *   1. Verify .env exists (or copy from .env.example)
 *   2. Verify substrate API key is set
 *   3. Verify Supabase config
 *   4. Auto-run all migrations against the user's Supabase via REST
 *   5. Wire .claude/settings.local.json from the example
 *   6. Wire the nightly identity-sync cron entry
 *   7. Print next steps
 *
 * Idempotent. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const HOOKS_FILE = path.join(ROOT, '.claude', 'settings.local.json');
const HOOKS_EXAMPLE = path.join(ROOT, '.claude', 'settings.local.json.example');
const MIGRATIONS_DIR = path.join(ROOT, 'config', 'migrations');
const CRON_TAG = '# alienkind-identity-sync';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = val;
  }
  return env;
}

function hasSubstrate(env: Record<string, string>): string | null {
  if (env.ANTHROPIC_API_KEY) return 'Anthropic';
  if (env.OPENAI_API_KEY) return 'OpenAI';
  if (env.OPENROUTER_API_KEY) return 'OpenRouter';
  if (env.AI_GATEWAY_API_KEY) return 'AI Gateway';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'Claude Code';
  return null;
}

function hasSupabase(env: Record<string, string>): boolean {
  return !!(env.SUPABASE_URL && (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY));
}

/**
 * Run a SQL string against Supabase via the REST query endpoint.
 * Requires the project to have the `pg-query` RPC or a direct DB connection.
 *
 * Falls back to printing the path if the auto-run fails — Miller (or anyone)
 * can paste manually. We don't fail-closed here because some Supabase tiers
 * restrict raw SQL via REST.
 */
async function runMigration(env: Record<string, string>, sqlPath: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      resolve({ ok: false, reason: 'no SUPABASE_URL or SERVICE_ROLE_KEY' });
      return;
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const target = new URL(`${url}/rest/v1/rpc/exec_sql`);
    const body = JSON.stringify({ query: sql });
    const options = {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(target, options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 204) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, reason: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on('error', (err: any) => resolve({ ok: false, reason: err.message }));
    req.write(body);
    req.end();
  });
}

function wireCron(): { ok: boolean; reason?: string } {
  // Add a cron entry that runs identity-sync-runner.ts at 03:00 daily.
  // Idempotent: if the entry exists, skip.
  try {
    const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    const current = existing.status === 0 ? existing.stdout : '';
    if (current.includes(CRON_TAG)) {
      return { ok: true, reason: 'already wired' };
    }
    const entry = `0 3 * * * cd ${ROOT} && /usr/bin/env -S npx tsx scripts/lib/nightly/identity-sync-runner.ts >> ${ROOT}/logs/identity-sync.log 2>&1 ${CRON_TAG}\n`;
    const newCrontab = current + (current.endsWith('\n') ? '' : '\n') + entry;
    const result = spawnSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    if (result.status === 0) {
      return { ok: true };
    }
    return { ok: false, reason: result.stderr || 'crontab update failed' };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
}

async function main() {
  console.log('\n  \x1b[1m\x1b[32m👽 AlienKind setup\x1b[0m\n');

  // Step 1: .env file
  if (!fs.existsSync(ENV_FILE)) {
    if (!fs.existsSync(ENV_EXAMPLE)) {
      console.log('  \x1b[31m✗\x1b[0m .env.example not found. Repo may be incomplete.\n');
      process.exit(1);
    }
    fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    console.log('  \x1b[32m✓\x1b[0m Created .env from .env.example');
    console.log(`    Edit it: \x1b[36m${ENV_FILE}\x1b[0m\n`);
  } else {
    console.log('  \x1b[32m✓\x1b[0m .env exists');
  }

  const env = loadEnv();

  // Step 2: substrate
  const substrate = hasSubstrate(env);
  if (substrate) {
    console.log(`  \x1b[32m✓\x1b[0m Substrate configured: ${substrate}`);
  } else {
    console.log('  \x1b[33m⚠\x1b[0m No substrate API key set in .env yet.');
    console.log('    Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,');
    console.log('                AI_GATEWAY_API_KEY, CLAUDE_CODE_OAUTH_TOKEN');
    console.log('    Free tier: get an OpenRouter key at https://openrouter.ai (DeepSeek R1 free)');
  }

  // Step 3 + 4: Supabase + migrations
  if (hasSupabase(env)) {
    console.log('  \x1b[32m✓\x1b[0m Supabase configured');

    const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f: string) => f.endsWith('.sql')).sort();
    let autoRanCount = 0;
    let manualPrintCount = 0;
    for (const migration of migrations) {
      const migPath = path.join(MIGRATIONS_DIR, migration);
      const result = await runMigration(env, migPath);
      if (result.ok) {
        console.log(`  \x1b[32m✓\x1b[0m Migration ${migration} applied`);
        autoRanCount++;
      } else {
        console.log(`  \x1b[33m⚠\x1b[0m Migration ${migration} could not auto-run (${result.reason?.slice(0, 80) || 'unknown'})`);
        console.log(`    Paste manually: \x1b[36m${migPath}\x1b[0m`);
        manualPrintCount++;
      }
    }
    if (manualPrintCount > 0) {
      console.log(`    Open: \x1b[36m${env.SUPABASE_URL}\x1b[0m → SQL Editor → New Query → paste each → Run`);
    }
  } else {
    console.log('  \x1b[33m⚠\x1b[0m Supabase not configured.');
    console.log('    Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env');
    console.log('    Free tier: https://supabase.com/dashboard');
  }

  // Step 5: hooks wiring
  if (!fs.existsSync(HOOKS_FILE)) {
    if (fs.existsSync(HOOKS_EXAMPLE)) {
      try { fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true }); } catch {}
      fs.copyFileSync(HOOKS_EXAMPLE, HOOKS_FILE);
      console.log('  \x1b[32m✓\x1b[0m Wired .claude/settings.local.json (5 hooks across 4 events)');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m .claude/settings.local.json.example missing — hooks will not fire');
    }
  } else {
    console.log('  \x1b[32m✓\x1b[0m Hooks already wired (.claude/settings.local.json exists)');
  }

  // Step 6: cron for nightly identity-sync
  const cronResult = wireCron();
  if (cronResult.ok) {
    if (cronResult.reason === 'already wired') {
      console.log('  \x1b[32m✓\x1b[0m Nightly identity-sync cron already wired (03:00 daily)');
    } else {
      console.log('  \x1b[32m✓\x1b[0m Wired nightly identity-sync cron (03:00 daily)');
    }
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m Could not auto-wire cron: ${cronResult.reason}`);
    console.log(`    Add manually:`);
    console.log(`    \x1b[36m0 3 * * * cd ${ROOT} && npx tsx scripts/lib/nightly/identity-sync-runner.ts >> logs/identity-sync.log 2>&1 ${CRON_TAG}\x1b[0m`);
  }

  // Step 7: identity kernel state
  const identityFiles = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
  let templateCount = 0;
  for (const f of identityFiles) {
    const p = path.join(ROOT, 'identity', f);
    try {
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes('## How to write this file')) templateCount++;
    } catch {}
  }
  if (templateCount === 4) {
    console.log('  \x1b[33m⚠\x1b[0m Identity kernel: all 4 files are still templates');
    console.log('    Edit identity/character.md (et al.) — or boot \x1b[36mnpm run chat\x1b[0m');
    console.log('    and let the partner help you write them through conversation');
  } else {
    console.log(`  \x1b[32m✓\x1b[0m Identity kernel: ${4 - templateCount}/4 files customized`);
  }

  // Next steps
  console.log('\n  \x1b[1mNext steps:\x1b[0m\n');
  if (!substrate) {
    console.log('  1. Edit .env, set a substrate key');
    console.log('  2. \x1b[36mnpm run setup\x1b[0m   (re-verify)');
    console.log('  3. \x1b[36mnpm run chat\x1b[0m    (boot your partner)\n');
  } else if (!hasSupabase(env)) {
    console.log('  1. (Optional) Add Supabase to .env for durable memory + nightly evolution');
    console.log('  2. \x1b[36mnpm run chat\x1b[0m    (boot your partner — file fallback works for now)\n');
  } else {
    console.log('  1. \x1b[36mnpm run chat\x1b[0m    (boot your partner)');
    console.log('  2. Talk to it. Correct it when it gets things wrong — corrections persist to learning_ledger.');
    console.log('  3. The nightly identity-sync (03:00) reads recent conversations + corrections and');
    console.log('     rewrites your partner\'s identity kernel based on what it observed.\n');
  }
}

main().catch((err: any) => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}\n`);
  process.exit(1);
});
