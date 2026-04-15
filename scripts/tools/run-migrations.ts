#!/usr/bin/env npx tsx

/**
 * AlienKind Migration Runner — Apply Supabase migrations from config/migrations/
 *
 * Zero external dependencies. Node.js built-in modules only.
 *
 * Usage:
 *   npx tsx scripts/tools/run-migrations.ts [options]
 *
 * Options:
 *   --dry-run       Show what would be applied without executing
 *   --sql-editor    Force SQL Editor mode (skip psql detection)
 *   --url URL       Supabase URL (or reads SUPABASE_URL from .env)
 *   --key KEY       Service role key (or reads SUPABASE_SERVICE_KEY / SUPABASE_KEY from .env)
 *
 * Execution strategies:
 *   1. psql (preferred) — detects psql on PATH, connects directly
 *   2. SQL Editor fallback — concatenates pending SQL into _pending-combined.sql
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'config', 'migrations');

// ============================================================================
// ANSI helpers
// ============================================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(msg: string) { console.log(msg); }
function info(msg: string) { console.log(`${C.cyan}[info]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`${C.green}[ok]${C.reset}   ${msg}`); }
function warn(msg: string) { console.log(`${C.yellow}[warn]${C.reset} ${msg}`); }
function fail(msg: string) { console.error(`${C.red}[fail]${C.reset} ${msg}`); }

// ============================================================================
// .env parser — zero dependencies
// ============================================================================

function loadEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return env;
  const lines: string[] = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ============================================================================
// CLI argument parsing
// ============================================================================

interface CliArgs {
  dryRun: boolean;
  sqlEditor: boolean;
  url: string | null;
  key: string | null;
  dbUrl: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, sqlEditor: false, url: null, key: null, dbUrl: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--sql-editor') {
      args.sqlEditor = true;
    } else if (arg === '--url' && i + 1 < argv.length) {
      args.url = argv[++i];
    } else if (arg === '--key' && i + 1 < argv.length) {
      args.key = argv[++i];
    } else if (arg === '--db-url' && i + 1 < argv.length) {
      args.dbUrl = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      log(`
${C.bold}AlienKind Migration Runner${C.reset}

${C.dim}Usage:${C.reset}
  npx tsx scripts/tools/run-migrations.ts [options]

${C.dim}Options:${C.reset}
  --dry-run       Show what would be applied without executing
  --sql-editor    Force SQL Editor mode (skip psql detection)
  --url URL       Supabase URL (or reads SUPABASE_URL from .env)
  --key KEY       Service role key (or reads SUPABASE_SERVICE_KEY / SUPABASE_KEY from .env)
  --db-url URL    Direct psql connection string (postgresql://user:pass@host:5432/db)
  --help, -h      Show this help
`);
      process.exit(0);
    }
  }
  return args;
}

// ============================================================================
// Supabase REST client — native https, zero deps
// ============================================================================

interface SupabaseConfig {
  projectRef: string;
  url: string;
  key: string;
}

function supabaseRequest(
  method: string,
  config: SupabaseConfig,
  pathAndQuery: string,
  body?: any,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${config.url}/rest/v1/${pathAndQuery}`);
    const bodyStr = body ? JSON.stringify(body) : '';

    const headers: Record<string, string | number> = {
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(fullUrl, { method, headers }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        let parsed: any = null;
        if (data && data.trim()) {
          try { parsed = JSON.parse(data); } catch { parsed = data; }
        }
        resolve({ status: res.statusCode, data: parsed });
      });
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Supabase request timeout (30s)'));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function supabaseGet(config: SupabaseConfig, table: string, query: string = ''): Promise<any> {
  const pathAndQuery = query ? `${table}?${query}` : table;
  const { status, data } = await supabaseRequest('GET', config, pathAndQuery);
  if (status >= 400) {
    throw new Error(`GET ${table}: HTTP ${status} — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function supabasePost(config: SupabaseConfig, table: string, body: any, prefer: string = 'return=representation'): Promise<any> {
  const { status, data } = await supabaseRequest('POST', config, table, body, { 'Prefer': prefer });
  if (status >= 400) {
    throw new Error(`POST ${table}: HTTP ${status} — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// ============================================================================
// Migration file discovery + sorting
// ============================================================================

interface MigrationFile {
  filename: string;
  sortKey: number;
  sortSuffix: string;
  fullPath: string;
}

/**
 * Parse migration filenames like "037b-fix-rls-policies.sql".
 * Numeric prefix is the primary sort key. Alpha suffix (e.g. "b") is secondary.
 * Files with same numeric prefix sort alphabetically by suffix:
 *   037 → sortKey=37, sortSuffix=""
 *   037b → sortKey=37, sortSuffix="b"
 */
function parseMigrationFilename(filename: string): { num: number; suffix: string } | null {
  const match = filename.match(/^(\d+)([a-z]?)[-_]/i);
  if (!match) return null;
  return {
    num: parseInt(match[1], 10),
    suffix: (match[2] || '').toLowerCase(),
  };
}

function discoverMigrations(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fail(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files: string[] = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith('.sql') && !f.startsWith('_'));

  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      warn(`Skipping file with unparseable name: ${filename}`);
      continue;
    }
    migrations.push({
      filename,
      sortKey: parsed.num,
      sortSuffix: parsed.suffix,
      fullPath: path.join(MIGRATIONS_DIR, filename),
    });
  }

  // Sort by numeric prefix, then by alpha suffix within same prefix
  migrations.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.sortSuffix.localeCompare(b.sortSuffix);
  });

  return migrations;
}

// ============================================================================
// _migrations tracking table bootstrap
// ============================================================================

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT now()
);
`.trim();

/**
 * Ensure _migrations table exists. Uses Supabase REST to attempt a SELECT.
 * If it 404s / errors, the table doesn't exist yet — we need to create it
 * as part of the first psql batch or the combined SQL file.
 */
async function checkTrackingTable(config: SupabaseConfig): Promise<{ exists: boolean; applied: Set<string> }> {
  try {
    const rows = await supabaseGet(config, '_migrations', 'select=id');
    const applied = new Set<string>((rows || []).map((r: any) => r.id));
    return { exists: true, applied };
  } catch (e: any) {
    // Table doesn't exist yet — that's expected on first run
    return { exists: false, applied: new Set() };
  }
}

// ============================================================================
// psql detection
// ============================================================================

function detectPsql(): boolean {
  try {
    execSync('which psql', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function buildConnectionString(config: SupabaseConfig): string {
  // Extract project ref from URL: https://abcdefgh.supabase.co → abcdefgh
  const urlObj = new URL(config.url);
  const ref = urlObj.hostname.split('.')[0];
  // Encode the key for use in URI (it may contain special characters)
  const encodedKey = encodeURIComponent(config.key);
  return `postgresql://postgres:${encodedKey}@db.${ref}.supabase.co:5432/postgres`;
}

// ============================================================================
// Execution: psql mode
// ============================================================================

function executePsql(connStr: string, sqlPath: string, filename: string): { success: boolean; error?: string } {
  try {
    execSync(`psql "${connStr}" -v ON_ERROR_STOP=1 -f "${sqlPath}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return { success: true };
  } catch (e: any) {
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    return { success: false, error: stderr.slice(0, 500) };
  }
}

async function runPsqlMode(
  config: SupabaseConfig,
  connStr: string,
  pending: MigrationFile[],
  trackingTableExists: boolean,
): Promise<boolean> {
  // If tracking table doesn't exist, create it first via psql
  if (!trackingTableExists) {
    info('Creating _migrations tracking table...');
    const tmpPath = path.join(MIGRATIONS_DIR, '_bootstrap-tracking.sql');
    fs.writeFileSync(tmpPath, BOOTSTRAP_SQL, 'utf8');
    try {
      const result = executePsql(connStr, tmpPath, '_bootstrap-tracking.sql');
      if (!result.success) {
        fail(`Failed to create _migrations table: ${result.error}`);
        return false;
      }
      ok('_migrations table created');
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // Execute each pending migration
  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    const progress = `[${i + 1}/${pending.length}]`;
    info(`${progress} Applying ${C.bold}${m.filename}${C.reset}...`);

    const result = executePsql(connStr, m.fullPath, m.filename);
    if (!result.success) {
      fail(`${progress} ${m.filename} FAILED`);
      log('');
      log(`${C.red}${C.bold}Error output:${C.reset}`);
      log(result.error || '(no error output)');
      log('');
      fail(`Stopping. ${i} of ${pending.length} migrations applied.`);
      fail(`Fix the issue in ${m.filename} and re-run.`);
      return false;
    }

    // Record in _migrations table
    try {
      await supabasePost(config, '_migrations', {
        id: m.filename.replace(/\.sql$/, ''),
        filename: m.filename,
      }, 'return=minimal');
    } catch (e: any) {
      // If recording fails, warn but don't stop — the SQL was applied
      warn(`Migration applied but failed to record in _migrations: ${e.message}`);
    }

    ok(`${progress} ${m.filename}`);
  }

  return true;
}

// ============================================================================
// Execution: SQL Editor fallback
// ============================================================================

function generateCombinedSql(
  pending: MigrationFile[],
  trackingTableExists: boolean,
): string {
  const parts: string[] = [];

  parts.push('-- ==========================================================================');
  parts.push('-- AlienKind Combined Migration File');
  parts.push(`-- Generated: ${new Date().toISOString()}`);
  parts.push(`-- Pending migrations: ${pending.length}`);
  parts.push('-- ==========================================================================');
  parts.push('');

  // Bootstrap tracking table if needed
  if (!trackingTableExists) {
    parts.push('-- Bootstrap: _migrations tracking table');
    parts.push(BOOTSTRAP_SQL);
    parts.push('');
  }

  // Each migration wrapped with a tracking INSERT
  for (const m of pending) {
    const migrationId = m.filename.replace(/\.sql$/, '');
    parts.push(`-- --------------------------------------------------------------------------`);
    parts.push(`-- Migration: ${m.filename}`);
    parts.push(`-- --------------------------------------------------------------------------`);
    parts.push('');

    const sql = fs.readFileSync(m.fullPath, 'utf8').trim();
    parts.push(sql);
    parts.push('');

    // Record in tracking table
    parts.push(`INSERT INTO _migrations (id, filename) VALUES ('${migrationId}', '${m.filename}') ON CONFLICT (id) DO NOTHING;`);
    parts.push('');
  }

  parts.push('-- ==========================================================================');
  parts.push('-- Done. All migrations applied.');
  parts.push('-- ==========================================================================');

  return parts.join('\n');
}

function runSqlEditorMode(
  pending: MigrationFile[],
  trackingTableExists: boolean,
  config: SupabaseConfig,
): void {
  const combinedSql = generateCombinedSql(pending, trackingTableExists);
  const outputPath = path.join(MIGRATIONS_DIR, '_pending-combined.sql');
  fs.writeFileSync(outputPath, combinedSql, 'utf8');

  const ref = new URL(config.url).hostname.split('.')[0];

  log('');
  log(`${C.bold}${C.yellow}=== SQL Editor Mode ===${C.reset}`);
  log('');
  log(`psql is not available (or --sql-editor was specified).`);
  log(`All ${pending.length} pending migrations have been combined into:`);
  log('');
  log(`  ${C.cyan}${outputPath}${C.reset}`);
  log('');
  log(`${C.bold}To apply:${C.reset}`);
  log(`  1. Open your Supabase dashboard:`);
  log(`     ${C.dim}https://supabase.com/dashboard/project/${ref}/sql/new${C.reset}`);
  log(`  2. Copy the contents of _pending-combined.sql into the SQL Editor`);
  log(`  3. Click "Run"`);
  log('');
  log(`${C.dim}After applying, re-run this script to verify all migrations are tracked.${C.reset}`);
  log('');
}

// ============================================================================
// Resolve credentials
// ============================================================================

function resolveCredentials(args: CliArgs): SupabaseConfig {
  // CLI args take priority, then .env
  const envFile = loadEnv(path.join(ROOT, '.env'));

  const url = args.url || envFile.SUPABASE_URL || '';
  // The codebase uses both SUPABASE_SERVICE_KEY and SUPABASE_KEY
  const key = args.key || envFile.SUPABASE_SERVICE_KEY || envFile.SUPABASE_KEY || '';

  if (!url) {
    fail('Missing Supabase URL.');
    log('');
    log('Provide it via:');
    log(`  ${C.dim}--url https://yourproject.supabase.co${C.reset}`);
    log(`  ${C.dim}SUPABASE_URL in .env${C.reset}`);
    process.exit(1);
  }

  if (!key) {
    fail('Missing Supabase service role key.');
    log('');
    log('Provide it via:');
    log(`  ${C.dim}--key your-service-role-key${C.reset}`);
    log(`  ${C.dim}SUPABASE_SERVICE_KEY or SUPABASE_KEY in .env${C.reset}`);
    process.exit(1);
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`Invalid Supabase URL: ${url}`);
    process.exit(1);
  }

  const projectRef = parsedUrl.hostname.split('.')[0];
  if (!projectRef || projectRef.length < 6) {
    fail(`Cannot extract project ref from URL: ${url}`);
    process.exit(1);
  }

  return { projectRef, url, key };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs(process.argv);

  log('');
  log(`${C.bold}AlienKind Migration Runner${C.reset}`);
  log(`${C.dim}config/migrations/ → Supabase${C.reset}`);
  log('');

  // 1. Discover migration files
  const allMigrations = discoverMigrations();
  info(`Found ${C.bold}${allMigrations.length}${C.reset} migration files in config/migrations/`);

  // 2. Resolve credentials
  const config = resolveCredentials(args);
  info(`Target: ${C.bold}${config.projectRef}${C.reset}.supabase.co`);

  // 3. Check tracking table + already-applied migrations
  info('Checking migration state...');
  const { exists: trackingTableExists, applied } = await checkTrackingTable(config);

  if (trackingTableExists) {
    info(`_migrations table exists — ${C.bold}${applied.size}${C.reset} already applied`);
  } else {
    info('_migrations table does not exist yet — will be created');
  }

  // 4. Determine pending migrations
  const pending = allMigrations.filter(m => {
    const id = m.filename.replace(/\.sql$/, '');
    return !applied.has(id);
  });

  log('');
  log(`  ${C.green}Applied:${C.reset}  ${applied.size}`);
  log(`  ${C.yellow}Pending:${C.reset}  ${pending.length}`);
  log(`  ${C.dim}Total:${C.reset}    ${allMigrations.length}`);
  log('');

  if (pending.length === 0) {
    ok('All migrations are already applied. Nothing to do.');
    process.exit(0);
  }

  // 5. Dry run — just list what would be applied
  if (args.dryRun) {
    log(`${C.bold}Dry run — these migrations would be applied:${C.reset}`);
    log('');
    for (let i = 0; i < pending.length; i++) {
      log(`  ${C.dim}${String(i + 1).padStart(3, ' ')}.${C.reset} ${pending[i].filename}`);
    }
    log('');
    log(`${C.dim}Re-run without --dry-run to apply.${C.reset}`);
    process.exit(0);
  }

  // 6. Choose execution strategy
  // Resolve connection string: --db-url flag > DB_URL in .env > derived from Supabase URL + key
  const envFile = loadEnv(path.join(ROOT, '.env'));
  const dbUrl = args.dbUrl || envFile.DATABASE_URL || envFile.DB_URL || envFile.SUPABASE_DB_URL || null;
  const hasPsql = !args.sqlEditor && detectPsql();

  if (hasPsql) {
    const connStr = dbUrl || buildConnectionString(config);
    if (dbUrl) {
      info('psql detected — using provided database URL');
    } else {
      info('psql detected — deriving connection from Supabase URL (if auth fails, use --db-url)');
    }
    const success = await runPsqlMode(config, connStr, pending, trackingTableExists);

    if (success) {
      log('');
      ok(`${C.bold}All ${pending.length} migrations applied successfully.${C.reset}`);
    }
    process.exit(success ? 0 : 1);
  } else {
    if (!args.sqlEditor) {
      warn('psql not found on PATH — falling back to SQL Editor mode');
    }
    runSqlEditorMode(pending, trackingTableExists, config);
    process.exit(0);
  }
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`);
  process.exit(1);
});
