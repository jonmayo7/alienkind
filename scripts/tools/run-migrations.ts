#!/usr/bin/env npx tsx

/**
 * AlienKind Migration Runner — apply Supabase migrations from config/migrations/.
 *
 * Zero external dependencies. Node.js built-in modules only.
 *
 * Usage:
 *   npx tsx scripts/tools/run-migrations.ts [--url URL] [--key KEY] [--dry-run]
 *
 * Strategy:
 *   1. Try psql if available — direct connection, fastest
 *   2. Fall back to Supabase SQL Editor instructions — concatenate pending
 *      migrations into _pending-combined.sql for the human to paste
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'config', 'migrations');

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
  return fs.readdirSync(MIGRATIONS_DIR).filter((f: string) => f.endsWith('.sql')).sort();
}

function projectRefFromUrl(url: string): string | null {
  // https://abc123.supabase.co → abc123
  const m = url.match(/https?:\/\/([^.]+)\.supabase\.co/);
  return m ? m[1] : null;
}

function tryPsql(url: string, key: string, sqlPath: string, dryRun: boolean): boolean {
  // Supabase pooler connection: postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres
  // The service_role key isn't the DB password — psql needs the actual DB password from Supabase Dashboard → Database → Connection string.
  // For most users, Supabase doesn't expose direct psql access by default.
  // We'll detect psql availability + DATABASE_URL env var; otherwise fall back.
  const psql = spawnSync('which', ['psql']);
  if (psql.status !== 0) return false;

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) return false;

  if (dryRun) {
    info(`Would run: psql against ${dbUrl.replace(/:[^:@]*@/, ':***@')} with file ${path.basename(sqlPath)}`);
    return true;
  }

  const result = spawnSync('psql', [dbUrl, '-f', sqlPath], { stdio: 'inherit' });
  return result.status === 0;
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
  warn('psql not configured — using SQL Editor fallback');
  log('');
  log(`  ${C.bold}Combined SQL written to:${C.reset}`);
  log(`    ${C.cyan}${combinedPath}${C.reset}`);
  log('');
  log(`  ${C.bold}To apply:${C.reset}`);
  log(`    1. Open ${C.cyan}${sqlEditorUrl}${C.reset}`);
  log(`    2. Paste the contents of _pending-combined.sql`);
  log(`    3. Click Run`);
  log('');
  log(`  ${C.dim}(All ${pending.length} migrations are idempotent — re-running them is safe.)${C.reset}`);
  log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const url = args.url || env.SUPABASE_URL;
  const key = args.key || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;

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

  // Try psql first
  let psqlWorked = true;
  for (const m of migrations) {
    const sqlPath = path.join(MIGRATIONS_DIR, m);
    info(`Applying ${m}...`);
    if (!tryPsql(url, key, sqlPath, args.dryRun)) {
      psqlWorked = false;
      break;
    }
    ok(`Applied ${m}`);
  }

  if (!psqlWorked) {
    fallbackPrintInstructions(url, migrations);
    process.exit(0);
  }

  log('');
  ok(`All ${migrations.length} migrations applied`);
}

main().catch((err: any) => {
  fail(err.message || String(err));
  process.exit(1);
});
