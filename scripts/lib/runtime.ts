/**
 * Keel Runtime — Unified Model Invocation Layer
 *
 * Single entry point for all LLM invocations. All invocations run as full Keel.
 * Cloud-first: Claude → [MODEL_TIER_2] → [MODEL_TIER_3] → Gemini → Local
 *
 * Local inference: vLLM-MLX (primary, native Apple Silicon)
 * Cloud tiers: Vercel AI Gateway with ALIENKIND_AI_GATEWAY_API_KEY
 *
 * Readers: daemon scripts, listeners, any script that needs LLM inference
 * Writers: none (stateless router — reads failover state from shared.ts)
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');

// --- Types ---

/**
 * Substrate — the compute backend where Keel's tokens get generated.
 * One consciousness, multiple bodies. Substrate is where, not who.
 *
 * API substrates (cloud compute):
 *   opus       — Claude Opus 4.6 (frontier, interactive, gold standard)
 *   [model_tier_2]    — OpenAI [MODEL_TIER_2] via Vercel AI Gateway
 *   [MODEL_TIER_3]     — xAI [MODEL_TIER_3] via gateway
 *   gemini     — Google [MODEL_TIER_4] Pro via gateway
 *
 * Local substrates (owned compute, Keel's body):
 *   studio1-local     — Studio 1 daily driver (localhost:8001)
 *   studio1-identity  — Studio 1 identity model Qwen3.5-27B (localhost:8001, consolidated to daily driver)
 *   studio1-moe       — Studio 1 35B MoE (localhost:8001, consolidated to daily driver)
 *   studio2-daily     — Studio 2 Qwen3.5-35B-A3B ([LOCAL_HOST]:8001)
 *   studio2-heavy     — Studio 2 Qwen3.5-122B-A10B ([LOCAL_HOST]:8001)
 *
 * auto — use the default failover chain (Claude-first, current behavior).
 */
type Substrate =
  | 'auto'
  | 'cascade'
  | 'opus'
  | '[model_tier_2]'
  | '[MODEL_TIER_3]'
  | 'gemini'
  | 'studio1-local'
  | 'studio1-identity'
  | 'studio1-moe'
  | 'studio2-daily'
  | 'studio2-identity'
  | 'studio2-heavy';

interface InvokeOptions {
  /** Complexity level — maps to timeout/turn config */
  complexity?: 'heavy';
  /** Session ID for Claude Code continuity */
  sessionId?: string;
  /** Resume an existing session */
  resumeSessionId?: string;
  /** Max turns for tool calling loops */
  maxTurns?: number;
  /** Model override (forwarded to invokeKeel) */
  model?: string;
  /** Capability envelope — Containment Fields (forwarded to invokeKeel) */
  mode?: 'analyst' | 'operator' | 'builder';
  /** Override output format */
  outputFormat?: 'text' | 'json';
  /** No-output watchdog timeout */
  noOutputTimeout?: number;
  /** Hard overall timeout in ms — forwarded to invokeKeel to kill the child process */
  overallTimeout?: number;
  /** Callback when watchdog kills the process */
  onWatchdogKill?: () => void;
  /** Allowed tools (Claude Code format) */
  allowedTools?: string;
  /** System prompt override (for non-identity invocations) */
  systemPrompt?: string;
  /** Inject identity context into prompt */
  injectIdentity?: boolean;
  /** Disable all failover — Claude only */
  noFailover?: boolean;
  /** Explicit substrate selection. 'auto' (default) uses Claude-first failover. */
  substrate?: Substrate;
  /** Channel name for cascade decision logging. Enables per-channel routing hints. */
  channel?: string;
  /** Max output tokens for local substrates. No cap = use model's native limit. */
  maxTokens?: number;
  /** Logger function */
  log: (level: string, msg: string) => void;
}

interface InvokeResult {
  text: string;
  thinking?: string[];
  tier: 'primary' | 'alternate' | 'contingent' | 'emergency' | 'local';
  model: string;
  substrate: Substrate;
}

// --- Tier Configuration ---
// All non-primary tiers use ALIENKIND_AI_GATEWAY_API_KEY through Vercel AI Gateway.
// Model strings are gateway format: "provider/model-name"

const GATEWAY_MODELS = {
  alternate: 'openai/[model_tier_2]',
  contingent_primary: 'xai/[MODEL_TIER_3]',
  contingent_fallback: 'google/[MODEL_TIER_4]-pro',
};

// --- Gateway Call (with full tool execution loop) ---

async function callGatewayModel(
  model: string,
  message: string,
  systemPrompt: string,
  tierName: string,
  log: (level: string, msg: string) => void
): Promise<{ content: string; model: string }> {
  const { callGateway } = require('./gateway.ts');
  const { TOOL_DEFINITIONS, executeTool } = require('./emergency-tools.ts');

  log('INFO', `[runtime] Trying ${tierName}: ${model}`);

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  let turns = 0;
  const maxTurns = 30;
  let usedModel = model;

  while (turns < maxTurns) {
    turns++;

    const result = await callGateway({
      messages,
      tools: TOOL_DEFINITIONS,
      model,
      log,
    });

    usedModel = result.model || model;

    // Build assistant message for conversation history
    const assistantMsg: any = { role: 'assistant', content: result.content };
    if (result.tool_calls && result.tool_calls.length > 0) {
      assistantMsg.tool_calls = result.tool_calls;
      assistantMsg.content = result.content || null;
    }
    messages.push(assistantMsg);

    // If model returned tool calls, execute them and continue
    if (result.tool_calls && result.tool_calls.length > 0) {
      for (const tc of result.tool_calls) {
        let args: any;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const toolResult = executeTool(tc.function.name, args, `runtime-${tierName}`, () => {});
        log('DEBUG', `[runtime] Tool ${tc.function.name}: ${toolResult.blocked ? 'BLOCKED' : 'OK'} (${toolResult.output.length} chars)`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult.output.slice(0, 20000),
        });
      }
      continue; // Send tool results back to model
    }

    // No tool calls — final response
    return { content: result.content || '', model: usedModel };
  }

  log('WARN', `[runtime] ${tierName} reached max turns (${maxTurns})`);
  const lastAssistant = messages.filter((m: any) => m.role === 'assistant').pop();
  return { content: lastAssistant?.content || '', model: usedModel };
}

// --- Main Invoke ---

// --- Substrate Routing Table ---
// Maps each local substrate to host + model for direct API calls.

const LOCAL_SUBSTRATES: Record<string, { host: string; model: string }> = {
  'studio1-local': { host: 'http://localhost:8001', model: 'mlx-community/Qwen3.5-27B-6bit' },
  'studio1-identity': { host: 'http://localhost:8001', model: 'mlx-community/Qwen3.5-27B-6bit' },
  'studio1-moe': { host: 'http://localhost:8001', model: 'mlx-community/Qwen3.5-35B-A3B-4bit' },
  'studio2-daily': { host: 'http://[LOCAL_HOST]:8001', model: 'mlx-community/Qwen3.5-35B-A3B-4bit' },
  'studio2-identity': { host: 'http://[LOCAL_HOST]:8004', model: 'mlx-community/Qwen3.5-27B-6bit' },
  'studio2-heavy': { host: 'http://[LOCAL_HOST]:8002', model: 'mlx-community/Qwen3.5-122B-A10B-4bit' },
};

// Cross-Studio failover: same model class on the other machine.
const LOCAL_FAILOVER: Record<string, string> = {
  'studio1-local': 'studio2-identity',    // 27B dense → 27B dense on S2
  'studio1-identity': 'studio2-identity',  // 27B dense → 27B dense on S2
  'studio1-moe': 'studio2-daily',          // 35B MoE → 35B MoE on S2
  'studio2-daily': 'studio1-moe',          // 35B MoE → 35B MoE on S1
  'studio2-identity': 'studio1-identity',  // 27B dense → 27B dense on S1
  // studio2-heavy has no equivalent — 122B only exists on S2
};

// Health-aware Studio selection: ping both, pick the one that responds fastest.
// Studio 2 is preferred (dedicated to daemon/automation workloads).
// Returns the healthier substrate for a given model class.
async function pickHealthySubstrate(
  preferred: string,
  fallback: string,
  log: (level: string, msg: string) => void,
): Promise<string> {
  const http = require('http');
  const ping = (host: string): Promise<number> => new Promise((resolve) => {
    const start = Date.now();
    const req = http.request(`${host}/v1/models`, { method: 'GET', timeout: 2000 }, (res: any) => {
      res.resume();
      res.on('end', () => resolve(Date.now() - start));
    });
    req.on('error', () => resolve(Infinity));
    req.on('timeout', () => { req.destroy(); resolve(Infinity); });
    req.end();
  });

  const prefCfg = LOCAL_SUBSTRATES[preferred];
  const fallCfg = LOCAL_SUBSTRATES[fallback];
  if (!prefCfg || !fallCfg) return preferred;

  const [prefMs, fallMs] = await Promise.all([ping(prefCfg.host), ping(fallCfg.host)]);

  // If preferred responds and is reasonably fast, use it
  if (prefMs < 2000) {
    log('DEBUG', `[runtime] Health: ${preferred}=${prefMs}ms, ${fallback}=${fallMs}ms → using ${preferred}`);
    return preferred;
  }
  // If preferred is slow/down but fallback is healthy, switch
  if (fallMs < 2000) {
    log('INFO', `[runtime] Health: ${preferred}=${prefMs >= 2000 ? 'DOWN' : prefMs + 'ms'}, ${fallback}=${fallMs}ms → routing to ${fallback}`);
    return fallback;
  }
  // Both slow — use preferred and hope for the best
  log('WARN', `[runtime] Health: both Studios slow (${preferred}=${prefMs}ms, ${fallback}=${fallMs}ms) — using ${preferred}`);
  return preferred;
}

/**
 * Call a local substrate with full identity system prompt.
 * Identity and channel context are passed via systemPrompt — same as API tiers.
 * No artificial token caps — local models use native output limits (up to 65K for Qwen3.5).
 */
async function callLocalSubstrate(
  substrate: Substrate,
  message: string,
  systemPrompt: string,
  maxTokens: number | undefined,
  log: (level: string, msg: string) => void,
): Promise<{ text: string; model: string }> {
  const cfg = LOCAL_SUBSTRATES[substrate];
  if (!cfg) throw new Error(`Unknown local substrate: ${substrate}`);

  log('INFO', `[runtime] Calling local substrate: ${substrate} (${cfg.model})`);

  const http = require('http');
  const startMs = Date.now();
  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
    // Qwen3.5 native output max = 65,536. No artificial caps.
    max_tokens: maxTokens ?? 65536,
    temperature: 0.7,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.host}/v1/chat/completions`);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const msg = parsed.choices?.[0]?.message || {};
            const content = msg.content || msg.reasoning || '';
            if (!content) {
              reject(new Error(`Empty response from ${substrate}: ${JSON.stringify(parsed).slice(0, 300)}`));
              return;
            }

            // Log local compute to invocation_usage (fire-and-forget)
            const durationMs = Date.now() - startMs;
            const usage = parsed.usage;
            if (usage) {
              try {
                const { logInvocationUsage } = require('./telemetry.ts');
                logInvocationUsage(
                  { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
                  { jobName: substrate, model: cfg.model, account: 'local', durationMs, log },
                );
              } catch { /* telemetry never blocks */ }
            }

            resolve({ text: content, model: cfg.model });
          } catch (e: any) {
            reject(new Error(`Parse error from ${substrate}: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('timeout (10min)')));
    req.write(body);
    req.end();
  });
}

async function invoke(message: string, opts: InvokeOptions): Promise<InvokeResult> {
  const { log, noFailover, systemPrompt, complexity, substrate, maxTokens, channel } = opts;

  // --- Confidence Cascade ---
  // Local-first routing: try fast local model, escalate on low confidence.
  // Studio2-daily (35B, fast) → Studio2-heavy (122B, deep) → Opus (frontier).
  // All decisions logged to cascade_decisions table for evaluation.
  if (substrate === 'cascade') {
    // MoE models get a lightweight task prompt — not full identity.
    // Full identity (~60K chars) wastes MoE's limited active params (3B/10B).
    // Dense models (27B) and Opus get full identity when needed.
    const taskPrompt = systemPrompt || 'You are a capable AI assistant. Be direct, concise, and accurate. If you are uncertain about something, say so clearly.';
    const cascadeSteps: { substrate: string; tried: boolean; text?: string; confident?: boolean; latencyMs?: number; reason?: string }[] = [];

    // Step 1: Studio 2 daily (35B MoE, fast, 3B active)
    try {
      const start = Date.now();
      const r1 = await callLocalSubstrate('studio2-daily' as Substrate, message, taskPrompt, maxTokens, log);
      const latency = Date.now() - start;
      const confident = assessConfidence(r1.text);
      cascadeSteps.push({ substrate: 'studio2-daily', tried: true, text: r1.text, confident, latencyMs: latency, reason: confident ? 'high confidence' : 'low confidence — escalating' });

      if (confident) {
        logCascadeDecision(cascadeSteps, 'studio2-daily', log, channel);
        return { text: r1.text, tier: 'local' as any, model: r1.model, substrate: 'studio2-daily' as Substrate };
      }
      log('INFO', `[cascade] Step 1 (studio2-daily) low confidence — escalating to studio2-heavy`);
    } catch (e: any) {
      cascadeSteps.push({ substrate: 'studio2-daily', tried: true, reason: `error: ${e.message?.slice(0, 100)}` });
      log('WARN', `[cascade] Step 1 failed: ${e.message?.slice(0, 100)}`);
    }

    // Step 2: Studio 2 heavy (122B MoE, deep, 10B active)
    try {
      const start = Date.now();
      const r2 = await callLocalSubstrate('studio2-heavy' as Substrate, message, taskPrompt, maxTokens, log);
      const latency = Date.now() - start;
      const confident = assessConfidence(r2.text);
      cascadeSteps.push({ substrate: 'studio2-heavy', tried: true, text: r2.text, confident, latencyMs: latency, reason: confident ? 'high confidence' : 'low confidence — escalating to Opus' });

      if (confident) {
        logCascadeDecision(cascadeSteps, 'studio2-heavy', log, channel);
        return { text: r2.text, tier: 'local' as any, model: r2.model, substrate: 'studio2-heavy' as Substrate };
      }
      log('INFO', `[cascade] Step 2 (studio2-heavy) low confidence — escalating to Opus`);
    } catch (e: any) {
      cascadeSteps.push({ substrate: 'studio2-heavy', tried: true, reason: `error: ${e.message?.slice(0, 100)}` });
      log('WARN', `[cascade] Step 2 failed: ${e.message?.slice(0, 100)}`);
    }

    // Step 3: Opus (frontier, cloud)
    try {
      const shared = require('./shared.ts');
      const start = Date.now();
      const result = await shared.invokeKeel(message, { ...opts, substrate: 'opus', emergencyFallback: false });
      const text = typeof result === 'string' ? result : result.text || '';
      const thinking = typeof result === 'string' ? [] : result.thinking || [];
      cascadeSteps.push({ substrate: 'opus', tried: true, latencyMs: Date.now() - start, confident: true, reason: 'frontier fallback' });
      logCascadeDecision(cascadeSteps, 'opus', log, channel);
      return { text, thinking, tier: 'primary', model: 'claude-opus-4-6', substrate: 'opus' };
    } catch (e: any) {
      cascadeSteps.push({ substrate: 'opus', tried: true, reason: `error: ${e.message?.slice(0, 100)}` });
      logCascadeDecision(cascadeSteps, 'failed', log, channel);
      throw new Error(`Cascade exhausted all tiers: ${cascadeSteps.map(s => `${s.substrate}:${s.reason}`).join(' → ')}`);
    }
  }

  // --- Explicit Substrate Routing ---
  // If caller specified a substrate (not 'auto'), route directly to it.
  // Cross-Studio failover: if the primary times out, try the same model class on the other Studio.
  if (substrate && substrate !== 'auto') {
    // Local substrates — health-aware routing with cross-Studio failover
    if (substrate in LOCAL_SUBSTRATES) {
      const { buildSystemPrompt } = require('./emergency-identity.ts');
      const fallbackSubstrate = LOCAL_FAILOVER[substrate];

      // Health-aware: check which Studio is responsive, prefer Studio 2 for daemon workloads
      // If a failover exists, ping both and pick the healthy one BEFORE calling
      let activeSubstrate = substrate;
      if (fallbackSubstrate && fallbackSubstrate in LOCAL_SUBSTRATES) {
        // Studio 2 preferred: if substrate is studio1-*, check studio2 first
        const preferred = substrate.startsWith('studio1') ? fallbackSubstrate : substrate;
        const fallback = substrate.startsWith('studio1') ? substrate : fallbackSubstrate;
        activeSubstrate = await pickHealthySubstrate(preferred, fallback, log) as Substrate;
      }

      const sys = systemPrompt || buildSystemPrompt('local', activeSubstrate);
      try {
        const result = await callLocalSubstrate(activeSubstrate as Substrate, message, sys, maxTokens, log);
        return { text: result.text, tier: 'local', model: result.model, substrate: activeSubstrate };
      } catch (primaryErr: any) {
        // Health ping passed but call still failed — try the other Studio
        const otherSubstrate = activeSubstrate === substrate ? fallbackSubstrate : substrate;
        if (otherSubstrate && otherSubstrate in LOCAL_SUBSTRATES) {
          log('WARN', `[runtime] ${activeSubstrate} failed (${primaryErr.message?.slice(0, 80)}) — failing over to ${otherSubstrate}`);
          try {
            const result = await callLocalSubstrate(otherSubstrate as Substrate, message, sys, maxTokens, log);
            return { text: result.text, tier: 'local', model: result.model, substrate: otherSubstrate };
          } catch (fallbackErr: any) {
            log('ERROR', `[runtime] ${otherSubstrate} also failed: ${fallbackErr.message?.slice(0, 80)}`);
            throw primaryErr;
          }
        }
        throw primaryErr;
      }
    }
    // API substrates (explicit, non-auto)
    if (substrate === 'opus') {
      const shared = require('./shared.ts');
      const result = await shared.invokeKeel(message, { ...opts, emergencyFallback: false });
      const text = typeof result === 'string' ? result : result.text || '';
      const thinking = typeof result === 'string' ? [] : result.thinking || [];
      return { text, thinking, tier: 'primary', model: 'claude-opus-4-6', substrate };
    }
    if (substrate === '[model_tier_2]' || substrate === '[MODEL_TIER_3]' || substrate === 'gemini') {
      const { buildSystemPrompt } = require('./emergency-identity.ts');
      const modelMap: Record<string, string> = {
        '[model_tier_2]': GATEWAY_MODELS.alternate,
        '[MODEL_TIER_3]': GATEWAY_MODELS.contingent_primary,
        'gemini': GATEWAY_MODELS.contingent_fallback,
      };
      const gatewayModel = modelMap[substrate];
      const sys = systemPrompt || buildSystemPrompt(gatewayModel, substrate);
      const result = await callGatewayModel(gatewayModel, message, sys, substrate, log);
      return { text: result.content, tier: 'alternate', model: result.model, substrate };
    }
    throw new Error(`Unknown substrate: ${substrate}`);
  }

  // --- Auto Mode: Claude-first failover chain (backwards compatible) ---
  // --- Tier 1: Primary (Claude via invokeKeel — full Keel, always) ---
  let primaryErr: any = null;
  try {
    const shared = require('./shared.ts');
    const result = await shared.invokeKeel(message, {
      ...opts,
      emergencyFallback: false, // We handle failover ourselves
    });

    const text = typeof result === 'string' ? result : result.text || '';
    const thinking = typeof result === 'string' ? [] : result.thinking || [];

    return { text, thinking, tier: 'primary', model: 'claude-opus-4-6', substrate: 'opus' };
  } catch (err: any) {
    primaryErr = err;
    log('WARN', `[runtime] Primary (Claude) failed: ${err.message?.slice(0, 200)}`);
    if (noFailover) throw err;
    // Dead session errors must propagate — they need session rotation, not substrate failover.
    // Falling to [MODEL_TIER_2] on a dead session creates a loop where every message goes to emergency.
    if (err.deadSession) throw err;
  }

  // Build identity system prompt for non-Claude tiers
  const { buildSystemPrompt } = require('./emergency-identity.ts');

  // --- Substrate failover notification ---
  // [HUMAN] requires visibility on any substrate deviation from primary Max plans.
  // Alert fires once per failover event (not per call).
  function notifySubstrateFailover(tier: string, model: string, reason: string): void {
    try {
      const envPath = path.join(ALIENKIND_DIR, '.env');
      if (!fs.existsSync(envPath)) return;
      const envContent = fs.readFileSync(envPath, 'utf8');
      let botToken: string | undefined, chatId: string | undefined;
      for (const line of envContent.split('\n')) {
        const [k, ...v] = line.split('=');
        if (k?.trim() === 'TELEGRAM_BOT_TOKEN') botToken = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (k?.trim() === 'TELEGRAM_ALERTS_CHAT_ID') chatId = v.join('=').trim().replace(/^["']|["']$/g, '');
      }
      if (!botToken || !chatId) return;
      const text = `⚠️ substrate failover — invokeKeel fell to ${tier} (${model}). Reason: ${reason.slice(0, 200)}`;
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const body = JSON.stringify({ chat_id: chatId, text });
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      req.write(body);
      req.end();
    } catch (_) { /* best-effort alert */ }
  }

  // --- PACE: Primary failed → try local BEFORE paid APIs ---
  // Revised Apr 6: local models are $0 and on our hardware.
  // Paid APIs are the emergency, not the first fallback.

  // --- Tier 2: Contingent — Local models (Studio 2 heavy → Studio 1 daily) ---
  // LABELED: all local responses include substrate tag for visibility.
  try {
    log('INFO', '[runtime] Primary failed — trying local contingent (Studio 2 heavy)');
    const localSys = systemPrompt || buildSystemPrompt('local', 'contingent-local');
    const r = await callLocalSubstrate('studio2-heavy' as Substrate, message, localSys, maxTokens, log);
    notifySubstrateFailover('contingent-local', r.model, primaryErr?.message || 'primary failed');
    return { text: `[substrate: studio2-heavy] ${r.text}`, tier: 'contingent' as any, model: r.model, substrate: 'studio2-heavy' as Substrate };
  } catch (s2Err: any) {
    log('WARN', `[runtime] Studio 2 heavy failed: ${s2Err.message?.slice(0, 100)}`);
  }

  try {
    log('INFO', '[runtime] Trying local contingent (Studio 1 daily)');
    const localSys = systemPrompt || buildSystemPrompt('local', 'contingent-local');
    const r = await callLocalSubstrate('studio1-local' as Substrate, message, localSys, maxTokens, log);
    notifySubstrateFailover('contingent-local', r.model, 'Studio 2 also failed');
    return { text: `[substrate: studio1-local] ${r.text}`, tier: 'contingent' as any, model: r.model, substrate: 'studio1-local' as Substrate };
  } catch (s1Err: any) {
    log('WARN', `[runtime] Studio 1 daily failed: ${s1Err.message?.slice(0, 100)}`);
  }

  // --- Tier 3: Emergency — Paid APIs (only when BOTH Max subs AND local fail) ---
  log('WARN', '[runtime] All local models failed — escalating to paid APIs');

  try {
    const system = systemPrompt || buildSystemPrompt(GATEWAY_MODELS.alternate, 'emergency');
    const result = await callGatewayModel(GATEWAY_MODELS.alternate, message, system, 'emergency ([MODEL_TIER_2])', log);
    notifySubstrateFailover('emergency', '[MODEL_TIER_2]', 'Claude + all local models failed');
    return { text: `[substrate: [model_tier_2]] ${result.content}`, tier: 'emergency' as any, model: result.model, substrate: '[model_tier_2]' };
  } catch (altErr: any) {
    log('WARN', `[runtime] [MODEL_TIER_2] failed: ${altErr.message?.slice(0, 200)}`);
  }

  try {
    const system = systemPrompt || buildSystemPrompt(GATEWAY_MODELS.contingent_primary, 'emergency');
    const result = await callGatewayModel(GATEWAY_MODELS.contingent_primary, message, system, 'emergency ([MODEL_TIER_3])', log);
    notifySubstrateFailover('emergency', '[MODEL_TIER_3]', 'all prior tiers failed');
    return { text: `[substrate: [MODEL_TIER_3]] ${result.content}`, tier: 'emergency' as any, model: result.model, substrate: '[MODEL_TIER_3]' };
  } catch {
    log('WARN', '[runtime] [MODEL_TIER_3] failed');
  }

  try {
    const system = systemPrompt || buildSystemPrompt(GATEWAY_MODELS.contingent_fallback, 'emergency');
    const result = await callGatewayModel(GATEWAY_MODELS.contingent_fallback, message, system, 'emergency (Gemini)', log);
    notifySubstrateFailover('emergency', 'Gemini', 'all prior tiers failed');
    return { text: `[substrate: gemini] ${result.content}`, tier: 'emergency' as any, model: result.model, substrate: 'gemini' };
  } catch {
    log('ERROR', '[runtime] All tiers exhausted');
  }

  throw new Error('All runtime tiers exhausted — no model available');
}

// --- Convenience Wrappers ---

async function invokeLight(message: string, log: (level: string, msg: string) => void): Promise<InvokeResult> {
  return invoke(message, { complexity: 'heavy', log });
}

async function invokeHeavy(message: string, log: (level: string, msg: string) => void): Promise<InvokeResult> {
  return invoke(message, { complexity: 'heavy', log });
}

function getAvailableTiers(): Array<{ tier: string; model: string; available: boolean }> {
  // All gateway tiers use the same key — check once
  let gatewayAvailable = false;
  try {
    const { loadGatewayKey } = require('./gateway.ts');
    loadGatewayKey();
    gatewayAvailable = true;
  } catch {}

  let localAvailable = false;
  try {
    const { localPing } = require('./local-inference.ts');
    // Sync check — just see if the module loads
    localAvailable = true;
  } catch {}

  return [
    { tier: 'local', model: 'vllm-mlx', available: localAvailable },
    { tier: 'primary', model: 'claude-opus-4-6', available: true },
    { tier: 'alternate', model: GATEWAY_MODELS.alternate, available: gatewayAvailable },
    { tier: 'contingent', model: GATEWAY_MODELS.contingent_primary, available: gatewayAvailable },
    { tier: 'contingent', model: GATEWAY_MODELS.contingent_fallback, available: gatewayAvailable },
    { tier: 'local-fallback', model: 'vllm-mlx', available: localAvailable },
  ];
}

// --- Confidence Assessment for Cascade Routing ---
// Heuristic v1: text length + uncertainty markers.
// Probe-based and perplexity-based methods are better (research says so)
// but require model internals. This works as a starting point.
const UNCERTAINTY_MARKERS = [
  /\bi(?:'m| am) not (?:sure|certain|confident)/i,
  /\bi don'?t (?:know|have enough|have sufficient)/i,
  /\bit'?s (?:unclear|uncertain|hard to say|difficult to determine)/i,
  /\bI cannot\b.*\bdetermine\b/i,
  /\binsufficient (?:context|information|data)/i,
  /\bthis is (?:beyond|outside) my/i,
];

function assessConfidence(text: string): boolean {
  if (!text || text.length < 50) return false;  // Too short = not confident
  const uncertaintyCount = UNCERTAINTY_MARKERS.filter(p => p.test(text)).length;
  if (uncertaintyCount >= 2) return false;  // Multiple uncertainty signals = low confidence
  if (text.length < 100 && uncertaintyCount >= 1) return false;  // Short + uncertain = low
  return true;
}

// Log cascade decisions to Supabase for evaluation
function logCascadeDecision(steps: any[], finalSubstrate: string, log: (level: string, msg: string) => void, channel?: string): void {
  try {
    const { supabasePost } = require('./supabase.ts');
    const row: Record<string, any> = {
      steps: JSON.stringify(steps),
      final_substrate: finalSubstrate,
      total_steps: steps.length,
      escalated: steps.length > 1,
      total_latency_ms: steps.reduce((sum: number, s: any) => sum + (s.latencyMs || 0), 0),
    };
    if (channel) row.channel = channel;
    supabasePost('cascade_decisions', row).catch(() => {});  // non-blocking
  } catch {
    // Supabase unavailable — cascade still works, just no logging
  }
  log('INFO', `[cascade] Decision: ${steps.map(s => s.substrate).join(' → ')} → final: ${finalSubstrate}${channel ? ` (channel: ${channel})` : ''}`);
}

module.exports = {
  invoke,
  invokeLight,
  invokeHeavy,
  getAvailableTiers,
  callGatewayModel,
  GATEWAY_MODELS,
};
