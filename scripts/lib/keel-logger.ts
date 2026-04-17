// @alienkind-core
/**
 * Logger — shared logging primitives for scripts, hooks, and daemon jobs.
 *
 * - createLogger: tagged file + stdout logger with level filtering
 * - classifyMessage: simple keyword-based message classifier (heavy by default)
 * - logConversation: Supabase conversation writer (best-effort, never blocks)
 *
 * Kept thin so forkers can swap in richer implementations (structured logging,
 * OpenTelemetry, etc.) without refactoring callers.
 */

const fs = require('fs');
const path = require('path');

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Create a tagged logger that writes to both stdout and a file.
 * Never throws — logging failures are silent.
 */
function createLogger(logFile?: string) {
  const logDir = logFile ? path.dirname(logFile) : null;
  if (logDir) {
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ok */ }
  }
  const log = (level: LogLevel, message: string) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    try { console.log(line); } catch { /* ok */ }
    if (logFile) {
      try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ok */ }
    }
  };
  return { log };
}

/**
 * Classify message complexity. All messages resolve to 'heavy' by default —
 * the COMPLEXITY config in constants.ts currently defines a single tier.
 * Forkers who want tiered dispatch can extend this with their own heuristics.
 */
function classifyMessage(_content: string): 'heavy' {
  return 'heavy';
}

/**
 * Write a conversation entry to Supabase. Fire-and-forget — never blocks.
 * Returns void. Callers don't need to await.
 */
function logConversation(
  entry: { channel: string; role: 'user' | 'assistant' | 'system'; sender: string; content: string; visibility?: string; model?: string; metadata?: Record<string, any> },
  config?: { supabaseUrl?: string; supabaseKey?: string; log?: (level: string, msg: string) => void },
): void {
  if (!entry || !entry.content) return;
  const url = config?.supabaseUrl || process.env.SUPABASE_URL;
  const key = config?.supabaseKey || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return; // No Supabase — silent no-op (portable.ts capability status surfaces this)

  try {
    const https = require('https');
    const body = JSON.stringify({
      channel: entry.channel,
      role: entry.role,
      sender: entry.sender,
      content: entry.content,
      visibility: entry.visibility || 'private',
      model: entry.model || null,
      metadata: entry.metadata || {},
    });
    const u = new URL(`${url}/rest/v1/conversations`);
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
    req.on('error', () => { /* silent */ });
    req.write(body);
    req.end();
  } catch { /* silent */ }
}

module.exports = {
  createLogger,
  classifyMessage,
  logConversation,
};
