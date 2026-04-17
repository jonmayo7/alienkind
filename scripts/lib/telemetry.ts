// @alienkind-core
/**
 * Telemetry — invocation usage logging.
 *
 * Records every model invocation with input/output tokens, model name,
 * duration, and source. Feeds compute-budget analysis and substrate policy
 * tuning. Best-effort write to Supabase; silently no-ops when Supabase isn't
 * configured.
 */

const fs = require('fs');
const path = require('path');

const portable = require('./portable.ts');
const { resolveRepoRoot } = portable;

const ROOT = resolveRepoRoot();

interface InvocationUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface InvocationMeta {
  jobName?: string;
  model?: string;
  account?: string;
  durationMs?: number;
  log?: (level: string, msg: string) => void;
}

/**
 * Log an invocation's token usage. Fire-and-forget.
 * If SUPABASE_URL + SUPABASE_SERVICE_KEY are set, writes to invocation_usage.
 * Otherwise writes a JSONL line to logs/invocation-usage.log for later import.
 */
function logInvocationUsage(usage: InvocationUsage, meta: InvocationMeta = {}): void {
  const entry = {
    source: 'partner',
    job_name: meta.jobName || null,
    model: meta.model || null,
    account: meta.account || null,
    duration_ms: meta.durationMs || null,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    created_at: new Date().toISOString(),
  };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (url && key) {
    try {
      const https = require('https');
      const body = JSON.stringify(entry);
      const u = new URL(`${url}/rest/v1/invocation_usage`);
      const req = https.request(u, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Prefer': 'return=minimal',
        },
      }, (res: any) => { res.resume(); });
      req.on('error', () => fallback(entry));
      req.write(body);
      req.end();
      return;
    } catch {
      fallback(entry);
    }
  } else {
    fallback(entry);
  }
}

function fallback(entry: any): void {
  try {
    const logPath = path.join(ROOT, 'logs', 'invocation-usage.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
}

/**
 * Extract usage object from a Claude JSON output. Handles both the stdout
 * format (stream-json) and the JSON-wrapped format.
 */
function extractUsageFromJson(data: string | Buffer): InvocationUsage | null {
  try {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    // Look for the first 'usage' object in the response
    const m = text.match(/"usage"\s*:\s*(\{[^}]+\})/);
    if (!m) return null;
    const parsed = JSON.parse(m[1]);
    return {
      input_tokens: parsed.input_tokens || parsed.prompt_tokens || 0,
      output_tokens: parsed.output_tokens || parsed.completion_tokens || 0,
      cache_creation_input_tokens: parsed.cache_creation_input_tokens || 0,
      cache_read_input_tokens: parsed.cache_read_input_tokens || 0,
    };
  } catch {
    return null;
  }
}

function getInvocationSource(): string {
  return process.env.INVOCATION_SOURCE || 'partner';
}

module.exports = {
  logInvocationUsage,
  extractUsageFromJson,
  getInvocationSource,
};
