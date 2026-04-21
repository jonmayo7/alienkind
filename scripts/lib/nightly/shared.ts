/**
 * Nightly Cycle — Shared Config, State & Utilities
 *
 * All nightly phase modules import from here.
 * Module-level initialization runs once (Node caches requires).
 */

const { TIMEZONE, NIGHTLY, MODELS, PATHS, FAILOVER, FALLIBILISM } = require('../constants.ts');
process.env.TZ = TIMEZONE;

const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { watchOutput, gracefulKill } = require('../process.ts');
const { loadEnv, checkAuth, injectClaudeAuth, invokeEmergency } = require('../shared.ts');
const { processMessage, CHANNELS } = require('../keel-engine.ts');
const { writeCalibration, writePatterns, writeSocialGrowth, writeSkillMetrics, writeContentPerformance, writeMemories } = require('../substrate.ts');
const { loadConsciousnessContext, writeConsciousnessFromOutput } = require('../mycelium.ts');
const { buildAwarenessContext } = require('../awareness-context.ts');
const { searchMemory } = require('../memory-search.ts');
const { sendTelegram: _sendTelegramAsync, processQueue: _processQueue } = require('../telegram.ts');
const { formatAlert } = require('../alert-format.ts');
const { resolveConfig } = require('../portable.ts');
const PARTNER_NAME = resolveConfig('name', 'Partner');
const PARTNER_KEY = PARTNER_NAME.toLowerCase();
const PARTNER_PREFIX = PARTNER_NAME.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'partner';

// ─── Config ───

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..', '..');
const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
const CLAUDE_BIN = PATHS.claude;

// Load .env via shared module (applies secret normalization + permission hardening)
const env = loadEnv(path.join(ALIENKIND_DIR, '.env'));
Object.assign(process.env, env);

const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const TIME = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
const DAY_OF_WEEK = now.getDay(); // 0=Sunday, 5=Friday
const LOG_FILE = path.join(LOG_DIR, `nightly-${DATE}.log`);

const SKIP_BACKUP = process.argv.includes('--skip-backup');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Per-job ALLOWED_TOOLS
const ALLOWED_TOOLS_IMMUNE = 'Bash(git status *),Bash(git log *),Bash(git diff *),Read,Glob,Grep';
const ALLOWED_TOOLS_ANALYSIS = 'Bash(curl *),Bash(date *),Bash(ls *),Bash(wc *),Bash(git log *),Bash(git diff *),Read,Edit,Write,Glob,Grep';
const ALLOWED_TOOLS_IDENTITY_SYNC = 'Read,Edit,Write';
const ALLOWED_TOOLS_WEEKLY = 'Bash(curl *),Bash(date *),Bash(ls *),Bash(wc *),Bash(git log *),Bash(git diff *),Read,Edit,Write,Glob,Grep';

const FALLIBILISM_RETIREMENT_DAYS = 30; // also in constants.ts FALLIBILISM block

// Intent #32: Recovery mode
const isRecoveryMode = !!process.env.ALIENKIND_RECOVERY_DATE;
const recoveryType = process.env.ALIENKIND_RECOVERY_TYPE || 'unknown';
const recoveryPreamble = isRecoveryMode
  ? `\nRECOVERY MODE: You are running in catch-up mode (${recoveryType === 'missed' ? 'missed job — daemon was down at scheduled time' : 'retry after previous failure'}). Recovery timestamp: ${process.env.ALIENKIND_RECOVERY_DATE}. Current time: ${TIME}. You may be running hours after your normal schedule. Skip any time-sensitive real-time checks. Focus on analysis and synthesis of existing data.\n`
  : '';

// Known large tables for streaming backup
const STREAMING_TABLE_CONFIG: Record<string, string> = {
  'conversations': '',
  'memory_chunks': 'select=id,file_date,header,content,content_tsv,created_at,updated_at',
  'transcription_records': `created_at=gte.${new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]}`,
  'podcast_episodes': '',
  'articles': '',
  'deep_process_outputs': '',
  'signal_attribution': '',
  'discernment_outcomes': '',
  [`${PARTNER_PREFIX}_steward_conversations`]: '',
  'learning_ledger': '',
  'circulation': '',
};

const DIGEST_FILE = path.join(LOG_DIR, `nightly-digest-${DATE}.txt`);

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// Recover any pending Telegram messages from previous runs
_processQueue({ botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_ALERTS_CHAT_ID, log });

// ─── Utilities ───

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logHeap(label: string) {
  const usage = process.memoryUsage();
  const heapMB = Math.round(usage.heapUsed / 1048576);
  const rssMB = Math.round(usage.rss / 1048576);
  log(`[heap] ${label}: heap=${heapMB}MB, rss=${rssMB}MB`);
}

function querySupabase(table: string, query = '') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const result = execFileSync('/usr/bin/curl', [
      '-s',
      `${SUPABASE_URL}/rest/v1/${table}?${query}`,
      '-H', `apikey: ${SUPABASE_SERVICE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_SERVICE_KEY}`,
    ], { timeout: 10000 });
    return JSON.parse(result.toString());
  } catch (e: any) {
    log(`WARN: Supabase query ${table} failed: ${e.message}`);
    return null;
  }
}

function getSupabaseContext() {
  const ctx: string[] = [];

  const sessions = querySupabase('sessions', `select=id,session_type,summary&session_date=eq.${DATE}&order=created_at.desc&limit=20`);
  if (sessions && sessions.length > 0) {
    ctx.push(`Sessions today: ${sessions.length} (types: ${sessions.map((s: any) => s.session_type).join(', ')})`);
  } else {
    ctx.push('Sessions today: 0');
  }

  const patterns = querySupabase('patterns', 'select=id,description,occurrence_count,status&status=eq.active&order=occurrence_count.desc&limit=20');
  if (patterns && patterns.length > 0) {
    ctx.push('Existing active patterns (update occurrence_count via PATCH, do NOT re-create):');
    patterns.forEach((p: any) => ctx.push(`  - id=${p.id}: "${p.description}" (count: ${p.occurrence_count})`));
  } else {
    ctx.push('No existing patterns — create new ones.');
  }

  const allPatterns = querySupabase('patterns', 'select=id,description,occurrence_count,status,updated_at&status=neq.retired&status=neq.crystallized&order=updated_at.asc&limit=30');
  if (allPatterns && allPatterns.length > 0) {
    const { assessFreshness } = require('../health-engine.ts');
    const staleOnes = allPatterns.filter((p: any) => {
      if (!p.updated_at) return false;
      const assessment = assessFreshness(p.updated_at, FALLIBILISM.patternRetirementDays, 'pattern');
      return assessment.status !== 'healthy';
    });
    if (staleOnes.length > 0) {
      ctx.push(`Stale patterns approaching retirement (${FALLIBILISM.patternRetirementDays}d window):`);
      staleOnes.forEach((p: any) => {
        const days = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        ctx.push(`  - id=${p.id}: "${p.description}" (last active: ${days}d ago, count: ${p.occurrence_count})`);
      });
    }
  }

  const metrics = querySupabase('skill_metrics', `select=skill_name,metric_name,metric_value,measurement_date&order=measurement_date.desc&limit=15`);
  if (metrics && metrics.length > 0) {
    ctx.push('Recent skill metrics (for trend comparison):');
    metrics.forEach((m: any) => ctx.push(`  - ${m.skill_name}: ${m.metric_name} = ${m.metric_value} (${m.measurement_date})`));
  }

  const timeline = querySupabase('timeline', `select=event_type,description,created_at&order=created_at.desc&limit=5`);
  if (timeline && timeline.length > 0) {
    ctx.push('Recent timeline:');
    timeline.forEach((t: any) => ctx.push(`  - [${t.event_type}] ${t.description} (${t.created_at})`));
  }

  const social = querySupabase('social_growth', 'select=platform,engagement_count,followers_gained,follower_total,session_date&order=session_date.desc&limit=4');
  if (social && social.length > 0) {
    ctx.push('Recent social growth:');
    social.forEach((s: any) => ctx.push(`  - ${s.platform} (${s.session_date}): ${s.engagement_count} engagements, +${s.followers_gained} followers (total: ${s.follower_total})`));
  }

  const content = querySupabase('content_performance', 'select=content_type,title,engagement_rate,opens,date_published&order=date_published.desc&limit=5');
  if (content && content.length > 0) {
    ctx.push('Recent content performance:');
    content.forEach((c: any) => ctx.push(`  - ${c.content_type}: "${c.title}" (engagement: ${c.engagement_rate}%, opens: ${c.opens}, ${c.date_published})`));
  }

  const actions = querySupabase('deferred_actions', 'select=action,priority,due_date&status=eq.pending&order=priority.desc,due_date.asc&limit=5');
  if (actions && actions.length > 0) {
    ctx.push('Pending deferred actions (review and escalate overdue):');
    actions.forEach((a: any) => ctx.push(`  - [${a.priority}] ${a.action}${a.due_date ? ` (due: ${a.due_date})` : ''}`));
  }

  const memories = querySupabase('memories', 'select=content,category,importance&importance=gte.8&order=created_at.desc&limit=5');
  if (memories && memories.length > 0) {
    ctx.push('High-importance memories:');
    memories.forEach((m: any) => ctx.push(`  - [${m.category}, importance=${m.importance}] ${m.content.slice(0, 150)}`));
  }

  const convos = querySupabase('conversations', `select=channel&created_at=gte.${DATE}T00:00:00&limit=50`);
  if (convos && convos.length > 0) {
    const channels: Record<string, number> = {};
    convos.forEach((c: any) => { channels[c.channel] = (channels[c.channel] || 0) + 1; });
    ctx.push('Today\'s conversation volume:');
    Object.entries(channels).forEach(([ch, count]) => ctx.push(`  - ${ch}: ${count} messages`));
  }

  const experiences = querySupabase('experiences', `select=observation,domain,significance,tags,created_at&created_at=gte.${DATE}T00:00:00&order=significance.desc&limit=15`);
  if (experiences && experiences.length > 0) {
    ctx.push('Today\'s experiences (calibration layer):');
    experiences.forEach((e: any) => ctx.push(`  - [${e.domain}, sig=${e.significance}] ${e.observation.slice(0, 120)} (${e.created_at})`));
  }

  const predictions = querySupabase('predictions', `select=id,prediction,confidence,domain,resolved,created_at&created_at=gte.${DATE}T00:00:00&order=created_at.desc&limit=10`);
  if (predictions && predictions.length > 0) {
    ctx.push('Today\'s predictions:');
    predictions.forEach((p: any) => ctx.push(`  - [${p.domain}, conf=${p.confidence}] ${p.prediction.slice(0, 120)} (resolved: ${p.resolved})`));
  }

  const outcomes = querySupabase('outcomes', `select=outcome,delta_score,surprise_signal,learning,domain,created_at&created_at=gte.${DATE}T00:00:00&order=created_at.desc&limit=10`);
  if (outcomes && outcomes.length > 0) {
    ctx.push('Today\'s outcomes (prediction results):');
    outcomes.forEach((o: any) => ctx.push(`  - [${o.domain}, delta=${o.delta_score}${o.surprise_signal ? ', SURPRISE' : ''}] ${o.outcome.slice(0, 100)}${o.learning ? ' → ' + o.learning.slice(0, 80) : ''}`));
  }

  const unresolvedPreds = querySupabase('predictions', 'select=id,prediction,confidence,domain,created_at&resolved=eq.false&order=created_at.asc&limit=20');
  if (unresolvedPreds && unresolvedPreds.length > 0) {
    const byDomain: Record<string, number> = {};
    unresolvedPreds.forEach((p: any) => { byDomain[p.domain] = (byDomain[p.domain] || 0) + 1; });
    ctx.push(`UNRESOLVED PREDICTIONS (${unresolvedPreds.length} total — VGE calibration gap):`);
    ctx.push(`  By domain: ${Object.entries(byDomain).map(([d, c]) => `${d}: ${c}`).join(', ')}`);
    const oldest = unresolvedPreds[0];
    const oldestAge = Math.round((Date.now() - new Date(oldest.created_at).getTime()) / 86400000);
    ctx.push(`  Oldest: ${oldestAge} days old — "${oldest.prediction.slice(0, 100)}" [${oldest.domain}]`);
    if (unresolvedPreds.length > 5) {
      ctx.push(`  ⚠ ${unresolvedPreds.length} predictions logged but never resolved. The calibration layer cannot improve without outcome data.`);
    }
  }

  const recentOutcomes = querySupabase('outcomes', 'select=domain,delta_score,surprise_signal&order=created_at.desc&limit=25');
  if (recentOutcomes && recentOutcomes.length > 0) {
    const domainDeltas: Record<string, { total: number; count: number; surprises: number }> = {};
    recentOutcomes.forEach((o: any) => {
      if (!domainDeltas[o.domain]) domainDeltas[o.domain] = { total: 0, count: 0, surprises: 0 };
      domainDeltas[o.domain].count++;
      if (o.delta_score != null) domainDeltas[o.domain].total += parseFloat(o.delta_score);
      if (o.surprise_signal) domainDeltas[o.domain].surprises++;
    });
    ctx.push('DELTA CALIBRATION (recent 25 outcomes):');
    Object.entries(domainDeltas).forEach(([d, s]) => {
      const avg = s.count > 0 ? (s.total / s.count).toFixed(2) : 'N/A';
      ctx.push(`  - ${d}: avg delta=${avg}, ${s.surprises} surprises, ${s.count} outcomes`);
    });
  }

  const orientationExp = querySupabase('experiences', 'select=observation,domain,significance,created_at&orientation_relevant=eq.true&order=created_at.desc&limit=10');
  if (orientationExp && orientationExp.length > 0) {
    ctx.push('Recent orientation-relevant experiences (for identity/orientation.md updates):');
    orientationExp.forEach((e: any) => ctx.push(`  - [${e.domain}, sig=${e.significance}] ${e.observation.slice(0, 120)}`));
  }

  const intents = querySupabase('intents', `select=id,source,status,trigger_summary,created_at&created_at=gte.${DATE}T00:00:00&order=created_at.desc&limit=10`);
  if (intents && intents.length > 0) {
    const statusCounts: Record<string, number> = {};
    intents.forEach((i: any) => { statusCounts[i.status] = (statusCounts[i.status] || 0) + 1; });
    ctx.push(`Today's intents (${intents.length} total: ${Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`).join(', ')}):`);
    intents.forEach((i: any) => ctx.push(`  - #${i.id} [${i.status}] ${i.trigger_summary.slice(0, 120)}`));
  }

  const coordRequests = querySupabase('coordination_requests', `select=id,source_channel,sender,status,evaluation,proposed_response,coordination_notes,created_at&created_at=gte.${DATE}T00:00:00&order=created_at.desc&limit=20`);
  if (coordRequests && coordRequests.length > 0) {
    const coordCounts: Record<string, number> = {};
    coordRequests.forEach((r: any) => { coordCounts[r.status] = (coordCounts[r.status] || 0) + 1; });
    const proactive = coordRequests.filter((r: any) => r.sender === PARTNER_KEY).length;
    ctx.push(`Today's coordination requests (${coordRequests.length} total: ${Object.entries(coordCounts).map(([s, c]) => `${c} ${s}`).join(', ')}${proactive > 0 ? `, ${proactive} ${PARTNER_NAME}-initiated` : ''}):`);
    coordRequests.forEach((r: any) => {
      const notes = r.coordination_notes ? ` | the human: "${(r.coordination_notes || '').slice(0, 80)}"` : '';
      ctx.push(`  - [${r.status}] ${r.sender} via ${r.source_channel}: "${(r.evaluation || '').slice(0, 120)}"${notes}`);
    });
    const edited = coordRequests.filter((r: any) => r.coordination_notes && r.coordination_notes.includes('edited'));
    if (edited.length > 0) {
      ctx.push(`  LEARNING: the human edited ${edited.length} response(s). Compare original vs the human's version for calibration.`);
    }
    const rejected = coordRequests.filter((r: any) => r.status === 'rejected');
    if (rejected.length > 0) {
      ctx.push(`  LEARNING: ${rejected.length} rejected. Ask: "Why did the human reject?" for each.`);
    }
  }

  const ledger = querySupabase('learning_ledger', 'select=pattern_name,occurrence_count,category,sentiment,severity&order=occurrence_count.desc&limit=15');
  if (ledger && ledger.length > 0) {
    ctx.push('LEARNING LEDGER (TOP PATTERNS — highest frequency):');
    ledger.forEach((l: any) => ctx.push(`  - [${l.sentiment}, sev=${l.severity}, count=${l.occurrence_count}] ${l.pattern_name} (${l.category})`));
  }

  const recentDate = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const recentLedger = querySupabase('learning_ledger', `select=pattern_name,occurrence_count,correction_text,category,sentiment,severity,created_at&updated_at=gte.${recentDate}T00:00:00&order=updated_at.desc&limit=15`);
  if (recentLedger && recentLedger.length > 0) {
    ctx.push('LEARNING LEDGER (RECENT — last 7 days, what is active now):');
    recentLedger.forEach((l: any) => ctx.push(`  - [${l.sentiment}, sev=${l.severity}, count=${l.occurrence_count}] ${l.pattern_name}: "${(l.correction_text || '').slice(0, 150)}" (${l.category})`));
  }

  const { FALLIBILISM: FALL_CONST } = require('../constants.ts');
  const staleCutoff = new Date(Date.now() - FALL_CONST.ledgerStaleDays * 86400000).toISOString();
  const staleLedger = querySupabase('learning_ledger', `select=pattern_name,occurrence_count,correction_text,severity,updated_at&sentiment=eq.correction&updated_at=lt.${staleCutoff}&order=occurrence_count.desc&limit=10`);
  if (staleLedger && staleLedger.length > 0) {
    ctx.push(`STALE CORRECTIONS (not recurred in ${FALL_CONST.ledgerStaleDays}+ days — review whether still relevant):`);
    staleLedger.forEach((l: any) => {
      const days = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 86400000);
      ctx.push(`  - [${days}d stale, sev=${l.severity}, count=${l.occurrence_count}] ${l.pattern_name}: "${(l.correction_text || '').slice(0, 120)}"`);
    });
  }

  const activeFacts = querySupabase('facts', 'select=id,fact_type,content,valid_until,confidence,stale&stale=eq.false&order=valid_until.asc&limit=10');
  if (activeFacts && activeFacts.length > 0) {
    ctx.push('TRACKED DECISIONS/CONFIG (facts table — staleness-tracked):');
    activeFacts.forEach((f: any) => {
      const daysUntilExpiry = f.valid_until ? Math.floor((new Date(f.valid_until).getTime() - Date.now()) / 86400000) : 'N/A';
      ctx.push(`  - [${f.fact_type}, conf=${f.confidence}] "${(f.content || '').slice(0, 100)}" (expires in ${daysUntilExpiry}d)`);
    });
  }
  const staleFacts = querySupabase('facts', 'select=id,fact_type,content,valid_until&stale=eq.true&order=valid_until.asc&limit=5');
  if (staleFacts && staleFacts.length > 0) {
    ctx.push('STALE FACTS (expired decisions/config — need reconfirmation or retirement):');
    staleFacts.forEach((f: any) => ctx.push(`  - [${f.fact_type}] "${(f.content || '').slice(0, 100)}"`));
  }

  const digests = querySupabase('nightly_digests', 'select=digest_date,sections,telegram_message&order=digest_date.desc&limit=3');
  if (digests && digests.length > 0) {
    ctx.push('Recent nightly digests (for continuity and multi-day pattern detection):');
    digests.forEach((d: any) => {
      const phases = Object.keys(d.sections || {}).join(', ');
      const preview = (d.telegram_message || '').slice(0, 200);
      ctx.push(`  - ${d.digest_date} [${phases}]: ${preview}...`);
    });
  }

  const since24h = new Date(Date.now() - 24 * 3600000).toISOString();
  const pipelineTraces = querySupabase('pipeline_traces', `select=pipeline_name,status,duration_ms,created_at&created_at=gte.${since24h}&order=created_at.desc&limit=20`);
  if (pipelineTraces && pipelineTraces.length > 0) {
    const pHealth: Record<string, { runs: number; successes: number; failures: number; totalDuration: number }> = {};
    pipelineTraces.forEach((t: any) => {
      if (!pHealth[t.pipeline_name]) pHealth[t.pipeline_name] = { runs: 0, successes: 0, failures: 0, totalDuration: 0 };
      pHealth[t.pipeline_name].runs++;
      if (t.status === 'success') pHealth[t.pipeline_name].successes++;
      if (t.status === 'error') pHealth[t.pipeline_name].failures++;
      if (t.duration_ms) pHealth[t.pipeline_name].totalDuration += t.duration_ms;
    });
    ctx.push('PIPELINE HEALTH (last 24h — VGE observability):');
    Object.entries(pHealth).forEach(([name, h]) => {
      const avg = h.runs > 0 ? Math.round(h.totalDuration / h.runs) : 0;
      const rate = h.runs > 0 ? Math.round((h.successes / h.runs) * 100) : 0;
      ctx.push(`  - ${name}: ${h.runs} runs, ${rate}% success, ${h.failures} failures, avg ${avg}ms`);
    });
    const failing = Object.entries(pHealth).filter(([, h]) => h.failures > 0);
    if (failing.length > 0) {
      ctx.push(`  ⚠ ATTENTION: ${failing.map(([n]) => n).join(', ')} had failures — investigate in nightly analysis.`);
    }
  }

  const pFitness = querySupabase('pipeline_fitness', 'select=pipeline,metric_name,metric_value,measured_at&order=measured_at.desc&limit=20');
  if (pFitness && pFitness.length > 0) {
    ctx.push('PIPELINE FITNESS (AIRE health metrics):');
    pFitness.forEach((f: any) => ctx.push(`  - ${f.pipeline}: ${f.metric_name} = ${f.metric_value} (${f.measured_at})`));
  }

  // Substrate writes: cache Supabase data locally for heartbeat fallbacks
  if (patterns && patterns.length > 0) writePatterns(patterns);
  if (metrics && metrics.length > 0) writeSkillMetrics(metrics);
  if (social && social.length > 0) writeSocialGrowth(social);
  if (content && content.length > 0) writeContentPerformance(content);
  if (outcomes && outcomes.length > 0) writeCalibration({ outcomes, experiences: orientationExp || [] });
  if (memories && memories.length > 0) writeMemories(memories);

  return ctx.length > 0 ? '\n\nSUPABASE CONTEXT (live data — use this to avoid duplicates and track trends):\n' + ctx.join('\n') : '';
}

// ─── Logging ───

function logConversation({ channel, role, sender, content, visibility = 'private', metadata = {} }: any) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const body = JSON.stringify({ channel, visibility, role, sender, content, metadata });
  const url = new URL(`${SUPABASE_URL}/rest/v1/conversations`);
  const req = https.request(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
  }, (res: any) => {
    if (res.statusCode >= 400) {
      let data = '';
      res.on('data', (c: any) => data += c);
      res.on('end', () => log(`WARN: Conversation log failed (${res.statusCode}): ${data.slice(0, 200)}`));
    } else {
      res.resume();
    }
  });
  req.on('error', (e: any) => log(`WARN: Conversation log error: ${e.message}`));
  req.write(body);
  req.end();
}

function logSession(summary: string, jobName = 'nightly cycle') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const data = JSON.stringify([{
    session_date: DATE,
    session_type: 'scheduled',
    platform: 'scheduled',
    summary: `${jobName} at ${TIME}: ${summary.slice(0, 200).replace(/\n/g, ' ').trim()}`,
    skills_used: '{nightly-growth}',
  }]);
  const url = new URL(`${SUPABASE_URL}/rest/v1/sessions`);
  const opts = {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      'Content-Length': Buffer.byteLength(data),
    },
  };
  const req = https.request(opts, (res: any) => {
    res.resume();
    if (res.statusCode === 201) log('Session logged to Supabase');
    else log(`WARN: Supabase session log: ${res.statusCode}`);
  });
  req.on('error', (e: any) => log(`WARN: Supabase error: ${e.message}`));
  req.write(data);
  req.end();
}

function sendTelegram(text: string) {
  const formatted = text
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/`/g, '');
  _sendTelegramAsync(formatted, { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_ALERTS_CHAT_ID, parseMode: 'Markdown', log });
}

function appendToDigest(phase: string, content: string): void {
  // Strip duplicate phase header if Claude included one in its output
  const cleaned = content.replace(new RegExp(`^\\[${phase}\\]\\s*\\n?`), '');
  fs.appendFileSync(DIGEST_FILE, `[${phase}]\n${cleaned}\n\n`);
  log(`Appended ${phase} summary to nightly digest`);
}

// ─── Identity ───

function loadIdentityKernelContent(): string {
  const identityFiles = ['identity/character.md', 'identity/commitments.md', 'identity/orientation.md'];
  const sections: string[] = [];
  for (const sf of identityFiles) {
    const fp = path.join(ALIENKIND_DIR, sf);
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      if (content && content.trim().length > 0) {
        sections.push(`--- ${sf} ---\n${content.trim()}`);
      }
    } catch (e: any) {
      log(`WARN: Failed to read identity kernel file ${sf}: ${e.message}`);
    }
  }
  if (sections.length === 0) return '';
  return '\n\nIDENTITY KERNEL CONTEXT (identity grounding — loaded by parent script):\n' + sections.join('\n\n') + '\n';
}

// ─── Claude Invocation ───

async function attemptGrowthCycle({ promptText, maxTurns, overallTimeout, noOutputTimeout, allowedTools, outboxFile, jobName, model = MODELS.automated }: any) {
  const authResult = checkAuth();
  if (!authResult.ok) {
    log(`ERROR: Auth pre-check failed: ${authResult.reason}`);
    return { success: false, output: authResult.reason || '' };
  }

  // Identity-context gate removed — consciousness engine handles identity injection
  // for ALL invocations via injectIdentity: true (default). No manual gate needed.

  const jobLog = (level: string, msg: string) => log(msg);

  try {
    // Enforce overallTimeout as a hard deadline via Promise.race.
    // Previously overallTimeout was accepted but never used — the only
    // timeout was noOutputTimeout (fires only on silence). With 200 maxTurns
    // and a complex prompt, Opus produces continuous tool-call output, so
    // noOutputTimeout never fires. The session ran unbounded until the
    // daemon's 90m hard kill — which is what caused 3 consecutive failures
    // on 2026-04-12. This race ensures the session is capped at overallTimeout
    // regardless of activity.
    // Session persistence: daemon passes session ID via env vars.
    const daemonSessionId = process.env.ALIENKIND_DAEMON_SESSION_ID;
    const daemonSessionResume = process.env.ALIENKIND_DAEMON_SESSION_RESUME === 'true';

    const messagePromise = processMessage(promptText, {
      channelConfig: CHANNELS.nightly,
      log: jobLog,
      sender: 'system',
      senderDisplayName: `Nightly (${jobName})`,
      model,
      maxTurns,
      allowedTools,
      noOutputTimeout,
      overallTimeout,
      recentMessageCount: 0,
      ...(daemonSessionId && daemonSessionResume ? { resumeSessionId: daemonSessionId } : {}),
      ...(daemonSessionId && !daemonSessionResume ? { sessionId: daemonSessionId } : {}),
    });

    const TIMEOUT_SENTINEL = Symbol('overallTimeout');
    const timeoutPromise = overallTimeout
      ? new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
          setTimeout(() => resolve(TIMEOUT_SENTINEL), overallTimeout)
        )
      : null;

    const raced = timeoutPromise
      ? await Promise.race([messagePromise, timeoutPromise])
      : await messagePromise;

    if (raced === TIMEOUT_SENTINEL) {
      log(`WARN: ${jobName} hit overallTimeout (${Math.round(overallTimeout / 60000)}min) — treating partial output as best-effort`);
      // Check if outbox was written before timeout (partial success)
      const hasPartialOutbox = (() => {
        try { return fs.existsSync(outboxFile) && fs.statSync(outboxFile).size > 0; } catch { return false; }
      })();
      if (hasPartialOutbox) {
        const outboxContent = fs.readFileSync(outboxFile, 'utf-8').trim();
        log(`${jobName}: overallTimeout but outbox exists (${outboxContent.length} chars) — partial success`);
        return { success: true, stdout: '', outboxContent };
      }
      return { success: false, stdout: '', outboxContent: null };
    }

    const result = raced as Awaited<typeof messagePromise>;
    const stdout = result.text || '';

    const hasOutboxContent = (() => {
      try { return fs.existsSync(outboxFile) && fs.statSync(outboxFile).size > 0; } catch { return false; }
    })();
    const isSubstantialResponse = stdout.length > 200 || hasOutboxContent;

    if (stdout.length > 0 && stdout.length <= 200 && !hasOutboxContent) {
      log(`WARN: ${jobName} returned only ${stdout.length} bytes — likely not a real response. Content: ${stdout.slice(0, 200)}`);
    }

    if (isSubstantialResponse) {
      log(`${jobName} completed successfully`);
      log(`Response length: ${stdout.length} chars`);
      logSession(stdout, jobName);

      // Conversation logging handled by consciousness engine (channel: 'nightly')

      try {
        if (fs.existsSync(outboxFile)) {
          const outboxContent = fs.readFileSync(outboxFile, 'utf-8').trim();
          if (outboxContent) {
            log(`Outbox content found for ${jobName}`);
            return { success: true, stdout, outboxContent };
          }
        }
        log(`WARN: No outbox file for ${jobName}, using stdout`);
        return { success: true, stdout, outboxContent: null };
      } catch (e: any) {
        log(`WARN: Outbox processing failed: ${e.message}`);
        return { success: true, stdout, outboxContent: null };
      }
    } else {
      log(`ERROR: ${jobName} returned insufficient output (${stdout.length} bytes, no outbox)`);
      return { success: false, stdout, outboxContent: null };
    }
  } catch (err: any) {
    log(`ERROR: ${jobName} processMessage failed: ${err.message}`);
    log(`${jobName}: Attempting emergency runtime fallback...`);

    try {
      const emergencyResult = await invokeEmergency(promptText, {
        log: jobLog,
      });

      if (emergencyResult && emergencyResult.length > 200) {
        log(`${jobName} completed via emergency runtime (${emergencyResult.length} chars)`);
        logSession(emergencyResult, `${jobName} (emergency)`);

        const summary = emergencyResult.trim().slice(0, 500).replace(/\n/g, ' ');
        logConversation({
          channel: 'terminal',
          role: 'assistant',
          sender: PARTNER_KEY,
          content: summary,
          metadata: { session_type: jobName, runtime: 'emergency' },
        });

        // Check if emergency runtime wrote to outbox file
        try {
          if (fs.existsSync(outboxFile)) {
            const outboxContent = fs.readFileSync(outboxFile, 'utf-8').trim();
            if (outboxContent) {
              return { success: true, stdout: emergencyResult, outboxContent };
            }
          }
        } catch { /* ok */ }

        return { success: true, stdout: emergencyResult, outboxContent: null };
      } else {
        log(`ERROR: ${jobName} emergency runtime returned insufficient output (${(emergencyResult || '').length} chars)`);
        return { success: false, stdout: emergencyResult || '', outboxContent: null };
      }
    } catch (emergErr: any) {
      log(`ERROR: ${jobName} emergency runtime also failed: ${emergErr.message}`);
      return { success: false, stdout: '', outboxContent: null };
    }
  }
}

module.exports = {
  // Config
  ALIENKIND_DIR, LOG_DIR, CLAUDE_BIN, DATE, TIME, DAY_OF_WEEK, LOG_FILE,
  SKIP_BACKUP, DIGEST_FILE,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALERTS_CHAT_ID,
  NIGHTLY, MODELS, PATHS, FAILOVER, FALLIBILISM, FALLIBILISM_RETIREMENT_DAYS,
  ALLOWED_TOOLS_IMMUNE, ALLOWED_TOOLS_ANALYSIS, ALLOWED_TOOLS_IDENTITY_SYNC, ALLOWED_TOOLS_WEEKLY,
  STREAMING_TABLE_CONFIG,
  isRecoveryMode, recoveryPreamble,
  now, env,
  // Node modules (re-exported for phase modules)
  fs, path, https, execSync, execFileSync, spawn,
  // Imported libs
  formatAlert, writeSkillMetrics, writeConsciousnessFromOutput, loadConsciousnessContext,
  buildAwarenessContext, searchMemory,
  // Utilities
  log, logHeap, querySupabase, getSupabaseContext,
  logConversation, logSession, sendTelegram, appendToDigest,
  loadIdentityKernelContent, attemptGrowthCycle,
};
