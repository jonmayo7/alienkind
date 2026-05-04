#!/usr/bin/env npx tsx

/**
 * correction-to-ledger — UserPromptSubmit hook.
 *
 * When the human's message contains corrective phrasing, persist a row to
 * `learning_ledger` (data core). The nightly identity-sync daemon reads
 * this table and promotes high-severity / high-occurrence patterns into
 * the identity kernel files.
 *
 * Replaces the older local-file flow (logs/recent-corrections.json) — the
 * data core is now the single source of truth for corrections, which means
 * any instance of the partner sees the same correction history.
 *
 * Fires on: UserPromptSubmit.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

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
    env[key] = val;
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
      'Prefer': 'return=minimal',
    },
  };
  const req = https.request(target, options, (res: any) => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// Pattern-based correction detector. The threshold is intentionally low;
// the daemon's identity-sync gates on severity + occurrence_count before
// promoting anything to the identity kernel.
const CORRECTION_PATTERNS: Array<{ pattern: RegExp; severity: number; name: string }> = [
  { pattern: /\b(?:i told you|i said|stop doing)/i, severity: 7, name: 'repeat-correction' },
  { pattern: /\b(?:that's wrong|incorrect|not right|you're wrong)/i, severity: 6, name: 'fact-correction' },
  { pattern: /^(?:no[,.\s!]+|stop\s+|don't\s+|never\s+)/i, severity: 5, name: 'directive-correction' },
];

const REINFORCEMENT_PATTERNS: Array<{ pattern: RegExp; severity: number; name: string }> = [
  { pattern: /\b(?:exactly right|perfect|nailed it|good catch)/i, severity: 5, name: 'reinforcement' },
];

function detectCorrection(prompt: string): { severity: number; name: string; sentiment: 'correction' | 'reinforcement' } | null {
  for (const { pattern, severity, name } of CORRECTION_PATTERNS) {
    if (pattern.test(prompt)) return { severity, name, sentiment: 'correction' };
  }
  for (const { pattern, severity, name } of REINFORCEMENT_PATTERNS) {
    if (pattern.test(prompt)) return { severity, name, sentiment: 'reinforcement' };
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  if (hookData.hook_event_name !== 'UserPromptSubmit') process.exit(0);

  const prompt = hookData.prompt || '';
  if (!prompt) process.exit(0);

  const detection = detectCorrection(prompt);
  if (!detection) process.exit(0);

  const envVars = loadEnv();

  // Hash to track repeats — if the same correction text comes back, it's a repeat
  // (the daemon will increment occurrence_count when promoting).
  const patternHash = crypto.createHash('md5').update(detection.name + ':' + prompt.slice(0, 200)).digest('hex').slice(0, 16);

  supabasePost(envVars, 'learning_ledger', {
    pattern_name: `${detection.name}-${patternHash}`,
    correction_text: prompt.slice(0, 1000),
    category: 'behavioral',
    sentiment: detection.sentiment,
    severity: detection.severity,
    source_channel: 'terminal',
    session_id: hookData.session_id || null,
  });

  // Allow async HTTP request to drain
  setTimeout(() => process.exit(0), 500);
}

main().catch(() => process.exit(0));
