#!/usr/bin/env npx tsx

/**
 * AlienKind Migration Runner — apply Supabase migrations from config/migrations/.
 *
 * Zero external runtime dependencies. Auto-installs `postgresql-client` on
 * Linux if missing.
 *
 * Usage:
 *   npx tsx scripts/tools/run-migrations.ts [--url URL] [--key KEY] [--dry-run]
 *
 * Strategy:
 *   1. Read DATABASE_URL from .env (set by setup wizard from your DB password)
 *   2. Auto-install psql via apt-get if on Linux + missing
 *   3. Run each migration via psql
 *   4. Verify the expected tables exist via REST API
 *   5. Fall back to SQL Editor instructions only if everything above fails
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'config', 'migrations');
const EXPECTED_TABLES = ['conversations', 'learning_ledger', 'consciousness_entries'];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function log(msg: string) { console.log(msg); }
function info(msg: string) { console.log(`${C.cyan}[info]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`${C.green}[ok]${C.reset}   ${msg}`); }
function warn(msg: string) { console.log(`${C.yellow}[warn]${C.reset} ${msg}`); }
function fail(msg: string) { console.error(`${C.red}[fail]${C.reset} ${msg}`); }

function loadEnv(): Record<string, string> {
  const envPath = path.join(ROOT, '.env');
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function parseArgs(argv: string[]): { url?: string; key?: string; dryRun: boolean } {
  const args: any = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) { args.url = argv[++i]; }
    else if (argv[i] === '--key' && argv[i + 1]) { args.key = argv[++i]; }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
  }
  return args;
}

function listMigrations(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort();
}

function projectRefFromUrl(url: string): string | null {
  const m = url.match(/https?:\/\/([^.]+)\.supabase\.co/);
  return m ? m[1] : null;
}

function isPsqlAvailable(): boolean {
  return spawnSync('which', ['psql']).status === 0;
}

function autoInstallPsql(): boolean {
  if (process.platform !== 'linux') return false;
  if (spawnSync('which', ['apt-get']).status !== 0) return false;

  info('psql not installed — installing postgresql-client via apt-get...');
  const result = spawnSync('apt-get', ['install', '-y', 'postgresql-client'], {
    stdio: 'inherit',
    timeout: 120000,
  });
  if (result.status === 0) {
    ok('postgresql-client installed');
    return isPsqlAvailable();
  }
  return false;
}

function runMigrationViaPsql(dbUrl: string, sqlPath: string, dryRun: boolean): boolean {
  if (dryRun) {
    info(`Would run: psql ${dbUrl.replace(/:[^:@]*@/, ':***@')} -f ${path.basename(sqlPath)}`);
    return true;
  }
  const result = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
    stdio: 'inherit',
  });
  return result.status === 0;
}

function verifyTablesExist(url: string, key: string): Promise<{ exists: string[]; missing: string[] }> {
  return new Promise((resolve) => {
    const target = new URL(`${url}/rest/v1/?limit=0`);
    const exists: string[] = [];
    const missing: string[] = [];

    let pending = EXPECTED_TABLES.length;
    for (const tbl of EXPECTED_TABLES) {
      const t = new URL(`${url}/rest/v1/${tbl}?limit=0`);
      const req = https.get(t, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        timeout: 10000,
      }, (res: any) => {
        if (res.statusCode === 200) exists.push(tbl);
        else missing.push(tbl);
        res.resume();
        if (--pending === 0) resolve({ exists, missing });
      });
      req.on('error', () => {
        missing.push(tbl);
        if (--pending === 0) resolve({ exists, missing });
      });
      req.on('timeout', () => {
        req.destroy();
        missing.push(tbl);
        if (--pending === 0) resolve({ exists, missing });
      });
    }
  });
}

function fallbackPrintInstructions(url: string, pending: string[]): void {
  const ref = projectRefFromUrl(url);
  const sqlEditorUrl = ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard';

  const combinedPath = path.join(MIGRATIONS_DIR, '_pending-combined.sql');
  const combined = pending
    .map((f: string) => `-- ============================================================\n-- ${f}\n-- ============================================================\n\n${fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')}`)
    .join('\n\n');
  fs.writeFileSync(combinedPath, combined, 'utf8');

  log('');
  warn('Could not run migrations automatically — using SQL Editor fallback');
  log('');
  log(`  ${C.bold}Combined SQL written to:${C.reset}`);
  log(`    ${C.cyan}${combinedPath}${C.reset}`);
  log('');
  log(`  ${C.bold}To apply:${C.reset}`);
  log(`    1. Open ${C.cyan}${sqlEditorUrl}${C.reset}`);
  log(`    2. Paste the contents of _pending-combined.sql`);
  log(`    3. Click Run`);
  log(`    4. Re-run \`npm run setup\` to verify tables exist.`);
  log('');
  log(`  ${C.dim}(All ${pending.length} migrations are idempotent — re-running is safe.)${C.reset}`);
  log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const url = args.url || env.SUPABASE_URL;
  const key = args.key || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;
  const dbUrl = env.DATABASE_URL || env.SUPABASE_DB_URL;

  if (!url || !key) {
    fail('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (in .env or via --url / --key)');
    process.exit(1);
  }

  const migrations = listMigrations();
  if (migrations.length === 0) {
    warn('No migrations found in config/migrations/');
    return;
  }

  log('');
  info(`Found ${migrations.length} migration(s) in ${MIGRATIONS_DIR}`);

  // Try psql path
  let psqlWorked = false;
  if (dbUrl) {
    let psqlReady = isPsqlAvailable();
    if (!psqlReady) {
      psqlReady = autoInstallPsql();
    }

    if (psqlReady) {
      psqlWorked = true;
      for (const m of migrations) {
        const sqlPath = path.join(MIGRATIONS_DIR, m);
        info(`Applying ${m}...`);
        if (!runMigrationViaPsql(dbUrl, sqlPath, args.dryRun)) {
          psqlWorked = false;
          fail(`Migration ${m} failed`);
          break;
        }
        ok(`Applied ${m}`);
      }
    } else {
      warn('psql not available and could not auto-install');
    }
  } else {
    warn('No DATABASE_URL in .env — re-run setup wizard to capture your DB password');
  }

  // Verify regardless of which path ran (catches "wizard said success but tables missing")
  if (!args.dryRun) {
    log('');
    info('Verifying expected tables exist via REST API...');
    const verified = await verifyTablesExist(url, key);
    if (verified.exists.length === EXPECTED_TABLES.length) {
      ok(`All ${EXPECTED_TABLES.length} tables present: ${verified.exists.join(', ')}`);
      log('');
      ok(`Migrations complete.`);
      return;
    } else {
      warn(`${verified.missing.length} table(s) missing: ${verified.missing.join(', ')}`);
      if (psqlWorked) {
        fail('Migrations claimed success but tables are missing — check psql output above');
      }
      fallbackPrintInstructions(url, migrations);
      process.exit(1);
    }
  }
}

main().catch((err: any) => {
  fail(err.message || String(err));
  process.exit(1);
});
