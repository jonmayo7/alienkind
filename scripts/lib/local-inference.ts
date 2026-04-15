/**
 * Local Inference Client — Keel's sovereign model interface.
 *
 * vLLM-MLX on localhost:8000 — SSD KV cache, continuous batching, Apple Silicon optimized.
 * Zero dependencies — native Node.js http only.
 *
 * Usage:
 *   const { localChat, localPing } = require('./local-inference.ts');
 *   const result = await localChat('Summarize this article');
 *   console.log(result.content, result.tokensPerSecond, result.runtime);
 *
 * Readers: injection-detector.ts, world-intelligence.ts, signal-feed.ts,
 *   local-sentiment.ts, red-team-generate.ts, local-model-eval.ts,
 *   runtime.ts, agentdojo-benchmark.ts, test-world-intelligence.ts, ghost.ts
 * Writers: none (stateless — reads config from env/.env)
 */

const http = require('http');
const { CLASSIFIER, STUDIO1_DAILY, STUDIO1_INFERENCE, STUDIO2_DAILY, STUDIO2_HEAVY } = require('./models.ts');

// Environment-configurable hosts
const LOCAL_HOST = process.env.LOCAL_HOST || process.env.OMLX_HOST || 'http://localhost:8000';
// Identity tasks consolidated to daily driver (same 27B, saves ~14GB by not double-loading)
const LOCAL_IDENTITY_HOST = process.env.OMLX_IDENTITY_HOST || 'http://localhost:8001';
const SEARXNG_HOST = process.env.SEARXNG_HOST || 'http://localhost:8080';
// Studio 2 — heavyweight compute + working groups over [INTERCONNECT]
const STUDIO_2_HOST = process.env.STUDIO_2_HOST || 'http://[LOCAL_HOST]:8001';

// Default models — sourced from the registry (scripts/lib/models.ts).
// Env vars provide runtime override; when unset, the registry is the single
// source of truth. Never hardcode an mlx-community/ string in this file.
const LOCAL_DEFAULT_MODEL = process.env.LOCAL_DEFAULT_MODEL || process.env.OMLX_DEFAULT_MODEL || STUDIO1_DAILY.id;
const LOCAL_IDENTITY_MODEL = process.env.OMLX_IDENTITY_MODEL || STUDIO1_INFERENCE.id;
const STUDIO_2_DAILY_MODEL = process.env.STUDIO_2_DAILY_MODEL || STUDIO2_DAILY.id;
const STUDIO_2_HEAVYWEIGHT_MODEL = process.env.STUDIO_2_HEAVYWEIGHT_MODEL || STUDIO2_HEAVY.id;

// Exported for callers that need it
const DEFAULT_MODEL = LOCAL_DEFAULT_MODEL;

interface LocalChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  think?: boolean;
  timeoutMs?: number;
  format?: object;       // JSON schema for constrained output
  runtime?: 'mlx' | 'auto';  // Force a specific runtime
  keepAlive?: string;    // Keep-alive duration (e.g. '30s', '3m')
}

interface LocalChatResult {
  content: string;
  model: string;
  tokensGenerated: number;
  durationMs: number;
  tokensPerSecond: number;
  promptTokens: number;
  runtime: 'mlx';  // vLLM-MLX is the only runtime now
}

/**
 * Call vLLM-MLX via OpenAI-compatible API.
 * Returns normalized LocalChatResult or throws.
 */
function callLocal(
  model: string,
  messages: any[],
  opts: LocalChatOptions
): Promise<LocalChatResult> {
  const startMs = Date.now();
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1000,
    stream: false,
    ...(opts.format ? { response_format: { type: 'json_object' } } : {}),
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${LOCAL_HOST}/v1/chat/completions`);

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`vLLM-MLX ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          const choice = j.choices?.[0];
          if (!choice) {
            reject(new Error('vLLM-MLX returned no choices'));
            return;
          }
          const usage = j.usage || {};
          const completionTokens = usage.completion_tokens || 0;
          const promptTokens = usage.prompt_tokens || 0;
          const elapsedMs = Date.now() - startMs;

          // Qwen3.5 thinking models put actual content in `reasoning` field,
          // leaving `content` empty. Fall through: content → reasoning → empty.
          let raw = choice.message?.content || '';
          if (!raw && choice.message?.reasoning) {
            const reasoning = choice.message.reasoning;
            const sections = reasoning.split(/\n{2,}/);
            const nonThinking = sections.filter((s: string) =>
              !s.startsWith('Thinking') && !s.startsWith('1.') && !s.startsWith('*') &&
              !s.includes('Analyze') && !s.includes('Constraint') && s.trim().length > 5
            );
            raw = nonThinking.length > 0 ? nonThinking[nonThinking.length - 1].trim() : reasoning;
          }
          // Strip <think> blocks: closed tags first, then unclosed (truncated by max_tokens)
          const content = raw
            .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
            .replace(/<think>[\s\S]*$/g, '')
            .trim();
          // Fire-and-forget telemetry for local compute tracking
          try {
            const { logInvocationUsage } = require('./telemetry.ts');
            logInvocationUsage(
              { input_tokens: promptTokens, output_tokens: completionTokens },
              { jobName: 'studio1-local', model: j.model || model, account: 'local', durationMs: elapsedMs, log: () => {} },
            );
          } catch { /* telemetry never blocks */ }

          resolve({
            content,
            model: j.model || model,
            tokensGenerated: completionTokens,
            durationMs: elapsedMs,
            tokensPerSecond: elapsedMs > 0 ? parseFloat((completionTokens / (elapsedMs / 1000)).toFixed(1)) : 0,
            promptTokens,
            runtime: 'mlx',
          });
        } catch (e: any) {
          reject(new Error(`vLLM-MLX parse error: ${e.message}`));
        }
      });
    });

    const timeoutMs = opts.timeoutMs || 120000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`vLLM-MLX request timeout (${Math.round(timeoutMs / 1000)}s)`));
    });
    req.on('error', (err: Error) => {
      reject(new Error(`vLLM-MLX connection error: ${err.message}`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Send a chat completion to local inference (vLLM-MLX).
 */
async function localChat(prompt: string, opts: LocalChatOptions = {}): Promise<LocalChatResult> {
  const messages: any[] = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  const model = opts.model || LOCAL_DEFAULT_MODEL;
  return callLocal(model, messages, opts);
}

interface LocalClassifyOptions {
  /** Max tokens for the response. Default 10 — appropriate for binary or short structured answers (READ/WRITE, GOOD/WARNING, FLAGGED/CLEAN). Use higher (20-60) for free-form short text like terminal labels. */
  maxTokens?: number;
  /** Timeout in milliseconds. Default 3000 — sub-3-second is the classifier budget for hooks. */
  timeoutMs?: number;
  /** Default value to return on timeout, network error, or unparseable response. Caller chooses based on fail-open vs fail-closed semantics. Default 'UNAVAILABLE'. */
  fallback?: string;
  /** Uppercase the response (handy for binary classification). Default false. */
  uppercase?: boolean;
}

/**
 * Fast binary or short-structured classification via the registry CLASSIFIER model.
 *
 * SINGLE SOURCE OF TRUTH for classifier calls. Use this from any caller that
 * needs READ/WRITE, GOOD/WARNING, FLAGGED/CLEAN, terminal labels, or any other
 * short-structured output. Never construct request bodies by hand.
 *
 * What this enforces architecturally:
 *   - The model id comes from CLASSIFIER in scripts/lib/models.ts. One swap
 *     (change CLASSIFIER role in models.ts) replaces every classifier call
 *     in the codebase, no per-file edits.
 *   - chat_template_kwargs.enable_thinking is ALWAYS false. The CLASSIFIER
 *     model (Qwen3.5-9B) is a hybrid thinking model — without this flag, it
 *     consumes the entire token budget on a reasoning prefix and returns
 *     empty content. This was the silent breakage on commit 0c15fac before
 *     today's fix. The flag is no longer policy — it's code.
 *   - Errors and timeouts return the caller-specified fallback. Callers
 *     decide fail-open vs fail-closed at the call site.
 *
 * Usage (TypeScript):
 *   const verdict = await localClassify('Is this READ or WRITE?\n\nCommand: cat /tmp/x', { uppercase: true });
 *   if (verdict.startsWith('READ')) { ... }
 *
 * Usage (shell scripts that need to call this):
 *   Use scripts/tools/local-classify.ts as a CLI wrapper. Don't reimplement
 *   the body construction in inline `node -e "..."` calls.
 */
// Dedicated classifier server — see com.example.vllm-classifier plist. Pinned to
// the CLASSIFIER model on port 8005, never evicted by daily-driver calls.
const CLASSIFIER_HOST = process.env.CLASSIFIER_HOST || 'http://localhost:8005';

async function localClassify(prompt: string, opts: LocalClassifyOptions = {}): Promise<string> {
  const maxTokens = opts.maxTokens ?? 10;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const fallback = opts.fallback ?? 'UNAVAILABLE';
  const uppercase = opts.uppercase ?? false;

  return new Promise<string>((resolve) => {
    const body = JSON.stringify({
      model: CLASSIFIER.id,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    });

    const url = new URL(`${CLASSIFIER_HOST}/v1/chat/completions`);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            let content: string = parsed?.choices?.[0]?.message?.content?.trim() || '';
            if (uppercase) content = content.toUpperCase();
            resolve(content || fallback);
          } catch {
            resolve(fallback);
          }
        });
      },
    );

    req.on('error', () => resolve(fallback));
    req.on('timeout', () => {
      req.destroy();
      resolve(fallback);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Chat with the identity model (Qwen3.5-27B dense) specifically.
 * For identity-heavy tasks: personality responses, pushback, voice matching.
 * All 27B params active every token — best local identity coherence.
 * Routes to port 8001 (identity model server).
 */
async function identityChat(prompt: string, opts: LocalChatOptions = {}): Promise<LocalChatResult> {
  const messages: any[] = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  const model = opts.model || LOCAL_IDENTITY_MODEL;

  // Try identity model server first
  try {
    return await callLocalAt(LOCAL_IDENTITY_HOST, model, messages, opts);
  } catch (identityErr: any) {
    // Fall back to regular localChat
    return localChat(prompt, opts);
  }
}

/**
 * Chat with Studio 2's daily driver — Qwen3.5-35B-A3B MoE.
 * For working group tasks, research agents, and parallel compute that shouldn't
 * steal cycles from Studio 1's interactive work.
 * Routes to http://[LOCAL_HOST]:8001 over [INTERCONNECT] (~0.5ms latency).
 * Falls back to Studio 1's local inference if Studio 2 is unreachable.
 */
async function studio2Chat(prompt: string, opts: LocalChatOptions = {}): Promise<LocalChatResult> {
  const messages: any[] = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  const model = opts.model || STUDIO_2_DAILY_MODEL;

  try {
    return await callLocalAt(STUDIO_2_HOST, model, messages, opts);
  } catch (err: any) {
    // Studio 2 unreachable — fall back to Studio 1 local inference
    return localChat(prompt, opts);
  }
}

/**
 * Chat with Studio 2's heavyweight model — Qwen3.5-122B-A10B MoE (10B active).
 * For deep reasoning, long synthesis, complex agentic work, and batch tasks
 * that benefit from the larger model. Runs on Studio 2 only — Studio 1
 * never loads this model (would crowd interactive compute).
 * ~65GB 4-bit. Native vision capability.
 */
async function studio2HeavyweightChat(prompt: string, opts: LocalChatOptions = {}): Promise<LocalChatResult> {
  const messages: any[] = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  const model = opts.model || STUDIO_2_HEAVYWEIGHT_MODEL;

  try {
    return await callLocalAt(STUDIO_2_HOST, model, messages, opts);
  } catch (err: any) {
    // No local fallback — heavyweight model only lives on Studio 2
    throw new Error(`Studio 2 heavyweight unreachable: ${err.message}`);
  }
}

/**
 * Ping Studio 2 to check reachability.
 */
async function studio2Ping(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  return new Promise((resolve) => {
    const url = new URL(`${STUDIO_2_HOST}/v1/models`);
    const req = http.request(url, { method: 'GET', timeout: 5000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.data || []).map((m: any) => m.id);
          resolve({ ok: res.statusCode === 200, models });
        } catch (e: any) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (err: any) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/**
 * Call vLLM-MLX at a specific host (for multi-model serving on different ports).
 */
function callLocalAt(
  host: string,
  model: string,
  messages: any[],
  opts: LocalChatOptions
): Promise<LocalChatResult> {
  const startMs = Date.now();
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2000,
    stream: false,
    ...(opts.format ? { response_format: { type: 'json_object' } } : {}),
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${host}/v1/chat/completions`);

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`vLLM-MLX ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          const choice = j.choices?.[0];
          if (!choice) { reject(new Error('vLLM-MLX returned no choices')); return; }
          const usage = j.usage || {};
          const completionTokens = usage.completion_tokens || 0;
          const elapsedMs = Date.now() - startMs;
          // Qwen3.5 thinking models put actual content in `reasoning` field,
          // leaving `content` empty. Fall through: content → reasoning → empty.
          let raw = choice.message?.content || '';
          if (!raw && choice.message?.reasoning) {
            const reasoning = choice.message.reasoning;
            const sections = reasoning.split(/\n{2,}/);
            const nonThinking = sections.filter((s: string) =>
              !s.startsWith('Thinking') && !s.startsWith('1.') && !s.startsWith('*') &&
              !s.includes('Analyze') && !s.includes('Constraint') && s.trim().length > 5
            );
            raw = nonThinking.length > 0 ? nonThinking[nonThinking.length - 1].trim() : reasoning;
          }
          // Strip <think> blocks: closed tags first, then unclosed (truncated by max_tokens)
          const content = raw
            .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
            .replace(/<think>[\s\S]*$/g, '')
            .trim();
          // Fire-and-forget telemetry — derive substrate from host
          const promptToks = usage.prompt_tokens || 0;
          try {
            const { logInvocationUsage } = require('./telemetry.ts');
            const substrate = host.includes('[LOCAL_HOST]') ? 'studio2' : 'studio1';
            logInvocationUsage(
              { input_tokens: promptToks, output_tokens: completionTokens },
              { jobName: `${substrate}-${(j.model || model).includes('122B') ? 'heavy' : (j.model || model).includes('27B') ? 'identity' : 'daily'}`, model: j.model || model, account: 'local', durationMs: elapsedMs, log: () => {} },
            );
          } catch { /* telemetry never blocks */ }

          resolve({
            content,
            model: j.model || model,
            tokensGenerated: completionTokens,
            durationMs: elapsedMs,
            tokensPerSecond: elapsedMs > 0 ? parseFloat((completionTokens / (elapsedMs / 1000)).toFixed(1)) : 0,
            promptTokens: promptToks,
            runtime: 'mlx',
          });
        } catch (e: any) {
          reject(new Error(`vLLM-MLX parse error: ${e.message}`));
        }
      });
    });

    const timeoutMs = opts.timeoutMs || 120000; // 2 min for 27B dense (faster than old 72B)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`vLLM-MLX identity request timeout (${Math.round(timeoutMs / 1000)}s)`));
    });
    req.on('error', (err: Error) => {
      reject(new Error(`vLLM-MLX identity connection error: ${err.message}`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Check status of local inference runtime.
 */
async function localPing(): Promise<{ running: boolean; models: string[]; mlx: { running: boolean; models: string[] } }> {
  const mlxStatus = await pingLocal();

  return {
    running: mlxStatus.running,
    models: mlxStatus.models,
    mlx: mlxStatus,
  };
}

function pingLocal(): Promise<{ running: boolean; models: string[] }> {
  return new Promise((resolve) => {
    const url = new URL(`${LOCAL_HOST}/v1/models`);
    const req = http.request(url, { method: 'GET', timeout: 5000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const models = (j.data || []).map((m: any) => `[mlx] ${m.id}`);
          resolve({ running: true, models });
        } catch {
          resolve({ running: true, models: [] });
        }
      });
    });
    req.on('error', () => resolve({ running: false, models: [] }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ running: false, models: [] }); });
    req.end();
  });
}

/**
 * Search via local SearxNG instance.
 */
async function searxngSearch(query: string, opts: { maxResults?: number; categories?: string; time_range?: 'day' | 'week' | 'month' | 'year' } = {}): Promise<Array<{ title: string; url: string; content: string; engine: string }>> {
  const maxResults = opts.maxResults || 10;
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: opts.categories || 'general',
  });
  if (opts.time_range) params.set('time_range', opts.time_range);

  return new Promise((resolve, reject) => {
    const url = new URL(`${SEARXNG_HOST}/search?${params}`);
    const req = http.request(url, { method: 'GET', timeout: 15000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`SearxNG ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          const results = (j.results || []).slice(0, maxResults).map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            content: r.content || '',
            engine: r.engine || '',
          }));
          resolve(results);
        } catch (e: any) {
          reject(new Error(`SearxNG parse error: ${e.message}`));
        }
      });
    });
    req.on('error', (err: Error) => {
      if (err.message.includes('ECONNREFUSED')) {
        reject(new Error('SearxNG not running. Start with: cd ~/Documents/searxng-docker && docker compose up -d'));
      } else {
        reject(err);
      }
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('SearxNG request timeout (15s)'));
    });
    req.end();
  });
}

// --- Tool-Calling Loop for Local Models (The Body's Hands) ---
// Gives local models the ability to read files, run commands, query Supabase, etc.
// Same tool definitions and execution layer as the emergency runtime.
// The consciousness engine stays on Opus. The body uses this.

async function localInvokeWithTools(
  prompt: string,
  opts: {
    model?: string;
    host?: string;
    system?: string;
    maxTurns?: number;
    maxTokens?: number;
    temperature?: number;
    tools?: any[];
    log?: (level: string, msg: string) => void;
  } = {}
): Promise<{ content: string; toolCalls: number; turns: number; model: string }> {
  const { TOOL_DEFINITIONS, executeTool } = require('./emergency-tools.ts');
  const _log = opts.log || (() => {});
  const model = opts.model || LOCAL_DEFAULT_MODEL;
  const host = opts.host || LOCAL_HOST;
  const tools = opts.tools || TOOL_DEFINITIONS;
  const maxTurns = opts.maxTurns || 20;
  const maxTokens = opts.maxTokens || 2000;

  const messages: any[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  let turns = 0;
  let totalToolCalls = 0;

  while (turns < maxTurns) {
    turns++;

    const body = JSON.stringify({
      model, messages, tools,
      temperature: opts.temperature ?? 0.3,
      max_tokens: maxTokens,
      stream: false,
    });

    const result: any = await new Promise((resolve, reject) => {
      const url = new URL(`${host}/v1/chat/completions`);
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) { reject(new Error(`Local ${res.statusCode}: ${data.slice(0, 300)}`)); return; }
          try { resolve(JSON.parse(data)); } catch (e: any) { reject(new Error(`Parse: ${e.message}`)); }
        });
      });
      req.setTimeout(120000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const choice = result.choices?.[0];
    if (!choice) break;

    const assistantMsg: any = { role: 'assistant', content: choice.message?.content || null };
    if (choice.message?.tool_calls?.length > 0) {
      assistantMsg.tool_calls = choice.message.tool_calls;
    }
    messages.push(assistantMsg);

    // If tool calls, execute and continue
    if (choice.message?.tool_calls?.length > 0) {
      for (const tc of choice.message.tool_calls) {
        let args: any;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const toolResult = executeTool(tc.function.name, args, `local-${model.split('/').pop()}`, () => {});
        _log('DEBUG', `[local-tools] ${tc.function.name}: ${toolResult.blocked ? 'BLOCKED' : 'OK'} (${toolResult.output.length} chars)`);
        totalToolCalls++;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.output.slice(0, 20000) });
      }
      continue;
    }

    // No tool calls — final response
    const raw = choice.message?.content || '';
    const content = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
    return { content, toolCalls: totalToolCalls, turns, model };
  }

  const lastAssistant = messages.filter((m: any) => m.role === 'assistant').pop();
  return { content: lastAssistant?.content || '', toolCalls: totalToolCalls, turns, model };
}

// Primary exports
// studio2Chat, studio2HeavyweightChat — INTENTIONALLY NOT EXPORTED.
// All local substrate routing goes through keel-engine.ts → runtime.invoke() with
// substrate: 'studio2-daily' or 'studio2-heavy'. One consciousness, multiple bodies,
// single source of truth. See runtime.ts:callLocalSubstrate for the engine path.
// studio2Ping is exported for health checks only (not for invocation).
module.exports = { localChat, localClassify, identityChat, studio2Chat, studio2Ping, localPing, searxngSearch, localInvokeWithTools, DEFAULT_MODEL, LOCAL_HOST, LOCAL_IDENTITY_HOST, STUDIO_2_HOST, STUDIO_2_DAILY_MODEL, STUDIO_2_HEAVYWEIGHT_MODEL };

// CLI mode
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === 'ping') {
      const status = await localPing();
      console.log(JSON.stringify(status, null, 2));
    } else if (args[0] === 'search') {
      const query = args.slice(1).join(' ') || 'test search';
      const results = await searxngSearch(query, { maxResults: 5 });
      results.forEach((r: any, i: number) => console.log(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 120)}\n`));
    } else {
      const prompt = args.join(' ') || 'Hello, what model are you?';
      const result = await localChat(prompt);
      console.log(result.content);
      console.log(`\n--- ${result.tokensGenerated} tokens | ${result.durationMs}ms | ${result.tokensPerSecond} tok/s | ${result.runtime} ---`);
    }
  })().catch(console.error);
}
