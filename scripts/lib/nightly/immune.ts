/**
 * Nightly Immune Phase — Security, infrastructure, backup, cleanup
 *
 * Extracted from scripts/nightly-cycle.ts.
 * Runs preflight checks, Claude immune scan, backup, memory index,
 * auto-commit, cleanup, defense elements.
 */
const {
  ALIENKIND_DIR, LOG_DIR, DATE, TIME, SKIP_BACKUP,
  fs, path, https, execSync, execFileSync,
  log, logHeap, sendTelegram, formatAlert, appendToDigest,
  attemptGrowthCycle, buildAwarenessContext,
  writeConsciousnessFromOutput,
  querySupabase,
  NIGHTLY, MODELS, ALLOWED_TOOLS_IMMUNE,
  SUPABASE_URL, SUPABASE_SERVICE_KEY, STREAMING_TABLE_CONFIG,
  env, writeSkillMetrics,
} = require('./shared.ts');

const { reapAll } = require('../reaper.ts');
const { indexAll } = require('../memory-indexer.ts');
const { expireStaleRequests } = require('../comms-coord.ts');
const { resolveConfig } = require('../portable.ts');
const PARTNER_NAME = resolveConfig('name', 'Partner');
const BACKUP_SLUG = `${PARTNER_NAME.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-backups`;

// Subscription reconciliation is partner-specific (financial tables, vendor
// aliases, business P&L schema). Not shipped in the generic reference.
// Forkers who want it add their own reconciler and wire it here.

// ─── AIRE Preflight Check ────────────────────────────────────────────────────
// Runs at the START of the immune job. Checks infrastructure health before
// the nightly cycle begins. Results written to logs/ and appended to immune Telegram.
async function runPreflight(): Promise<string> {
  const checks: string[] = [];
  const check = (label: string, pass: boolean, detail: string = '') => {
    checks.push(`${pass ? 'OK' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. Daemon PID alive
  try {
    const pid = parseInt(fs.readFileSync(path.join(ALIENKIND_DIR, 'logs/daemon.pid'), 'utf-8').trim(), 10);
    const alive = pid > 0 && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    check('Daemon PID', alive, alive ? `PID ${pid}` : 'not running');
  } catch { check('Daemon PID', false, 'no pid file'); }

  // 2. Daily memory file exists and has content
  const dailyPath = path.join(ALIENKIND_DIR, 'memory', 'daily', `${DATE}.md`);
  const dailyExists = fs.existsSync(dailyPath);
  const dailySize = dailyExists ? fs.statSync(dailyPath).size : 0;
  check('Daily memory', dailyExists && dailySize > 100, `${dailySize} bytes`);

  // 3. Supabase connectivity
  try {
    const { supabaseGet } = require('../supabase.ts');
    const rows = await supabaseGet('sessions', 'select=id&limit=1');
    check('Supabase connectivity', Array.isArray(rows), `${rows?.length ?? 0} rows`);
  } catch (e: any) { check('Supabase connectivity', false, e.message); }

  // 4. Prior night's digest in Supabase
  try {
    const { supabaseGet } = require('../supabase.ts');
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const yd = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const digests = await supabaseGet('nightly_digests', `digest_date=eq.${yd}&select=digest_date&limit=1`);
    check('Prior digest in Supabase', digests && digests.length > 0, digests?.length ? `found for ${yd}` : `empty for ${yd} (expected on first run)`);
  } catch (e: any) { check('Prior digest', false, e.message); }

  // 5. Identity kernel files readable
  const identityFiles = ['identity/character.md', 'identity/commitments.md', 'identity/orientation.md'];
  for (const sf of identityFiles) {
    const fp = path.join(ALIENKIND_DIR, sf);
    const readable = fs.existsSync(fp) && fs.statSync(fp).size > 50;
    check(sf, readable);
  }

  // 6. Emergency gateway health check (Vercel AI Gateway → gateway-fallback-alt / [MODEL_TIER_4] Pro)
  try {
    const { healthCheck } = require('../gateway.ts');
    const gwLog = (level: string, msg: string) => log(`[${level}] ${msg}`);
    const gwHealth = await healthCheck(gwLog);
    check('Emergency gateway (Vercel AI Gateway)', gwHealth.healthy, gwHealth.details);
  } catch (e: any) { check('Emergency gateway', false, e.message); }

  // 7. Emergency hook config sync — verify settings.local.json event types
  try {
    const { loadHookConfig } = require('../emergency-tools.ts');
    const config = loadHookConfig();
    const eventTypes = Object.keys(config);
    const expected = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];
    const missing = expected.filter(e => !eventTypes.includes(e));
    check('Emergency hook sync', missing.length === 0, missing.length > 0 ? `missing: ${missing.join(', ')}` : `${eventTypes.length} event types loaded`);
  } catch (e: any) { check('Emergency hook sync', false, e.message); }

  // (Preflight check 8: digest-consumption verification removed with
  // morning-brief. Forkers who ship a downstream digest consumer can
  // re-add a check here that verifies their consumer loaded the previous
  // night's digest output.)

  const report = `AIRE PREFLIGHT — ${DATE} ${TIME}\n${checks.join('\n')}`;
  const preflightPath = path.join(LOG_DIR, `aire-preflight-${DATE}.txt`);
  fs.writeFileSync(preflightPath, report);
  log(`Preflight: ${checks.filter((c: string) => c.startsWith('OK')).length}/${checks.length} checks passed`);
  return report;
}

// Auto-discover all Supabase tables from PostgREST Swagger schema
async function discoverTables(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout after 10s')), 10000);
    const reqUrl = new URL(`${SUPABASE_URL}/rest/v1/`);
    https.get(reqUrl, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const swagger = JSON.parse(data);
          const paths = swagger.paths || {};
          const tables = Object.keys(paths)
            .filter((p: string) => p !== '/' && !p.startsWith('/rpc/'))
            .map((p: string) => p.replace(/^\//, ''));
          resolve(tables.sort());
        } catch {
          reject(new Error('Failed to parse Swagger response'));
        }
      });
    }).on('error', (e: any) => { clearTimeout(timer); reject(e); });
  });
}

// Run backup directly in Node.js — avoids /bin/bash FDA restriction in launchd
async function runBackup() {
  const GDRIVE_BASE = path.join(process.env.HOME, 'Library/CloudStorage/GoogleDrive-[EMAIL]/My Drive');
  const BACKUP_DIR = path.join(GDRIVE_BASE, BACKUP_SLUG);
  const BACKUP_PATH = path.join(BACKUP_DIR, `${DATE}_${TIME.replace(':', '')}`);
  const MAX_BACKUPS = NIGHTLY.maxBackups;

  let backupTableCount = 0;

  // Verify Google Drive mount point exists — prevent creating local dirs that look like Drive but aren't synced
  if (!fs.existsSync(GDRIVE_BASE)) {
    log('ERROR: Google Drive mount not found — skipping backup to prevent unsynced local dirs');
    sendTelegram(formatAlert({ severity: 'heads-up', source: 'nightly backup', summary: 'skipped — Google Drive not mounted' }));
    return { totalTables: 0 };
  }

  fs.mkdirSync(path.join(BACKUP_PATH, 'workspace'), { recursive: true });
  log('Backup: directory created');

  // 1. rsync project files (rsync binary works from Node.js — no /bin/bash needed)
  try {
    execSync(`/usr/bin/rsync -a --exclude='node_modules' --exclude='*.jsonl' --exclude='.git' --exclude='data/browser-profile/*/Cache' --exclude='.credentials.bak' --exclude='backup-keys.txt' --exclude='.canary' "${ALIENKIND_DIR}/" "${BACKUP_PATH}/workspace/"`, { timeout: 120000 });
    log('Backup: project files synced');
  } catch (e: any) {
    log(`WARN: rsync failed: ${e.message}`);
  }

  // 2. Export Supabase tables via REST API — auto-discover ALL tables
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    // Auto-discover tables from PostgREST schema (new tables included automatically)
    let allTables: string[];
    try {
      allTables = await discoverTables();
      log(`Backup: discovered ${allTables.length} tables from schema`);
    } catch (e: any) {
      // Fallback: hardcoded list covers known tables if discovery fails
      log(`WARN: table discovery failed (${e.message}), using fallback list`);
      allTables = [
        'articles', 'case_studies', 'contact_submissions', 'content_feedback', 'content_performance',
        'conversations', 'deferred_actions', 'intents', 'invocation_usage', 'experiences',
        'outcomes', 'predictions', 'learning_ledger', 'memories', 'memory_chunks',
        'learning_opportunities', 'platform_contacts', 'platform_email_templates', 'platform_financial_accounts',
        'platform_financial_category_rules', 'platform_financial_period_status', 'platform_financial_pnl',
        'platform_financial_quarterly_estimates', 'platform_financial_subscriptions', 'platform_financial_tax_profile',
        'platform_financial_transactions', 'platform_newsletter_sends', 'platform_newsletters', 'platform_sites',
        'patterns', 'finance_budget_allocations', 'finance_budget_groups', 'finance_budget_items', 'finance_budget_months',
        'finance_household_members', 'finance_households', 'finance_transactions', 'transcription_records', 'podcast_episodes',
        'review_messages', 'sessions', 'skill_metrics', 'social_drafts', 'social_growth',
        'subscription_usage', 'timeline',
      ];
    }

    // Separate into streaming (known large) vs curl (everything else)
    const streamingNames = new Set(Object.keys(STREAMING_TABLE_CONFIG));
    const smallTables = allTables.filter((t: string) => !streamingNames.has(t));
    const streamingTables = allTables
      .filter((t: string) => streamingNames.has(t))
      .map((name: string) => ({ name, filter: STREAMING_TABLE_CONFIG[name] || '' }));

    const supaDir = path.join(BACKUP_PATH, 'supabase');
    fs.mkdirSync(supaDir, { recursive: true });
    const failedExports: string[] = [];  // actual failures (error, timeout, invalid response)
    const emptyTables: string[] = [];    // legitimately empty tables (0 rows, valid export)

    // Small tables: curl + JSON validation
    for (const table of smallTables) {
      try {
        const result = execFileSync('/usr/bin/curl', [
          '-s',
          `${SUPABASE_URL}/rest/v1/${table}?select=*`,
          '-H', `apikey: ${SUPABASE_SERVICE_KEY}`,
          '-H', `Authorization: Bearer ${SUPABASE_SERVICE_KEY}`,
        ], { timeout: 30000 });
        // Validate export is a JSON array before saving (error responses are JSON objects, not arrays)
        const resultStr = result.toString();
        try {
          const parsed = JSON.parse(resultStr);
          if (!Array.isArray(parsed)) {
            log(`WARN: ${table} export returned non-array JSON (possible error response): ${resultStr.slice(0, 200)}`);
            failedExports.push(table);
            continue;
          }
        } catch {
          log(`WARN: ${table} export returned invalid JSON: ${resultStr.slice(0, 200)}`);
          failedExports.push(table);
          continue;
        }
        fs.writeFileSync(path.join(supaDir, `${table}.json`), result);
        const size = result.length;
        if (size < 3) emptyTables.push(table);
      } catch (e: any) {
        log(`WARN: ${table} export failed: ${e.message}`);
        failedExports.push(table);
      }
    }
    // Streaming exports (large tables — paginated to handle PostgREST 1000-row cap + ENOBUFS)
    // PostgREST max-rows=1000 server-side — single requests silently truncate.
    // Paginate with limit/offset, concatenate into a single JSON array per table.
    const PAGE_SIZE = 1000;
    for (const { name, filter } of streamingTables) {
      try {
        const suffix = filter ? '_incremental' : '';
        const outPath = path.join(supaDir, `${name}${suffix}.json`);
        const baseQuery = filter
          ? (filter.startsWith('select=') ? filter : `select=*&${filter}`)
          : 'select=*';
        let allRows: any[] = [];
        let offset = 0;
        let done = false;
        const exportStart = Date.now();

        while (!done) {
          if (Date.now() - exportStart > 600000) {
            throw new Error(`Timeout after 600s (${allRows.length} rows fetched so far)`);
          }

          const pageQuery = `${baseQuery}&order=id&limit=${PAGE_SIZE}&offset=${offset}`;
          const pageRows = await new Promise<any[]>((resolve, reject) => {
            const reqUrl = new URL(`${SUPABASE_URL}/rest/v1/${name}?${pageQuery}`);
            const timer = setTimeout(() => reject(new Error(`Page timeout after 60s (offset=${offset})`)), 60000);
            let data = '';
            https.get(reqUrl, {
              headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              },
            }, (res: any) => {
              if (res.statusCode >= 400) {
                clearTimeout(timer);
                let body = '';
                res.on('data', (c: any) => body += c);
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
                return;
              }
              res.on('data', (chunk: any) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timer);
                try {
                  const parsed = JSON.parse(data);
                  if (!Array.isArray(parsed)) {
                    reject(new Error(`Non-array response at offset ${offset}: ${data.slice(0, 200)}`));
                    return;
                  }
                  resolve(parsed);
                } catch (e: any) {
                  reject(new Error(`JSON parse error at offset ${offset}: ${e.message}`));
                }
              });
            }).on('error', (e: any) => { clearTimeout(timer); reject(e); });
          });

          allRows = allRows.concat(pageRows);
          if (pageRows.length < PAGE_SIZE) {
            done = true;
          } else {
            offset += PAGE_SIZE;
          }
        }

        // Write complete result as JSON array
        const jsonStr = JSON.stringify(allRows);
        fs.writeFileSync(outPath, jsonStr);
        const bytes = Buffer.byteLength(jsonStr);

        if (allRows.length === 0) {
          emptyTables.push(name);
        }
        log(`Backup: ${name}${suffix} export (${bytes} bytes, ${allRows.length} rows${filter ? `, filter: ${filter}` : ''})`);
      } catch (e: any) {
        log(`WARN: ${name} streaming export failed: ${e.message}`);
        failedExports.push(name);
      }
    }
    backupTableCount = smallTables.length + streamingTables.length;
    // Only alert on actual failures — legitimately empty tables are expected
    if (failedExports.length > 0) {
      log(`WARN: ${failedExports.length} tables had failed exports: ${failedExports.join(', ')}`);
      sendTelegram(formatAlert({ severity: 'heads-up', source: 'nightly backup', summary: `${failedExports.length} failed table exports`, detail: failedExports.join(', ') }));
    }
    if (emptyTables.length > 0) {
      log(`Backup: ${emptyTables.length} empty tables (expected): ${emptyTables.join(', ')}`);
    }
    log(`Backup: Supabase exported (${backupTableCount} tables, ${failedExports.length} failed, ${emptyTables.length} empty)`);
  }

  // 3. Metadata
  fs.writeFileSync(path.join(BACKUP_PATH, 'backup-meta.json'), JSON.stringify({
    timestamp: `${DATE}_${TIME}`, agent_dir: ALIENKIND_DIR, created_at: new Date().toISOString(),
  }, null, 2));

  // 4. Copy restore docs
  const restorePrompt = path.join(ALIENKIND_DIR, 'config/partner-restore-prompt.txt');
  const restoreGuide = path.join(ALIENKIND_DIR, 'RESTORE.md');
  const restoreOutName = `RESTORE-${PARTNER_NAME.toUpperCase().replace(/[^A-Z0-9-]/g, '-')}.txt`;
  if (fs.existsSync(restorePrompt)) fs.copyFileSync(restorePrompt, path.join(GDRIVE_BASE, BACKUP_SLUG, restoreOutName));
  if (fs.existsSync(restoreGuide)) fs.copyFileSync(restoreGuide, path.join(GDRIVE_BASE, BACKUP_SLUG, 'RESTORE-GUIDE.md'));

  // 5. Cleanup old backups
  try {
    const entries = fs.readdirSync(BACKUP_DIR).filter((e: string) => {
      try { return fs.statSync(path.join(BACKUP_DIR, e)).isDirectory(); } catch { return false; }
    }).sort();
    if (entries.length > MAX_BACKUPS) {
      for (const old of entries.slice(0, entries.length - MAX_BACKUPS)) {
        fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
        log(`Backup: removed old ${old}`);
      }
    }
  } catch (e: any) {
    log(`WARN: cleanup failed: ${e.message}`);
  }

  log('Backup: complete');
  return { totalTables: backupTableCount };
}

function buildImmunePrompt() {
  return `IMMUNE MODE — Security and integrity checks (~8 turns):
1. Glob for unexpected files in project root, scripts/, config/
2. Verify .env is gitignored (grep .env in .gitignore)
3. Verify character.md, user.md haven't been unexpectedly modified (check git status)
4. Check git status for anything suspicious or unexpected
5. Note any anomalies

If anomaly found: write details to daily memory under '## Immune System' with specific findings.
Otherwise note 'all clear' in daily memory under '## Immune System'.

Write findings to the outbox file at: ${path.join(LOG_DIR, `telegram-outbox-immune-${DATE}.txt`)}
Write what matters — if all clear, say so briefly. If I found something, explain what and why it matters. The parent script will append infrastructure verification lines.
Do NOT use curl to send Telegram messages.

Immune mode is focused: no analysis, no research, no content, no client work. Just security.
${buildAwarenessContext({ selfNodeId: 'daemon' })}`;
}

function verifyImmune() {
  const lines: string[] = [];
  // Check daily file has ## Immune System section
  const dailyFile = path.join(ALIENKIND_DIR, 'memory', 'daily', `${DATE}.md`);
  try {
    const stats = fs.statSync(dailyFile);
    const content = fs.readFileSync(dailyFile, 'utf-8');
    const hasSection = content.includes('## Immune System');
    const recentlyModified = (Date.now() - stats.mtimeMs) < 10 * 60 * 1000;
    lines.push(`Immune section: ${hasSection ? 'written' : 'MISSING'}`);
    lines.push(`Daily file: ${recentlyModified ? 'updated' : 'WARNING — stale'}`);
    if (!hasSection) log('WARN: Immune System section not found in daily file');
  } catch (e: any) {
    lines.push('Daily file: ERROR');
    log(`WARN: Could not verify daily file: ${e.message}`);
  }
  return lines;
}

async function runImmune() {
  log('=== Nightly Immune Job Starting ===');

  // AIRE Preflight — check infrastructure health before the cycle begins
  let preflightReport = '';
  try {
    preflightReport = await runPreflight();
  } catch (e: any) {
    preflightReport = `Preflight FAILED: ${e.message}`;
    log(`WARN: Preflight failed: ${e.message}`);
  }

  const promptText = buildImmunePrompt();
  const outboxFile = path.join(LOG_DIR, `telegram-outbox-immune-${DATE}.txt`);

  const result: any = await attemptGrowthCycle({
    promptText,
    maxTurns: NIGHTLY.immune.maxTurns,
    overallTimeout: NIGHTLY.immune.overallTimeout,
    noOutputTimeout: NIGHTLY.immune.noOutputTimeout,
    allowedTools: ALLOWED_TOOLS_IMMUNE,
    outboxFile,
    jobName: 'nightly-immune',
    model: MODELS.reasoning,
  });

  if (!result.success) {
    sendTelegram(formatAlert({ severity: 'heads-up', source: 'nightly immune', summary: 'failed', nextStep: 'daemon will retry automatically' }));
    process.exitCode = 1;
    return;
  }

  // CODE-LEVEL OUTBOX ENFORCEMENT (tier 1)
  // The outbox write is prompt-instructed (tier 3) so Claude sometimes skips it.
  // If Claude succeeded but didn't write the outbox file, extract a summary from
  // stdout and set it on result.outboxContent so the Telegram message has substance.
  if (!result.outboxContent && result.stdout && result.stdout.length > 0) {
    log('WARN: Immune outbox not written by Claude — extracting summary from stdout (tier 1 fallback)');
    // Extract a meaningful summary: take the last ~1500 chars of stdout (where conclusions tend to be)
    // and trim to a reasonable Telegram length
    const raw = result.stdout.trim();
    const maxLen = 1500;
    let summary: string;
    if (raw.length <= maxLen) {
      summary = raw;
    } else {
      // Prefer the tail (conclusions) but include a note about truncation
      summary = '...\n' + raw.slice(-maxLen);
    }
    result.outboxContent = `[immune fallback — outbox not written by Claude]\n${summary}`;
    // Also write the file so downstream consumers (if any) can find it
    try {
      fs.writeFileSync(outboxFile, result.outboxContent, 'utf-8');
      log(`Outbox fallback written to ${outboxFile} (${result.outboxContent.length} bytes)`);
    } catch (e: any) {
      log(`WARN: Failed to write outbox fallback file: ${e.message}`);
    }
  }

  // Consciousness continuity: write state for subsequent nightly jobs
  writeConsciousnessFromOutput({ mode: 'immune', stdout: result.stdout || '', log });

  // Infrastructure phases (run after Claude exits)

  // NOTE: Transcript Pipeline extracted to standalone daemon job (transcript-pipeline-runner.ts)
  // Runs at 22:30, before security suite. Prevents 30-min pipeline timeout from cascading into immune.

  // CLI Capability Scan (monthly — 1st of each month)
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth === 1) {
    log('Infrastructure: CLI capability scan (monthly)');
    try {
      execSync(`npx tsx ${path.join(ALIENKIND_DIR, 'scripts', 'check-cli-capabilities.ts')}`, {
        timeout: 60000, cwd: ALIENKIND_DIR, stdio: 'pipe',
      });
      log('CLI capability scan: complete');
    } catch (e: any) {
      log(`WARNING: CLI capability scan failed: ${e.message?.slice(0, 100)}`);
    }
  }

  // BUILD_LOG rotation removed — daily files are the source of truth
  let rotationResult: any = { rotated: false, sectionsArchived: 0 };

  // Auto-commit
  log('Infrastructure: Auto-commit');
  let commitResult = 'no changes';
  try {
    const { AUTOCOMMIT: _AC } = require('../constants.ts');
    for (const safePath of _AC.safePaths) {
      try { execSync(`git -C "${ALIENKIND_DIR}" add "${safePath}"`, { timeout: 5000, stdio: 'pipe' }); } catch { /* ok */ }
    }
    // ACTIVATE gate — block commit if daemon running stale config
    const { checkActivateGate } = require('../activate-gate.ts');
    const activateCheck = checkActivateGate();
    if (!activateCheck.passed) {
      log(`ACTIVATE BLOCKED: ${activateCheck.reason}`);
      commitResult = 'blocked-activate';
    } else {
      execSync(`git -C "${ALIENKIND_DIR}" diff --cached --quiet || git -C "${ALIENKIND_DIR}" commit -m "nightly: ${DATE} immune + infrastructure"`, {
        timeout: 30000,
        env: { ...process.env, GIT_AUTHOR_NAME: PARTNER_NAME, GIT_AUTHOR_EMAIL: '[EMAIL]', GIT_COMMITTER_NAME: PARTNER_NAME, GIT_COMMITTER_EMAIL: '[EMAIL]' },
      });
      commitResult = 'committed';
      log('Auto-commit: complete');
    }
  } catch (e: any) {
    commitResult = e.message.includes('nothing to commit') ? 'no changes' : `failed: ${e.message.slice(0, 100)}`;
    log(`Auto-commit: ${commitResult}`);
  }

  // Memory Index
  log('Infrastructure: Memory Index');
  let indexResult = { total: 0, indexed: 0, skipped: 0, deleted: 0 };
  try {
    const indexLog = (level: string, msg: string) => log(`[${level}] ${msg}`);
    indexResult = await indexAll({ log: indexLog });
    log(`Memory index: ${indexResult.indexed} chunks updated`);
  } catch (e: any) {
    log(`WARNING: Memory index failed: ${e.message}`);
  }

  // Backup
  let backupTableCount = 0;
  if (!SKIP_BACKUP) {
    log('Infrastructure: Backup');
    try {
      const backupResult = await runBackup();
      backupTableCount = backupResult?.totalTables || 0;
    } catch (e: any) {
      log(`WARNING: Backup failed: ${e.message}`);
    }
  }

  // Cleanup
  log('Infrastructure: Cleanup');
  let cleanupDeleted = 0;
  try {
    const reapSummary = reapAll({ log, repoDir: ALIENKIND_DIR });
    cleanupDeleted = reapSummary.totalDeleted;
  } catch (e: any) {
    log(`WARNING: Reaper failed: ${e.message}`);
  }

  // Log rotation — size-based truncation for unbounded log files
  const logRotations: Array<{ name: string; file: string; maxLines: number; keepLines: number }> = [
    { name: 'audit.log', file: path.join(ALIENKIND_DIR, 'logs', 'audit.log'), maxLines: 100000, keepLines: 50000 },
    { name: 'daemon-stdout.log', file: path.join(ALIENKIND_DIR, 'logs', 'daemon-stdout.log'), maxLines: 30000, keepLines: 15000 },
  ];
  for (const rot of logRotations) {
    try {
      if (fs.existsSync(rot.file)) {
        const content = fs.readFileSync(rot.file, 'utf8');
        const lines = content.split('\n');
        if (lines.length > rot.maxLines) {
          const kept = lines.slice(-rot.keepLines).join('\n');
          fs.writeFileSync(rot.file, kept);
          log(`${rot.name} rotated: ${lines.length} → ${rot.keepLines} lines (${Math.round((lines.length - rot.keepLines) * 80 / 1048576)}MB freed)`);
        }
      }
    } catch (e: any) {
      log(`WARNING: ${rot.name} rotation failed: ${e.message}`);
    }
  }

  // Expire stale coordination requests (evaluated > 24h with no action)
  try {
    const expired = await expireStaleRequests(log);
    if (expired > 0) log(`Coordination cleanup: ${expired} stale request(s) expired`);
  } catch (e: any) {
    log(`WARNING: Coordination expiry failed: ${e.message}`);
  }

  // AIRE Discernment Tuning — adjust signal weights based on outcome data
  log('Infrastructure: AIRE Discernment Tuning');
  try {
    const { tuneWeights } = require('../discernment-engine.ts');
    const tuneResult = await tuneWeights(log);
    if (tuneResult.adjusted.length > 0) {
      log(`Discernment AIRE: ${tuneResult.adjusted.length} weight(s) adjusted — ${tuneResult.adjusted.join(', ')}`);
    } else {
      log(`Discernment AIRE: no adjustments (${tuneResult.unchanged.length} signals stable or insufficient data)`);
    }
  } catch (e: any) {
    log(`WARNING: Discernment AIRE tuning failed: ${e.message}`);
  }

  // State Staleness Validator — checks structured-state.json threads against reality
  // Prevents false reporting from stale session-state entries
  log('Infrastructure: State Staleness Validator');
  let stateValidatorResult = '';
  try {
    const { validateAndReport } = require('../state-validator.ts');
    stateValidatorResult = await validateAndReport({ autoFix: true, log });
    log(stateValidatorResult);
  } catch (e: any) {
    stateValidatorResult = `State validator failed: ${e.message}`;
    log(`WARNING: ${stateValidatorResult}`);
  }

  // Ground Truth Check — VGE Wire #1: verify facts against reality
  log('Infrastructure: Ground Truth Verification');
  let groundTruthResult = '';
  try {
    const output = execSync('npx tsx scripts/ground-truth-check.ts --json', {
      cwd: ALIENKIND_DIR,
      timeout: 60000,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    }).toString();
    const drifts = JSON.parse(output);
    if (drifts.length === 0) {
      groundTruthResult = 'Ground truth: all facts verified against reality. 0 drift.';
    } else {
      groundTruthResult = `Ground truth: ${drifts.length} drift(s) detected — ${drifts.map((d: any) => `${d.truthId}(${d.staleFiles.length} stale refs)`).join(', ')}`;
    }
    log(groundTruthResult);
  } catch (e: any) {
    // Exit code 1 means drifts found (expected), capture output
    if (e.stdout) {
      try {
        const drifts = JSON.parse(e.stdout.toString());
        groundTruthResult = `Ground truth: ${drifts.length} drift(s) detected — ${drifts.map((d: any) => `${d.truthId}(${d.staleFiles.length} stale refs)`).join(', ')}`;
      } catch {
        groundTruthResult = `Ground truth check completed with findings: ${e.stdout.toString().substring(0, 500)}`;
      }
    } else {
      groundTruthResult = `Ground truth check failed: ${e.message}`;
    }
    log(groundTruthResult);
  }

  // Codebase Hygiene Scan — prevents dead code accumulation
  // Pure Node, zero LLM cost. Deposits findings to circulation for architect to evaluate.
  log('Infrastructure: Codebase Hygiene Scan');
  let hygieneResult = '';
  try {
    const findings: string[] = [];

    // 1. Detect " 2" duplicate files (macOS conflict artifacts)
    const { execSync: exec2 } = require('child_process');
    const dupes = exec2('find scripts/ config/ -name "* 2*" 2>/dev/null || true', { cwd: ALIENKIND_DIR, encoding: 'utf8' }).trim();
    if (dupes) findings.push(`DUPLICATE FILES: ${dupes.split('\n').length} " 2" files found`);

    // 2. Verify daemon-jobs script paths exist
    const { JOBS } = require('../../../config/daemon-jobs.ts');
    for (const job of JOBS) {
      if (job.script && !fs.existsSync(path.join(ALIENKIND_DIR, job.script))) {
        findings.push(`BROKEN JOB: ${job.name} → ${job.script} (file missing)`);
      }
    }

    // 3. Verify hook script paths exist
    try {
      const settingsPath = path.join(process.env.HOME || '', '.claude', 'settings.local.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const hooks = settings.hooks || {};
        for (const [event, hookList] of Object.entries(hooks)) {
          for (const hook of (hookList as any[])) {
            const cmd = hook.command || '';
            const match = cmd.match(/scripts\/\S+\.(ts|sh|js)/);
            if (match) {
              const hookPath = path.join(ALIENKIND_DIR, match[0]);
              if (!fs.existsSync(hookPath)) {
                findings.push(`BROKEN HOOK: ${event} → ${match[0]} (file missing)`);
              }
            }
          }
        }
      }
    } catch { /* hook check is best-effort */ }

    // 4. Check for disabled daemon jobs that shouldn't be there
    const disabled = JOBS.filter((j: any) => j.enabled === false);
    if (disabled.length > 0) {
      findings.push(`DISABLED JOBS IN ACTIVE CONFIG: ${disabled.map((j: any) => j.name).join(', ')}`);
    }

    if (findings.length === 0) {
      hygieneResult = 'Codebase hygiene: CLEAN — 0 findings';
    } else {
      hygieneResult = `Codebase hygiene: ${findings.length} finding(s)\n${findings.join('\n')}`;
      // Deposit to circulation for architect to evaluate with fence principle + 3-move rule
      try {
        const { depositFinding } = require('../circulation.ts');
        await depositFinding({
          domain: 'infrastructure',
          source: 'codebase-hygiene',
          finding: findings.join('; '),
          tier: 'BUILD',
          confidence: 0.9,
          metadata: {
            evaluation_rules: [
              'FENCE PRINCIPLE: understand why each file exists before removing. If unclear, investigate before acting.',
              '3-MOVE RULE: for each finding, identify (1) what to do, (2) what it enables downstream, (3) what breaks if wrong.',
            ],
          },
        });
      } catch { /* circulation deposit is best-effort */ }
    }
    log(hygieneResult);
  } catch (e: any) {
    hygieneResult = `Codebase hygiene scan failed: ${e.message}`;
    log(`WARNING: ${hygieneResult}`);
  }

  // Rate Limiter Assessment (monitors actual usage for 1 week, then recommends thresholds)
  log('Infrastructure: Rate Limiter Monitor');
  let rateLimiterResult = '';
  try {
    const { isAssessmentDue, assessUsage, markAssessed } = require('../rate-monitor.ts');
    if (isAssessmentDue()) {
      const assessment = assessUsage();
      if (assessment && assessment.ready) {
        rateLimiterResult = `Rate limiter assessment READY (${assessment.daysMonitored.toFixed(1)} days):\n${assessment.report}`;
        log(rateLimiterResult);
        // Write assessment to deep_process_outputs for human review
        try {
          const { writeDeepProcessOutput } = require('../deep-process.ts');
          await writeDeepProcessOutput({
            domain: 'infrastructure',
            process_name: 'rate-limiter-assessment',
            findings: assessment.actionSummary,
            summary: `Rate limiter monitoring complete: ${Object.keys(assessment.actionSummary).length} action types tracked over ${assessment.daysMonitored.toFixed(1)} days. Ready to set thresholds at 2x observed maximums.`,
            priority: 7,
            incorporated: false,
          }, (_l: string, m: string) => log(m));
          markAssessed();
          log('Rate limiter assessment written to deep_process_outputs + marked complete');
        } catch (e: any) {
          log(`WARNING: Failed to write rate assessment to Supabase: ${e.message}`);
        }
      } else {
        rateLimiterResult = assessment ? assessment.report : 'Rate limiter: not enough data yet';
        log(rateLimiterResult);
      }
    } else {
      rateLimiterResult = 'Rate limiter: monitoring (assessment not yet due)';
      log(rateLimiterResult);
    }
  } catch (e: any) {
    rateLimiterResult = `Rate limiter: failed (${e.message})`;
    log(`WARNING: ${rateLimiterResult}`);
  }

  // Defense Elements — Integrity Verification + Drift Baseline (Defense Elements #3 + #5)
  log('Infrastructure: Defense Element checks');
  let integrityResult = '';
  let driftResult = '';
  try {
    const { snapshotIntegrity, verifyIntegrity, setDriftBaseline, checkDrift } = require('../defense-elements.ts');

    // Integrity: snapshot → verify cycle
    // verifyIntegrity() returns a flat array of violations (not { tampered, verified })
    snapshotIntegrity();
    const violations = verifyIntegrity();
    if (violations.length > 0) {
      integrityResult = `INTEGRITY WARNING: ${violations.length} file(s) modified outside normal flow: ${violations.map((t: any) => t.file).join(', ')}`;
      log(`WARN: ${integrityResult}`);
    } else {
      integrityResult = `Integrity: all monitored files verified, 0 tampered`;
      log(integrityResult);
    }

    // Update Supabase integrity-monitor baseline if all critical files are git-clean
    // (no uncommitted changes). Modified-and-committed = legitimate drift, not compromise.
    // This prevents boy-who-cried-wolf false positives after heavy development days.
    try {
      const { getCriticalFiles, updateBaseline } = require('../integrity-monitor.ts');
      const criticalFiles = getCriticalFiles();
      const dirtyOutput = execSync('git diff --name-only HEAD', { encoding: 'utf8', cwd: ALIENKIND_DIR }).trim();
      const dirtyFiles = dirtyOutput ? dirtyOutput.split('\n') : [];
      const uncommittedCritical = criticalFiles.filter((f: string) => dirtyFiles.includes(f));
      if (uncommittedCritical.length === 0) {
        await updateBaseline();
        log('Integrity-monitor Supabase baseline updated (all critical files git-clean)');
      } else {
        log(`WARNING: ${uncommittedCritical.length} critical file(s) have uncommitted changes — baseline NOT updated: ${uncommittedCritical.join(', ')}`);
      }
    } catch (baselineErr: any) {
      log(`WARNING: Failed to update integrity-monitor baseline: ${baselineErr.message}`);
    }

    // Drift: set baseline from current state (comparison happens in subsequent runs)
    // Both functions require a metrics object
    const driftMetrics = { violations: violations.length, monitoredFiles: violations.length === 0 ? 1 : 0 };
    setDriftBaseline(driftMetrics);
    const driftCheck = checkDrift(driftMetrics);
    if (driftCheck.deviations && driftCheck.deviations.length > 0) {
      const warns = driftCheck.deviations.filter((d: any) => d.severity === 'warning' || d.severity === 'alert');
      driftResult = `Drift: ${warns.length} warning(s), ${driftCheck.deviations.length - warns.length} notice(s)`;
      if (warns.length > 0) {
        log(`WARN: Behavioral drift detected: ${warns.map((d: any) => `${d.metric}: ${d.message}`).join('; ')}`);
      }
    } else {
      driftResult = 'Drift: baseline set, no deviations';
    }
    log(driftResult);
  } catch (e: any) {
    integrityResult = `Defense elements failed: ${e.message}`;
    driftResult = '';
    log(`WARNING: ${integrityResult}`);
  }

  // Subscription reconciliation intentionally removed from the reference
  // nightly-immune job — partner-specific financial tooling belongs in a
  // forker's own module, not in the generic architecture.
  const subReconcileResult = '';

  // Fallibilism: check for stale facts and mark them
  let factsStaleCount = 0;
  try {
    const { getStaleFacts, markFactStale } = require('../facts.ts');
    const staleFacts = await getStaleFacts({ limit: 50 });
    for (const f of staleFacts) {
      await markFactStale(f.id, 'valid_until passed without reconfirmation');
      log(`Fallibilism: marked fact stale: "${(f.content || '').slice(0, 80)}" (type=${f.fact_type})`);
      factsStaleCount++;
    }
    if (factsStaleCount > 0) log(`Fallibilism: ${factsStaleCount} fact(s) marked stale`);
  } catch (e: any) {
    log(`WARN: Facts staleness check failed: ${e.message}`);
  }

  // Action Overwatch Meta-Audit — the partner reviews overwatch flags from the day
  log('Infrastructure: Action Overwatch Meta-Audit');
  let overwatchResult = '';
  try {
    const { getAgreementRate, detectAnomalies } = require('../action-overwatch.ts');
    const agreement = await getAgreementRate(1); // last 24h
    const anomalies = await detectAnomalies();
    const parts: string[] = [];
    parts.push(`Overwatch: ${(agreement.rate * 100).toFixed(1)}% agreement (${agreement.total} audited, ${agreement.disagreements} disagreements)`);
    if (anomalies.length > 0) {
      parts.push(`Anomalies: ${anomalies.map(a => `[${a.severity}] ${a.type}: ${a.description}`).join('; ')}`);
    }
    overwatchResult = parts.join('\n');
    log(overwatchResult);
  } catch (e: any) {
    overwatchResult = `Overwatch meta-audit: failed (${e.message})`;
    log(`WARNING: ${overwatchResult}`);
  }

  // Verification
  const verifyLines = verifyImmune();

  // Build final Telegram message
  const claudeSummary = result.outboxContent || 'Immune check completed (no outbox written)';
  const rotationLine = 'BUILD_LOG: retired (daily files are source of truth)';
  const preflightSection = preflightReport ? `\n---\nPREFLIGHT:\n${preflightReport.split('\n').slice(1).join('\n')}` : '';
  const subReconSection = subReconcileResult ? `\n${subReconcileResult}` : '';
  const defenseSection = integrityResult ? `\n${integrityResult}${driftResult ? '\n' + driftResult : ''}` : '';
  const rateLimiterSection = rateLimiterResult ? `\n${rateLimiterResult}` : '';
  const stateValidatorSection = stateValidatorResult ? `\n${stateValidatorResult}` : '';
  const overwatchSection = overwatchResult ? `\n${overwatchResult}` : '';
  const hygieneSection = hygieneResult ? `\n${hygieneResult}` : '';
  const telegramMsg = `${claudeSummary}\n---\nCommit: ${commitResult}\nMemory: ${indexResult.indexed} chunks indexed\n${rotationLine}\nBackup: ${backupTableCount} tables\nCleanup: ${cleanupDeleted} files${subReconSection}${defenseSection}${rateLimiterSection}${stateValidatorSection}${overwatchSection}${hygieneSection}\n${verifyLines.join('\n')}${preflightSection}`;
  appendToDigest('immune', telegramMsg);
  try { if (fs.existsSync(outboxFile)) fs.unlinkSync(outboxFile); } catch { /* ok */ }
  log('=== Nightly Immune Job Complete ===');
}

module.exports = { runImmune, runPreflight, runBackup, discoverTables, buildImmunePrompt, verifyImmune };
