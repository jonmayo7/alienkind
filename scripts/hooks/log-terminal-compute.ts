#!/usr/bin/env node

/**
 * Log terminal session compute usage to Supabase invocation_usage.
 *
 * Wired as a Stop hook (with session-level dedup via marker file).
 * Reads the transcript JSONL, sums token usage from all assistant messages,
 * and writes one row to invocation_usage with source='terminal'.
 *
 * Fire-and-forget: always exits 0 so it never blocks the session.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ALIENKIND_DIR, '.env');

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val.replace(/[\r\n\u2028\u2029]+/g, '');
  }
  return env;
}

async function parseTranscriptUsage(transcriptPath) {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    model: 'unknown',
    turnCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };

  if (!fs.existsSync(transcriptPath)) return totals;

  const modelCounts = {};

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue;

    const usage = obj.message.usage;
    const model = obj.message.model || 'unknown';
    const timestamp = obj.timestamp || null;

    totals.input_tokens += usage.input_tokens || 0;
    totals.output_tokens += usage.output_tokens || 0;
    totals.cache_creation_tokens += usage.cache_creation_input_tokens || 0;
    totals.cache_read_tokens += usage.cache_read_input_tokens || 0;
    totals.turnCount++;

    modelCounts[model] = (modelCounts[model] || 0) + 1;

    if (!totals.firstTimestamp) totals.firstTimestamp = timestamp;
    totals.lastTimestamp = timestamp;
  }

  // Most-used model wins
  let maxCount = 0;
  for (const [model, count] of Object.entries(modelCounts) as [string, number][]) {
    if (count > maxCount) {
      maxCount = count;
      totals.model = model;
    }
  }

  return totals;
}

function supabasePost(envVars: Record<string, string>, table: string, data: any) {
  if (!envVars.SUPABASE_URL || !envVars.SUPABASE_SERVICE_KEY) return;

  const body = JSON.stringify(data);
  const url = new URL(`${envVars.SUPABASE_URL}/rest/v1/${table}`);
  const req = https.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': envVars.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${envVars.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
  });
  req.on('error', () => { /* silent — fire and forget */ });
  req.write(body);
  req.end();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const event = hookData.hook_event_name;
  if (event !== 'Stop') process.exit(0);

  const sessionId = hookData.session_id || '';
  const transcriptPath = hookData.transcript_path || '';

  if (!sessionId || !transcriptPath) process.exit(0);

  // Session-level dedup: one compute log per session
  const markerFile = `/tmp/alienkind-terminal-compute-${sessionId}`;
  if (fs.existsSync(markerFile)) process.exit(0);

  // Write marker immediately (before async work)
  try {
    fs.writeFileSync(markerFile, String(Date.now()));
  } catch {
    // If we can't write the marker, skip to avoid duplicate logs
    process.exit(0);
  }

  const envVars = loadEnv();
  if (!envVars.SUPABASE_URL || !envVars.SUPABASE_SERVICE_KEY) process.exit(0);

  const totals = await parseTranscriptUsage(transcriptPath);

  // Only log if there was actual usage
  if (totals.turnCount === 0 || (totals.input_tokens === 0 && totals.output_tokens === 0)) {
    process.exit(0);
  }

  // Compute duration from first to last assistant message
  let durationMs = null;
  if (totals.firstTimestamp && totals.lastTimestamp) {
    durationMs = new Date(totals.lastTimestamp).getTime() - new Date(totals.firstTimestamp).getTime();
    if (durationMs < 0) durationMs = null;
  }

  supabasePost(envVars, 'invocation_usage', {
    job_name: 'terminal-interactive',
    source: 'terminal',
    model: totals.model,
    account: 'primary',
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_creation_tokens: totals.cache_creation_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    session_id: sessionId,
    duration_ms: durationMs,
  });

  // Let HTTP request drain. 500ms — proven stable, never lost writes.
  setTimeout(() => process.exit(0), 500);
}

main().catch(() => process.exit(0));
