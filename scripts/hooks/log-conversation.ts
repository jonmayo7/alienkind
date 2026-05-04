#!/usr/bin/env npx tsx

/**
 * log-conversation — UserPromptSubmit + Stop hook.
 *
 * Persists every exchange to the data core (Supabase `conversations` table).
 *
 * Correction detection lives in correction-to-ledger.ts (separate hook).
 * This hook is intentionally simple — its only job is to make sure every
 * turn lands durably so the nightly identity-sync has data to learn from.
 *
 * Fire-and-forget: always exits 0, never blocks the session.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const LOG_DIR = path.join(ROOT, 'logs');
const DEDUP_FILE = path.join(LOG_DIR, 'conversation-dedup.json');
const DEDUP_WINDOW_MS = 5000;

function ensureLogDir(): void {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val.replace(/[\r\n  ]+/g, '');
  }
  return env;
}

function supabasePost(envVars: Record<string, string>, table: string, data: any): void {
  const url = envVars.SUPABASE_URL;
  const key = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;

  const body = JSON.stringify(data);
  const target = new URL(`${url}/rest/v1/${table}`);
  const options = {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=ignore-duplicates',
    },
  };
  const req = https.request(target, options, (res: any) => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function isDuplicate(dedupKey: string): boolean {
  const now = Date.now();
  try {
    if (!fs.existsSync(DEDUP_FILE)) return false;
    const entries: Record<string, number> = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    return entries[dedupKey] && (now - entries[dedupKey]) < DEDUP_WINDOW_MS;
  } catch { return false; }
}

function recordDedup(dedupKey: string): void {
  const now = Date.now();
  try {
    let entries: Record<string, number> = {};
    try { entries = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')); } catch {}
    for (const key of Object.keys(entries)) {
      if (now - entries[key] > 30000) delete entries[key];
    }
    entries[dedupKey] = now;
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(entries));
  } catch {}
}

function logConversation(envVars: Record<string, string>, channel: string, role: string, sender: string, content: string, metadata: any = {}): void {
  if (!content || content.trim().length === 0) return;
  const hash = crypto.createHash('md5').update(content).digest('hex');
  const dedupKey = `${channel}|${sender}|${hash}`;
  if (isDuplicate(dedupKey)) return;
  recordDedup(dedupKey);
  supabasePost(envVars, 'conversations', {
    channel,
    visibility: 'private',
    role,
    sender,
    content,
    metadata,
  });
}

async function main() {
  ensureLogDir();

  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const envVars = loadEnv();
  const event = hookData.hook_event_name;
  const sessionId = hookData.session_id || null;

  if (event === 'UserPromptSubmit') {
    const prompt = hookData.prompt;
    if (prompt) {
      logConversation(envVars, 'terminal', 'user', 'human', prompt, { session_id: sessionId });
    }
  } else if (event === 'Stop') {
    const lastMsg = hookData.last_assistant_message;
    if (lastMsg) {
      logConversation(envVars, 'terminal', 'assistant', 'partner', lastMsg, { session_id: sessionId });
    }
  }

  setTimeout(() => process.exit(0), 500);
}

main().catch(() => process.exit(0));
