// @alienkind-core
/**
 * Gateway — OpenAI-compatible API client for alternate-substrate fallback.
 *
 * When the primary model provider is down, this module routes requests through
 * an OpenAI-compatible gateway (Vercel AI Gateway, OpenRouter, LiteLLM, or any
 * self-hosted equivalent). Works with any gateway that speaks OpenAI's
 * /chat/completions format.
 *
 * STUB PATTERN:
 * If `AI_GATEWAY_API_KEY` is not set, `callGateway()` throws
 * `CapabilityUnavailable` instead of a mystery error. Callers that wrap this in
 * try/catch get clean failure and can fall through to the next substrate tier.
 * The partner's capability registry surfaces the "enable" path to the human.
 *
 * TO ENABLE:
 *   1. Sign up for any OpenAI-compatible gateway:
 *      - Vercel AI Gateway: https://vercel.com/docs/ai-gateway
 *      - OpenRouter: https://openrouter.ai
 *      - LiteLLM (self-hosted): https://github.com/BerriAI/litellm
 *   2. Set AI_GATEWAY_API_KEY in .env
 *   3. (Optional) Set AI_GATEWAY_URL if using a non-Vercel endpoint
 *
 * Why this module exists:
 * Anthropic outages happen. When Claude is down and your partner is mid-thought,
 * you want the partner to keep working on GPT, Grok, or Gemini without losing
 * identity. Every response from the gateway passes through the same identity
 * prompt and same behavioral hooks as the primary substrate. Same Keel,
 * different engine.
 *
 * Readers: runtime.ts (emergency tier failover), any script that wants a
 *          cloud-compute fallback path.
 * Writers: none (stateless — reads .env, POSTs to gateway URL).
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const portable = require('./portable.ts');
const { registerUnavailable, CapabilityUnavailable, resolveConfig } = portable;

// ============================================================================
// Types
// ============================================================================

interface GatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GatewayToolCall[];
}

interface GatewayToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GatewayToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

interface GatewayCallOptions {
  messages: GatewayMessage[];
  tools?: GatewayToolDef[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  log?: (level: string, msg: string) => void;
}

interface GatewayResponse {
  content: string | null;
  tool_calls: GatewayToolCall[];
  model: string;
  tier: 'primary' | 'unknown';
  usage: { input_tokens: number; output_tokens: number };
}

// ============================================================================
// Config (readable from partner-config.json + env)
// ============================================================================

const DEFAULT_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1';
const DEFAULT_MODEL = 'openai/gpt-4o';
const DEFAULT_TIMEOUT_MS = 60000;

function resolveGatewayUrl(): string {
  return resolveConfig<string>(
    'gateway_url',
    process.env.AI_GATEWAY_URL || DEFAULT_GATEWAY_URL,
  );
}

function resolveDefaultModel(): string {
  return resolveConfig<string>(
    'gateway_default_model',
    process.env.AI_GATEWAY_DEFAULT_MODEL || DEFAULT_MODEL,
  );
}

/**
 * Load the gateway key. Throws CapabilityUnavailable with enable instructions
 * if AI_GATEWAY_API_KEY is not set. Caller decides how to react.
 */
function loadGatewayKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    registerUnavailable('gateway', {
      reason: 'No AI_GATEWAY_API_KEY configured',
      enableWith:
        'Sign up for any OpenAI-compatible gateway (Vercel AI Gateway, OpenRouter, or self-hosted LiteLLM), ' +
        'then set AI_GATEWAY_API_KEY in .env. Provides alternate-substrate fallback when your primary provider is down.',
      docs: 'docs/capabilities/gateway.md',
    });
    throw new CapabilityUnavailable(
      'gateway',
      'Set AI_GATEWAY_API_KEY in .env to enable alternate-substrate fallback.',
      'docs/capabilities/gateway.md',
    );
  }
  return key;
}

// ============================================================================
// isModelDown — heuristic for detecting transient model/provider failures
// ============================================================================

const DOWN_PATTERNS = [
  'overloaded',
  'rate_limit',
  'rate limit',
  'service_unavailable',
  '503',
  '502',
  '504',
  'timeout',
  'connection refused',
  'econnreset',
  'etimedout',
  'enotfound',
];

function isModelDown(error: string): boolean {
  const lower = (error || '').toLowerCase();
  return DOWN_PATTERNS.some((p) => lower.includes(p));
}

// ============================================================================
// Core call — single POST to the gateway
// ============================================================================

/**
 * Single OpenAI-compatible chat completion request to the configured gateway.
 * Returns the parsed response. Throws on HTTP errors, timeouts, or parse failures.
 *
 * Does NOT do multi-model retry/failover — that's the caller's job (runtime.ts).
 * This module's job is: single request, clean error, configurable endpoint.
 */
async function callGateway(opts: GatewayCallOptions): Promise<GatewayResponse> {
  const apiKey = loadGatewayKey(); // throws CapabilityUnavailable if unset

  const log = opts.log || (() => {});
  const gatewayUrl = resolveGatewayUrl();
  const model = opts.model || resolveDefaultModel();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const body: any = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const payload = JSON.stringify(body);

  return new Promise<GatewayResponse>((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(`${gatewayUrl}/chat/completions`);
    } catch (err: any) {
      reject(new Error(`Invalid gateway URL: ${gatewayUrl}`));
      return;
    }

    const lib = parsedUrl.protocol === 'http:' ? http : https;
    const requestOptions = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search || ''}`,
      port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };

    log('INFO', `[gateway] POST ${gatewayUrl} (model=${model})`);

    const req = lib.request(requestOptions, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Gateway ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) {
            reject(new Error(`No choices in gateway response: ${data.slice(0, 300)}`));
            return;
          }
          const message = choice.message || {};
          const usage = parsed.usage || {};
          resolve({
            content: message.content ?? null,
            tool_calls: message.tool_calls || [],
            model: parsed.model || model,
            tier: 'primary',
            usage: {
              input_tokens: usage.prompt_tokens || 0,
              output_tokens: usage.completion_tokens || 0,
            },
          });
        } catch (e: any) {
          reject(new Error(`Gateway parse error: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Gateway timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err: Error) => {
      reject(new Error(`Gateway connection error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// ============================================================================
// isGatewayAvailable — non-throwing probe
// ============================================================================

/**
 * Check whether the gateway can be called without actually calling it.
 * Useful for the partner's capability scorecard at boot.
 */
function isGatewayAvailable(): boolean {
  try {
    loadGatewayKey();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  callGateway,
  loadGatewayKey,
  isGatewayAvailable,
  isModelDown,
  DEFAULT_GATEWAY_URL,
  DEFAULT_MODEL,
};
