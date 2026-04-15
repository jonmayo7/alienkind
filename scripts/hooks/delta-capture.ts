#!/usr/bin/env node

/**
 * Delta Capture — PostToolUse hook for unexpected tool results.
 *
 * Fires on: PostToolUse (Bash, Read, Edit, Write)
 * Logs anomalous/error results to keel_outcomes table.
 * Fire-and-forget: always exits 0, never blocks the session.
 *
 * What triggers a log:
 *   - tool_result.is_error === true
 *   - Known error patterns in output (file not found, permission denied, etc.)
 *   - Bash with non-zero exit code
 *
 * What does NOT trigger a log:
 *   - Successful, normal tool operations (no delta = no log)
 *
 * Writers: this hook (PostToolUse)
 * Readers: nightly analysis, calibration context, self-heal diagnostic
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(KEEL_DIR, '.env');

// Inline env loader (hooks must be self-contained — no shared.js import for perf)
function loadEnv() {
  const env = {};
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

// Anomaly detection patterns by tool type
const ANOMALY_PATTERNS = {
  Read: [
    { pattern: /no such file|not found|ENOENT/i, signal: 'file-not-found', delta: -0.5 },
    { pattern: /permission denied|EACCES/i, signal: 'permission-denied', delta: -0.8 },
    { pattern: /is a directory/i, signal: 'read-directory', delta: -0.3 },
  ],
  Bash: [
    { pattern: /command not found/i, signal: 'command-not-found', delta: -0.6 },
    { pattern: /permission denied/i, signal: 'permission-denied', delta: -0.8 },
    { pattern: /syntax error/i, signal: 'syntax-error', delta: -0.7 },
    { pattern: /ENOMEM|killed|out of memory/i, signal: 'out-of-memory', delta: -0.9 },
  ],
  Edit: [
    { pattern: /not found in file|not unique|no match|could not find/i, signal: 'edit-mismatch', delta: -0.4 },
    { pattern: /no such file|ENOENT/i, signal: 'file-not-found', delta: -0.6 },
    { pattern: /permission denied|EACCES/i, signal: 'permission-denied', delta: -0.8 },
  ],
  Write: [
    { pattern: /permission denied|EACCES/i, signal: 'permission-denied', delta: -0.8 },
    { pattern: /no space left|ENOSPC/i, signal: 'disk-full', delta: -0.9 },
  ],
};

function detectAnomaly(toolName, toolResult) {
  if (!toolResult) return null;

  const output = typeof toolResult === 'string'
    ? toolResult
    : (toolResult.output || toolResult.stderr || '');

  // is_error flag is the primary signal
  if (toolResult.is_error) {
    return { signal: 'tool-error', delta: -0.7, output: String(output).slice(0, 500) };
  }

  // Bash non-zero exit code
  if (toolName === 'Bash' && toolResult.exit_code && toolResult.exit_code !== 0) {
    return { signal: `exit-code-${toolResult.exit_code}`, delta: -0.5, output: String(output).slice(0, 500) };
  }

  // Check tool-specific patterns against output string
  const outputStr = String(output);
  const patterns = ANOMALY_PATTERNS[toolName] || [];
  for (const { pattern, signal, delta } of patterns) {
    if (pattern.test(outputStr)) {
      return { signal, delta, output: outputStr.slice(0, 500) };
    }
  }

  return null;
}

// Fire-and-forget Supabase POST
function logToSupabase(envVars, row) {
  if (!envVars.SUPABASE_URL || !envVars.SUPABASE_SERVICE_KEY) return;
  const body = JSON.stringify(row);
  const url = new URL(`${envVars.SUPABASE_URL}/rest/v1/keel_outcomes`);
  const req = https.request(url, {
    method: 'POST',
    headers: {
      'apikey': envVars.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${envVars.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
  }, (res) => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const toolResult = hookData.tool_result;
  const sessionId = hookData.session_id || null;

  // Fast path: check for anomaly — 95%+ of calls exit here in <5ms
  const anomaly = detectAnomaly(toolName, toolResult);
  if (!anomaly) process.exit(0);

  // Build input summary for the outcome record
  const inputSummary = toolName === 'Read' ? (toolInput.file_path || '').slice(0, 200)
    : toolName === 'Bash' ? (toolInput.command || '').slice(0, 200)
    : toolName === 'Edit' ? (toolInput.file_path || '').slice(0, 200)
    : toolName === 'Write' ? (toolInput.file_path || '').slice(0, 200)
    : JSON.stringify(toolInput).slice(0, 200);

  const envVars = loadEnv();

  logToSupabase(envVars, {
    prediction_id: null,
    outcome: `${toolName}(${inputSummary}): ${anomaly.signal}`,
    delta_score: anomaly.delta,
    surprise_signal: anomaly.signal,
    learning: anomaly.output || null,
    domain: 'tool-result',
    source_channel: 'terminal',
    session_id: sessionId,
  });

  // Let HTTP request drain. 200ms — original value, only fires on anomalies.
  setTimeout(() => process.exit(0), 200);
}

main().catch(() => process.exit(0));

// Export for testing
module.exports = { detectAnomaly, ANOMALY_PATTERNS };
