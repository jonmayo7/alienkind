/**
 * Substrate — provider-agnostic "ask the partner" function.
 *
 * Used by every channel adapter (Telegram, Discord, Slack, webhook).
 * Detects the configured substrate from .env and dispatches:
 *
 *   - Claude Code (OAuth / Max plan)  → spawn 'claude -p' subprocess
 *   - Anthropic API                   → direct HTTPS to api.anthropic.com
 *   - OpenAI                          → direct HTTPS to api.openai.com
 *   - OpenRouter                      → direct HTTPS to openrouter.ai
 *   - Generic OpenAI-compatible       → direct HTTPS to user's endpoint
 *   - Ollama (local)                  → http://localhost:11434/v1
 *
 * Channels never hardcode a provider. Swap substrates by editing .env,
 * no channel-code change required. This is the substrate-portable
 * partnership architecture in code.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

interface AskOptions {
  /** Identity context to inject into the system prompt. If absent, loaded from identity/*.md. */
  systemPrompt?: string;
  /** Conversation history (for multi-turn). Most channels are single-turn so this defaults to []. */
  history?: Array<{ role: string; content: string }>;
  /** Max tokens for the response. Default 2000. */
  maxTokens?: number;
  /** Temperature. Default 0.7. */
  temperature?: number;
  /** Timeout in ms for the substrate call. Default 60000 (60s). */
  timeoutMs?: number;
}

interface SubstrateConfig {
  type: 'claude-code' | 'anthropic' | 'openai' | 'openrouter' | 'gateway' | 'ollama';
  url?: string;
  apiKey?: string;
  model: string;
  name: string;
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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

function detectSubstrate(): SubstrateConfig | null {
  const env = { ...loadEnv(), ...process.env };

  // Claude Code path is preferred when the OAuth token is present (Max plan).
  // It's the only path that bills against subscription rather than per-token.
  if (env.CLAUDE_CODE_OAUTH_TOKEN || fs.existsSync(path.join(require('os').homedir(), '.claude'))) {
    // Check that `claude` binary is actually on PATH
    const which = require('child_process').spawnSync('which', ['claude']);
    if (which.status === 0) {
      return {
        type: 'claude-code',
        model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        name: 'Claude Code (Max plan)',
      };
    }
  }

  if (env.ANTHROPIC_API_KEY) {
    return {
      type: 'anthropic',
      url: 'https://api.anthropic.com/v1',
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      name: 'Anthropic API',
    };
  }

  if (env.OPENAI_API_KEY) {
    return {
      type: 'openai',
      url: env.OPENAI_API_BASE || 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || 'gpt-4o',
      name: 'OpenAI',
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return {
      type: 'openrouter',
      url: 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6',
      name: 'OpenRouter',
    };
  }

  if (env.AI_GATEWAY_API_KEY) {
    return {
      type: 'gateway',
      url: env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1',
      apiKey: env.AI_GATEWAY_API_KEY,
      model: env.AI_GATEWAY_MODEL || 'anthropic/claude-sonnet-4-6',
      name: 'AI Gateway',
    };
  }

  if (env.OPENAI_API_BASE) {
    // Generic OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, etc.)
    return {
      type: 'ollama',
      url: env.OPENAI_API_BASE,
      apiKey: env.OPENAI_API_KEY || 'no-key-needed',
      model: env.OPENAI_MODEL || 'default',
      name: 'Local / OpenAI-compatible',
    };
  }

  return null;
}

function loadIdentity(): string {
  const files = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
  const parts: string[] = [];
  for (const f of files) {
    const p = path.join(ROOT, 'identity', f);
    try {
      const content = fs.readFileSync(p, 'utf8');
      if (!content.includes('## How to write this file')) {
        parts.push(`--- ${f} ---\n${content}`);
      }
    } catch {}
  }
  if (parts.length === 0) {
    return "You are a persistent AI partner running on the AlienKind architecture. Your identity kernel hasn't been written yet — engage warmly, ask what your human is working on, and help them shape who you'll become.";
  }
  return parts.join('\n\n');
}

async function callClaudeCode(prompt: string, opts: AskOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], {
      cwd: ROOT,
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude -p timed out after ${opts.timeoutMs || 60000}ms`));
    }, opts.timeoutMs || 60000);
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    proc.on('close', (code: number) => {
      clearTimeout(timeout);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude -p exit ${code}${err ? `: ${err.slice(0, 200)}` : ''}`));
    });
    proc.on('error', (e: any) => { clearTimeout(timeout); reject(e); });
  });
}

async function callOpenAICompatible(
  config: SubstrateConfig,
  prompt: string,
  opts: AskOptions,
): Promise<string> {
  if (!config.url || !config.apiKey) throw new Error(`Substrate ${config.type} missing url or apiKey`);

  const systemPrompt = opts.systemPrompt || loadIdentity();
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(opts.history || []),
    { role: 'user', content: prompt },
  ];

  const body = JSON.stringify({
    model: config.model,
    messages,
    max_tokens: opts.maxTokens || 2000,
    temperature: opts.temperature ?? 0.7,
  });

  const url = new URL(`${config.url}/chat/completions`);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: opts.timeoutMs || 60000,
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${config.name} ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          resolve(j.choices?.[0]?.message?.content || '(empty response)');
        } catch (e: any) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', (e: any) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

/**
 * Ask the partner. Routes to whichever substrate is configured in .env.
 * Channel adapters call this; they don't know or care which provider answers.
 */
async function askPartner(prompt: string, opts: AskOptions = {}): Promise<string> {
  const config = detectSubstrate();
  if (!config) {
    throw new Error('No substrate configured — set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_BASE in .env');
  }

  if (config.type === 'claude-code') {
    // Claude Code injects identity from CLAUDE.md automatically — no system prompt needed
    return callClaudeCode(prompt, opts);
  }

  return callOpenAICompatible(config, prompt, opts);
}

module.exports = { askPartner, detectSubstrate, loadIdentity };
