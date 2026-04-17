#!/usr/bin/env node
const { TIMEZONE, HEARTBEAT } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Operational Pulse — pure Node.js, no Claude.
 *
 * Replaces the heartbeat `pulse` mode. Runs every 30 minutes.
 * Does NOT spawn Claude CLI — all operations are direct Node.js.
 *
 * Responsibilities:
 *   1. Read calendar cache → detect upcoming meetings
 *   2. If meeting in 60-90 min and no brief sent → spawn pre-call-brief.ts
 *   3. Read daily file for items flagged as urgent
 *   4. If urgent → send Telegram directly (no Claude)
 *   5. Write pulse entry to daily memory
 *   6. On regression hours → run test suites
 *
 * What this does NOT do:
 *   - Spawn Claude sessions (pre-call-brief.ts handles that when needed)
 *   - Manage session IDs
 *   - Build massive Supabase context prompts
 */

const fs = require('fs');
const path = require('path');
const { execSync, fork } = require('child_process');
const { readCalendarCache, writeCalendarCache } = require('./lib/calendar-cache.ts');
const { installRejectionHandler } = require('./lib/security.ts');

installRejectionHandler();

const ALIENKIND_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');

const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const HOUR = now.getHours();
const MINUTE = now.getMinutes();
const TIME = `${String(HOUR).padStart(2, '0')}:${String(MINUTE).padStart(2, '0')}`;
const LOG_FILE = path.join(LOG_DIR, `operational-pulse-${DATE}.log`);
const DAILY_FILE = path.join(ALIENKIND_DIR, 'memory', 'daily', `${DATE}.md`);

fs.mkdirSync(LOG_DIR, { recursive: true });

// Load env for Telegram
const { loadEnv, requireEnv } = require('./lib/shared.ts');
Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));
const { sendTelegram: _sendTelegramAsync, processQueue } = require('./lib/telegram.ts');
const { formatAlert } = require('./lib/alert-format.ts');

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = requireEnv('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID');
const TELEGRAM_ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || TELEGRAM_CHAT_ID;

// Recover pending Telegram messages from previous runs
processQueue({ botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_ALERTS_CHAT_ID, log });

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const { alertOperator: _alertOp } = require('./lib/alert-dispatcher.ts');
const { logToDaily: _logDaily, getNowCT } = require('./lib/keel-env.ts');

function sendTelegram(text: string): void {
  // Route through single source of truth dispatcher
  _alertOp({ severity: 'status', source: 'pulse', summary: text.slice(0, 200), detail: text.length > 200 ? text : undefined, cooldownMs: 0 });
}
function appendToDaily(text: string): void {
  _logDaily(text, undefined, false);
}

function readDaily(): string {
  try {
    if (fs.existsSync(DAILY_FILE)) return fs.readFileSync(DAILY_FILE, 'utf-8');
  } catch {}
  return '';
}

// --- PRIORITY 1: Calendar check + pre-call brief trigger ---

async function checkCalendar(): Promise<{ meetingDetected: boolean; briefTriggered: boolean }> {
  let cache = readCalendarCache();
  if (!cache || !cache.events || cache.events.length === 0) {
    // Cache stale or missing — refresh from Google Calendar
    try {
      const { listEvents } = require('./lib/google-calendar.ts');
      const { TIMEZONE } = require('./lib/constants.ts');
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
      const events = await listEvents({ timeMin: now.toISOString(), timeMax: endOfDay.toISOString() });
      if (events && events.length > 0) {
        const formatted = events.map((e: any) => {
          const start = new Date(e.start?.dateTime || e.start?.date);
          const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
          const fmt = (d: Date) => getNowCT(d);
          return { time: fmt(start), title: e.summary || '(no title)', end: end ? fmt(end) : undefined };
        });
        writeCalendarCache(formatted);
        cache = readCalendarCache();
        log(`Calendar: refreshed cache — ${formatted.length} event(s)`);
      } else {
        log('Calendar: no events remaining today');
        return { meetingDetected: false, briefTriggered: false };
      }
    } catch (err: any) {
      log(`Calendar: cache stale and refresh failed — ${err.message}`);
      return { meetingDetected: false, briefTriggered: false };
    }
    if (!cache || !cache.events || cache.events.length === 0) {
      return { meetingDetected: false, briefTriggered: false };
    }
  }

  log(`Calendar: ${cache.events.length} event(s) cached (updated ${cache.updatedAt})`);

  const nowMs = Date.now();
  const windowStartMs = HEARTBEAT.calendarWindowStart * 60 * 1000; // 60 min
  const windowEndMs = HEARTBEAT.calendarWindowEnd * 60 * 1000;     // 90 min

  for (const event of cache.events) {
    // Parse event time (format: "9:00 AM" or "14:00")
    const eventTime = parseEventTime(event.time);
    if (!eventTime) continue;

    const msUntil = eventTime - nowMs;
    if (msUntil >= windowStartMs && msUntil <= windowEndMs) {
      log(`Meeting detected in window: "${event.title}" at ${event.time} (${Math.round(msUntil / 60000)} min away)`);

      // Check if brief already sent
      const daily = readDaily();
      if (daily.includes(`BRIEF_SENT: ${event.title}`)) {
        log(`Brief already sent for "${event.title}" — skipping`);
        return { meetingDetected: true, briefTriggered: false };
      }

      // Trigger pre-call brief as child process
      log(`Triggering pre-call brief for "${event.title}"`);
      try {
        const briefScript = path.join(ALIENKIND_DIR, 'scripts', 'pre-call-brief.ts');
        const child = fork(briefScript, [event.title, event.time], {
          cwd: ALIENKIND_DIR,
          stdio: 'ignore',
          detached: true,
        });
        child.on('error', (err: any) => {
          log(`ERROR: Pre-call brief process failed: ${err.message}`);
        });
        child.on('exit', (code: number) => {
          if (code !== 0) log(`WARN: Pre-call brief exited with code ${code}`);
        });
        child.unref();
        return { meetingDetected: true, briefTriggered: true };
      } catch (e: any) {
        log(`ERROR: Failed to trigger pre-call brief: ${e.message}`);
        return { meetingDetected: true, briefTriggered: false };
      }
    }
  }

  return { meetingDetected: false, briefTriggered: false };
}

function parseEventTime(timeStr: string): number | null {
  try {
    const today = new Date();
    // Handle "9:00 AM" / "2:30 PM" format
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;

    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const ampm = match[3];

    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    }

    today.setHours(hours, minutes, 0, 0);
    return today.getTime();
  } catch {
    return null;
  }
}

// --- PRIORITY 2: Urgent item check (with dedup) ---

const URGENT_STATE_FILE = path.join(LOG_DIR, 'urgent-notifications-state.json');

interface UrgentState {
  /** Hash of the full urgent items list — only re-notify when content changes */
  contentHash: string;
  /** Timestamp of last notification */
  lastNotifiedAt: number;
  /** Individual items already seen (for tracking, not cooldown) */
  seenItems: Record<string, number>;
}

function loadUrgentState(): UrgentState {
  try {
    const raw = JSON.parse(fs.readFileSync(URGENT_STATE_FILE, 'utf-8'));
    return {
      contentHash: raw.contentHash || '',
      lastNotifiedAt: raw.lastNotifiedAt || 0,
      seenItems: raw.seenItems || {},
    };
  } catch {
    return { contentHash: '', lastNotifiedAt: 0, seenItems: {} };
  }
}

function saveUrgentState(state: UrgentState): void {
  try {
    const tmp = URGENT_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, URGENT_STATE_FILE);
  } catch (e: any) {
    log(`WARN: Failed to save urgent state: ${e.message}`);
  }
}

function checkUrgentItems(): string[] {
  const daily = readDaily();
  const urgentPatterns = [
    /(?<!\bnot\s)\bURGENT\b/i,                             // "urgent" but not "not urgent"
    /(?<!\b0\s)\bCRITICAL\b/i,                             // "critical" but not "0 critical"
    /(?<!\benqueues\s)\bBLOCKED\b(?!\s+(?:in\s+\d|on\s+the human))/i, // "blocked" but not "blocked in 60s" or "Blocked on the human"
    /\bFAILED.*(?:deploy|build|service)/i,
  ];

  const lines = daily.split('\n');
  const detected: string[] = [];
  const state = loadUrgentState();
  const now = Date.now();

  // Prune seen items older than 48 hours
  for (const [key, ts] of Object.entries(state.seenItems)) {
    if (now - ts > 172800000) delete state.seenItems[key];
  }

  // System-generated line patterns to skip — these reference keywords in non-actionable context
  const systemLinePatterns = [
    /^Pulse /,                                          // Pulse output lines
    /^\[DM /,                                           // DM transcripts
    /^Operator /,                                       // Operator session entries
    /^\*\*Operator/,                                    // Bold operator entries
    /^- \*\*\[Alerts/,                                  // Alert channel transcripts
    /^#+\s/,                                            // Markdown headers
    /urgent item\(?s?\)?/i,                             // Self-referential pulse count
    /delivered.*\burgent\b/i,                           // Narrative about past delivery
    /\bwas\b.*(false positive|resolved|fixed|handled)/i, // Past-tense resolved
    /^Trades:/,                                         // Crypto engine trade status lines ([blocked] is trade state, not infra)
    /^Crypto Engine/,                                   // Crypto engine cycle summaries
    /^I checked at/,                                     // Operator/keel status check narratives
    /^- Queue dedup/,                                    // Queue health metrics (not infra issues)
    /^\*\*Nightly cycle/i,                               // Nightly cycle summary (reports results, not problems)
    /^- \*\*Nightly cycle/i,                             // Bulleted nightly cycle summary
  ];

  // Scan last 50 lines for urgent keywords (skip system-generated entries)
  const recentLines = lines.slice(-50);
  for (const line of recentLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check system-generated exclusion patterns
    let isSystemLine = false;
    for (const sp of systemLinePatterns) {
      if (sp.test(trimmed)) {
        isSystemLine = true;
        break;
      }
    }
    if (isSystemLine) continue;

    for (const pattern of urgentPatterns) {
      if (pattern.test(trimmed)) {
        detected.push(trimmed.slice(0, 200));
        break;
      }
    }
  }

  if (detected.length === 0) {
    // No urgent items — clear state
    if (state.contentHash) {
      saveUrgentState({ contentHash: '', lastNotifiedAt: 0, seenItems: {} });
    }
    return [];
  }

  // Hash the detected items list — only notify if content CHANGED
  const crypto = require('crypto');
  const currentHash = crypto.createHash('md5').update(detected.sort().join('|')).digest('hex');

  if (currentHash === state.contentHash) {
    // Same items as last notification — suppress. Log for visibility.
    log(`Urgent items unchanged (${detected.length} tracked) — suppressing duplicate notification`);
    return [];
  }

  // Content changed — notify and update state
  state.contentHash = currentHash;
  state.lastNotifiedAt = now;
  for (const item of detected) {
    state.seenItems[item.slice(0, 100)] = now;
  }
  saveUrgentState(state);

  return detected;
}

// --- Usage Monitor Alert Backoff ---
// Prevents 41+ identical "STALE" alerts when usage-monitor is down for hours.
// Schedule: first alert immediately, then 4h, 12h, every 24h after.

const USAGE_ALERT_STATE_FILE = path.join(LOG_DIR, 'usage-alert-state.json');

interface UsageAlertState {
  consecutiveStale: number;
  lastAlertAt: number;   // epoch ms
  lastAlertHoursStale: number;
}

function loadUsageAlertState(): UsageAlertState {
  try {
    return JSON.parse(fs.readFileSync(USAGE_ALERT_STATE_FILE, 'utf-8'));
  } catch {
    return { consecutiveStale: 0, lastAlertAt: 0, lastAlertHoursStale: 0 };
  }
}

function saveUsageAlertState(state: UsageAlertState): void {
  try {
    fs.writeFileSync(USAGE_ALERT_STATE_FILE, JSON.stringify(state));
  } catch {}
}

// Returns true if alert should fire based on backoff schedule
function shouldFireUsageAlert(state: UsageAlertState): boolean {
  if (state.consecutiveStale <= 1) return true; // first detection: always alert
  const backoffHoursSchedule = [0, 4, 12, 24]; // hours between alerts by occurrence
  const idx = Math.min(state.consecutiveStale - 1, backoffHoursSchedule.length - 1);
  const minIntervalMs = backoffHoursSchedule[idx] * 3600000;
  return (Date.now() - state.lastAlertAt) >= minIntervalMs;
}

// --- PRIORITY 3: X Mention Monitoring ---

const MENTIONS_STATE_FILE = path.join(LOG_DIR, 'x-mentions-state.json');

interface MentionsState {
  human_since_id?: string;
  keel_since_id?: string;
  last_checked?: string;
}

function loadMentionsState(): MentionsState {
  try { return JSON.parse(fs.readFileSync(MENTIONS_STATE_FILE, 'utf-8')); } catch { return {}; }
}

function saveMentionsState(state: MentionsState): void {
  try {
    const tmp = MENTIONS_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, MENTIONS_STATE_FILE);
  } catch (e: any) { log(`WARN: Failed to save mentions state: ${e.message}`); }
}

async function checkXMentions(): Promise<string[]> {
  const { getMentions } = require('./post-to-x.ts');
  const { loadEnv: _loadEnv } = require('./lib/shared.ts');
  const env = _loadEnv(path.join(ALIENKIND_DIR, '.env'));
  Object.assign(process.env, env);

  const state = loadMentionsState();
  const newMentions: string[] = [];

  // Check [@YOUR_HANDLE] mentions
  const ownerUserId = env.X_ACCESS_TOKEN.split('-')[0];
  try {
    const ownerResult = await getMentions(env, ownerUserId, state.human_since_id);
    if (ownerResult.data && ownerResult.data.length > 0) {
      for (const tweet of ownerResult.data) {
        newMentions.push(`[@YOUR_HANDLE] mentioned: "${tweet.text.slice(0, 100)}" (${tweet.id})`);
      }
      if (ownerResult.meta?.newest_id) state.human_since_id = ownerResult.meta.newest_id;
    }
  } catch (err: any) {
    log(`WARN: the human mentions check failed: ${err.message}`);
  }

  // Check [@PARTNER_HANDLE] mentions
  if (env.ALIENKIND_X_ACCESS_TOKEN) {
    const keelEnv = { ...env, X_ACCESS_TOKEN: env.ALIENKIND_X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET: env.ALIENKIND_X_ACCESS_TOKEN_SECRET };
    const keelUserId = env.ALIENKIND_X_ACCESS_TOKEN.split('-')[0];
    try {
      const keelResult = await getMentions(keelEnv, keelUserId, state.keel_since_id);
      if (keelResult.data && keelResult.data.length > 0) {
        for (const tweet of keelResult.data) {
          newMentions.push(`[@PARTNER_HANDLE] mentioned: "${tweet.text.slice(0, 100)}" (${tweet.id})`);
        }
        if (keelResult.meta?.newest_id) state.keel_since_id = keelResult.meta.newest_id;
      }
    } catch (err: any) {
      log(`WARN: Keel mentions check failed: ${err.message}`);
    }
  }

  state.last_checked = new Date().toISOString();
  saveMentionsState(state);
  return newMentions;
}

// --- PRIORITY 4: Regression tests (on regression hours) ---

function runRegressionTests(): void {
  if (!HEARTBEAT.regressionHours || !HEARTBEAT.regressionHours.includes(HOUR)) return;

  log('Running regression test suites...');
  const testSuites = [
    'test-daemon.ts', 'test-telegram-session.ts', 'test-telegram-flow.ts',
    'test-discord-flow.ts', 'test-discord-multichannel.ts',
    'test-nightly-flow.ts', 'test-heartbeat-flow.ts',
    'test-verify-gap-closure.ts',
    'test-heartbeat-verify.ts', 'test-harness-completeness.ts',
  ];

  let totalPass = 0, totalFail = 0;
  const failures: string[] = [];

  for (const suite of testSuites) {
    const suitePath = path.join(ALIENKIND_DIR, 'scripts', 'tests', suite);
    if (!fs.existsSync(suitePath)) {
      log(`WARN: Test suite not found: ${suite}`);
      continue;
    }
    try {
      const out = execSync(`node "${suitePath}"`, { timeout: 30000, cwd: ALIENKIND_DIR, stdio: 'pipe' }).toString();
      const passMatch = out.match(/(\d+)\s+passed/);
      const failMatch = out.match(/(\d+)\s+failed/);
      if (passMatch) totalPass += parseInt(passMatch[1]);
      if (failMatch) {
        totalFail += parseInt(failMatch[1]);
        if (parseInt(failMatch[1]) > 0) failures.push(suite);
      }
    } catch (e: any) {
      totalFail++;
      failures.push(suite);
      log(`WARN: Test suite ${suite} failed: ${e.message.slice(0, 200)}`);
    }
  }

  log(`Regression results: ${totalPass} passed, ${totalFail} failed across ${testSuites.length} suites`);
  if (failures.length > 0) {
    sendTelegram(formatAlert({
      severity: 'action',
      source: 'regression tests',
      summary: `${totalFail} failure(s) in ${failures.join(', ')}`,
      detail: `${totalPass} passing`,
      nextStep: 'check test output in a terminal session',
    }));
  }
}

// --- Main execution ---

log(`Operational pulse starting: hour=${HOUR}, minute=${MINUTE}`);

(async () => {
  const parts: string[] = [];

  // 1. Calendar + pre-call brief
  const calResult = await checkCalendar();
  if (calResult.meetingDetected) parts.push(calResult.briefTriggered ? 'pre-call brief triggered' : 'meeting noted');

  // 2. Urgent items — log only, don't alert the human (these are parsed from daily file, not actionable)
  const urgentItems = checkUrgentItems();
  if (urgentItems.length > 0) {
    log(`Urgent items detected (logged, not alerted): ${urgentItems.join('; ')}`);
    // Include actual content so VGE findings carry detail, not just a count
    const detail = urgentItems.map(i => i.slice(0, 120)).join('; ');
    parts.push(`${urgentItems.length} urgent item(s): ${detail}`);
  }

  // 3. Compute data health — verify OTEL collector is writing data to Supabase.
  // OTEL is the primary consumption data source (since Apr 8, replacing usage-monitor).
  // Subscription utilization % is on-demand only (refresh-usage.ts).
  try {
    const usageAlertState = loadUsageAlertState();
    let otelHealthy = false;
    try {
      const { supabaseGet } = require('./lib/supabase.ts');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const result = await supabaseGet('invocation_usage', `select=id&source=eq.otel-collector&created_at=gte.${twoHoursAgo}&limit=1`);
      otelHealthy = Array.isArray(result) && result.length > 0;
    } catch { /* Supabase query failed — can't determine health */ }

    if (!otelHealthy) {
      usageAlertState.consecutiveStale++;
      if (shouldFireUsageAlert(usageAlertState)) {
        const msg = formatAlert({
          severity: 'action',
          source: 'OTEL collector',
          summary: 'no compute data in last 2h — collector may be down',
          nextStep: 'check: launchctl list | grep otel',
        });
        log(msg);
        sendTelegram(msg);
        usageAlertState.lastAlertAt = Date.now();
      } else {
        log(`OTEL data stale — alert suppressed (backoff #${usageAlertState.consecutiveStale})`);
      }
      parts.push('OTEL data stale');
      saveUsageAlertState(usageAlertState);
    } else {
      if (usageAlertState.consecutiveStale > 0) {
        log('OTEL data healthy — clearing stale state');
        saveUsageAlertState({ consecutiveStale: 0, lastAlertAt: 0, lastAlertHoursStale: 0 });
      }
    }
  } catch (err: any) {
    log(`WARN: Compute health check failed: ${err.message}`);
  }

  // 4. Comms health check — verify Telegram listener is alive
  try {
    const { checkTelegramHealth, escalateToDiscord } = require('./lib/comms-failover.ts');
    const tgHealthy = await checkTelegramHealth((msg: string) => log(msg));
    if (!tgHealthy) {
      const msg = 'Telegram listener appears down — API unreachable or process not running.';
      log(msg);
      // Try Telegram first (API might work even if listener is down)
      sendTelegram(msg);
      // Also escalate to Discord DM as contingent
      await escalateToDiscord(msg, { log: (level: string, m: string) => log(`[${level}] ${m}`) });
      parts.push('telegram UNHEALTHY');
    }
  } catch (err: any) {
    log(`WARN: Comms health check failed: ${err.message}`);
  }

  // 5. X mention monitoring — ARCHIVED 2026-03-31 (X premium canceled)
  // checkXMentions() still exists but is not called. Remove entirely in Phase 5 purge.

  // 6. OAuth token health check (once daily, first pulse before 5 AM)
  if (HOUR < 5) {
    try {
      const envContent = fs.readFileSync(path.join(ALIENKIND_DIR, '.env'), 'utf8');
      const tokenChecks = [
        { name: 'CLAUDE_OAUTH_TOKEN_PRIMARY', label: 'primary', configDir: '__REPO_ROOT__/.claude' },
        { name: 'CLAUDE_OAUTH_TOKEN_SECONDARY', label: 'secondary', configDir: '__REPO_ROOT__/.claude-auto' },
      ];
      for (const { name, label, configDir } of tokenChecks) {
        const match = envContent.match(new RegExp(`${name}=(.+)`));
        if (!match) {
          const msg = formatAlert({
            severity: 'action',
            source: 'auth',
            summary: `OAuth token missing: ${label}`,
            nextStep: 'run: claude setup-token',
          });
          log(msg); sendTelegram(msg);
          parts.push(`${label} token MISSING`);
          continue;
        }
        try {
          const testEnv: Record<string, string> = {
            HOME: process.env.HOME || '', PATH: process.env.PATH || '',
            SHELL: process.env.SHELL || '', TMPDIR: process.env.TMPDIR || '/tmp',
          };
          testEnv.CLAUDE_CODE_OAUTH_TOKEN = match[1].trim();
          testEnv.CLAUDE_CONFIG_DIR = configDir;
          const result = execSync('echo "OK" | claude -p --max-turns 1 2>&1', {
            env: testEnv, timeout: 30000, cwd: ALIENKIND_DIR,
          }).toString().trim();
          if (result.toLowerCase().includes('not logged in') || result.toLowerCase().includes('authentication')) {
            const msg = formatAlert({
              severity: 'action',
              source: 'auth',
              summary: `OAuth token EXPIRED: ${label}`,
              nextStep: 'run: claude setup-token',
            });
            log(msg); sendTelegram(msg);
            parts.push(`${label} token EXPIRED`);
          }
        } catch {
          log(`WARN: Token validation for ${label} inconclusive — will retry next pulse`);
        }
      }
    } catch (err: any) {
      log(`WARN: OAuth token check failed: ${err.message}`);
    }
  }

  // 7. Regression tests
  runRegressionTests();

  // 8. VGE Wire #5: Write significant findings to deep_process_outputs
  // Converts operational detections into incorporation-ready findings
  if (parts.length > 0) {
    const significantParts = parts.filter(p =>
      p.includes('urgent') || p.includes('STALE') || p.includes('MISSING') ||
      p.includes('UNHEALTHY') || p.includes('EXPIRED') || p.includes('token') ||
      p.includes('stale intent')
    );
    if (significantParts.length > 0) {
      try {
        const { writeDeepProcessOutput } = require('./lib/deep-process.ts');
        // Write per-issue findings with stable summaries for proper dedup.
        // Composite summaries (count + joined list) broke dedup when other issues
        // appeared simultaneously, changing the summary string. (13 duplicates from
        // one 157h usage-monitor-stale incident on 2026-03-21.)
        let written = 0;
        let deduped = 0;
        for (const issue of significantParts) {
          const result = await writeDeepProcessOutput({
            domain: 'infrastructure',
            process_name: 'operational-pulse',
            findings: {
              detection: issue,
              pulse_time: `${DATE}T${TIME}`,
              all_parts: parts,
            },
            summary: `operational-pulse: ${issue}`,
            priority: issue.includes('EXPIRED') || issue.includes('MISSING') ? 8 : 6,
            incorporated: false,
          }, (level: string, msg: string) => log(`VGE: [${level}] ${msg}`));
          if (result.written) written++;
          else deduped++;
        }
        if (written > 0) log(`VGE: Wrote ${written} finding(s) to deep_process_outputs for incorporation`);
        if (deduped > 0) log(`VGE: Dedup — skipped ${deduped} duplicate finding(s)`);
        parts.push('VGE: findings logged');
      } catch (err: any) {
        log(`WARN: VGE write to deep_process_outputs failed: ${err.message}`);
      }
    }
  }

  // 9. Silent evaluator failure detector — meta-health check on judgment systems
  // Intent #167: Checks coordination_requests for consecutive "Evaluation failed" entries
  try {
    const { supabaseGet } = require('./lib/supabase.ts');
    const recent = await supabaseGet(
      'coordination_requests',
      'select=id,evaluation,created_at&order=created_at.desc&limit=10'
    );
    if (recent.length >= 5) {
      const consecutiveFailures = recent.findIndex(
        (r: any) => !(r.evaluation || '').startsWith('Evaluation failed')
      );
      const failCount = consecutiveFailures === -1 ? recent.length : consecutiveFailures;
      if (failCount >= 5) {
        const oldest = recent[failCount - 1]?.created_at || 'unknown';
        const msg = `Judgment system silent failure: ${failCount} consecutive evaluation failures in coordination_requests (since ${new Date(oldest).toLocaleString('en-US', { timeZone: TIMEZONE })}). The evaluator is defaulting to silent — external messages are being dropped without real assessment.`;
        log(msg);
        sendTelegram(msg);
        parts.push(`evaluator SILENT_FAIL (${failCount}x)`);
      }
    }
  } catch (err: any) {
    log(`WARN: Silent evaluator check failed: ${err.message}`);
  }

  // 10. Intent staleness detection — surfaces intents stuck in executing/approved
  // Intent #218: Intents sitting in 'executing' or 'approved' for >24h indicate
  // work that was declared but never completed. Pulse logs them for downstream review.
  try {
    const { supabaseGet: _sbGet } = require('./lib/supabase.ts');
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    // Query intents in executing state where approved_at (or created_at) is older than 24h
    const staleExecuting = await _sbGet(
      'intents',
      `select=id,trigger_summary,status,approved_at,created_at&status=eq.executing&approved_at=lt.${cutoff}&order=approved_at.asc&limit=20`
    );

    // Also check approved-but-never-started intents (approved >24h ago, still not executing)
    const staleApproved = await _sbGet(
      'intents',
      `select=id,trigger_summary,status,approved_at,created_at&status=eq.approved&approved_at=lt.${cutoff}&order=approved_at.asc&limit=20`
    );

    const allStale = [...staleExecuting, ...staleApproved];
    if (allStale.length > 0) {
      const staleIds = allStale.map((i: any) => `#${i.id}`).join(', ');
      const details = allStale.map((i: any) => {
        const since = i.approved_at || i.created_at;
        const hoursStale = Math.round((Date.now() - new Date(since).getTime()) / 3600000);
        return `#${i.id} (${i.status}, ${hoursStale}h): ${(i.trigger_summary || '').slice(0, 80)}`;
      });
      log(`Stale intents detected (${allStale.length}): ${details.join('; ')}`);
      parts.push(`${allStale.length} stale intent(s): ${staleIds}`);
    }
  } catch (err: any) {
    log(`WARN: Intent staleness check failed: ${err.message}`);
  }

  // 11. a client product feedback monitor — notify once per entry with assessment
  try {
    const { supabaseGet, supabasePatch } = require('./lib/supabase.ts');
    const feedback = await supabaseGet(
      'client_product_c_feedback',
      'select=id,type,description,page_url,created_at&notified=is.null&order=created_at.desc&limit=10'
    );
    if (feedback.length > 0) {
      for (const f of feedback) {
        // Assess severity and recommend action
        const isIssue = f.type === 'issue';
        const isEnhancement = f.type === 'enhancement';
        const severity = isIssue ? 'ACTION NEEDED' : isEnhancement ? 'ENHANCEMENT' : 'QUESTION';
        const page = f.page_url ? f.page_url.replace('https://[client-product-c].[YOUR_DOMAIN]', '') : 'unknown page';

        let recommendation = '';
        if (isIssue) {
          recommendation = '\n\nRecommendation: Investigate and fix. This is a reported issue — user experienced something broken or confusing.';
        } else if (isEnhancement) {
          recommendation = '\n\nRecommendation: Add to enhancement backlog. Evaluate priority against April 15 board meeting deadline.';
        } else {
          recommendation = '\n\nRecommendation: Review and determine if the answer is in the UI (add tooltip/info) or requires a response.';
        }

        const msg = `a client product Feedback [${severity}]\nPage: ${page}\nType: ${f.type}\nDescription: ${f.description.slice(0, 300)}${recommendation}`;
        log(msg);
        sendTelegram(msg);

        // Mark as notified so we don't alert again
        try {
          await supabasePatch('client_product_c_feedback', f.id, { notified: true });
        } catch {
          // notified column may not exist yet — that's fine, add it
        }
      }
      parts.push(`[client-product-c] feedback: ${feedback.length} new`);
    }
  } catch (err: any) {
    if (!err.message?.includes('client_product_c_feedback') && !err.message?.includes('notified')) {
      log(`WARN: [client-product-c] feedback check failed: ${err.message}`);
    }
  }

  // 12. Auto-remediation — detect/fix/track known infrastructure issues
  try {
    const { runRemediation } = require('./lib/auto-remediate.ts');
    const remediation = await runRemediation(log);
    if (remediation.total > 0) {
      parts.push(`${remediation.total} auto-fix(es): ${remediation.actions.join(', ')}`);
      log(`Auto-remediation: ${remediation.total} fix(es) applied`);
    }
  } catch (remErr: any) {
    log(`WARN: Auto-remediation failed: ${remErr.message}`);
  }

  // 13. Deposit significant findings into circulation
  if (parts.length > 0) {
    try {
      const { deposit } = require('./lib/circulation.ts');
      const significantForCirculation = parts.filter(p =>
        p.includes('auto-fix') || p.includes('urgent') || p.includes('STALE') ||
        p.includes('pre-call') || p.includes('regression') || p.includes('intent')
      );
      for (const finding of significantForCirculation) {
        await deposit({
          source_organ: 'operational-pulse',
          finding,
          finding_type: finding.includes('auto-fix') ? 'anomaly' : 'observation',
          domain: 'infrastructure',
          confidence: 0.7,
        });
      }
    } catch { /* circulation unavailable — non-fatal */ }
  }

  // 14. Process circulation Telegram outbox (pump runs in builder mode, can't send directly)
  try {
    const outboxFile = path.join(ALIENKIND_DIR, 'logs', 'circulation-telegram-outbox.txt');
    if (fs.existsSync(outboxFile)) {
      const content = fs.readFileSync(outboxFile, 'utf-8').trim();
      if (content) {
        const messages = content.split('\n---TELEGRAM_MSG---\n').filter((m: string) => m.trim());
        if (messages.length > 0) {
          const { sendTelegramAlert } = require('./lib/telegram.ts');
          const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
          const ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
          for (const msg of messages) {
            try {
              sendTelegramAlert(msg.trim(), { botToken: BOT_TOKEN, chatId: ALERTS_CHAT_ID, log });
            } catch {}
          }
          fs.unlinkSync(outboxFile);
          parts.push(`${messages.length} circulation alert(s) sent`);
          log(`Sent ${messages.length} circulation T2 alert(s) via Telegram`);
        }
      }
    }
  } catch (err: any) {
    log(`WARN: Circulation outbox processing failed: ${err.message}`);
  }

  // 15. Write pulse entry
  const suffix = parts.length > 0 ? ` — ${parts.join(', ')}` : ': all clear';
  appendToDaily(`Pulse ${TIME}${suffix}`);

  log(`Operational pulse complete${suffix}`);
  process.exit(0);
})();

