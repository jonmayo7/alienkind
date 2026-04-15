/**
 * Prompt Hook Executor — LLM-evaluated hook decisions.
 *
 * Most Keel hooks are deterministic shell/Node scripts: they pattern-match,
 * check exit codes, fail fast. That's the right tool for 95% of enforcement.
 *
 * The other 5% needs judgment: "is this content appropriate for this context?",
 * "does this edit make architectural sense?", "is this outbound message in voice?"
 * These are decisions where regex is brittle and a model evaluation is honest.
 *
 * This module is the executor for that 5%. A hook script imports it, defines a
 * prompt template + variable extractors + a substrate, and gets back a
 * structured ALLOW/BLOCK with a reason. The executor handles:
 *   - hook input parsing (stdin JSON contract)
 *   - variable substitution into the prompt
 *   - LLM call with timeout + retries
 *   - response parsing into a strict ALLOW: / BLOCK: contract
 *   - fail-closed on error (default) or fail-open (opt-in)
 *   - audit logging via the existing daily-file mechanism
 *
 * Pattern parity: Letta Code's PromptHookConfig (src/hooks/prompt-executor.ts).
 * This is the equivalent for Keel — built on our local-inference substrate so
 * it costs zero API on the dedicated classifier port and stays sovereign-leaning
 * even though Tier 1 is cloud-compute by default.
 *
 * Usage:
 *   import { executePromptHook } from '../lib/prompt-hook-executor.ts';
 *
 *   const result = await executePromptHook(hookInput, {
 *     name: 'edit-architecture-judge',
 *     prompt: `You are an architecture reviewer for Keel. The agent is about
 *       to edit {file_path}. The change is:\n\n{diff}\n\nDoes this edit
 *       respect the existing module's responsibility, or does it cross a
 *       boundary it shouldn't? Respond with ALLOW: <reason> or BLOCK: <reason>.`,
 *     variables: {
 *       file_path: (h) => h.tool_input?.file_path || 'unknown',
 *       diff: (h) => (h.tool_input?.new_string || h.tool_input?.content || '').slice(0, 1500),
 *     },
 *     substrate: 'classifier',
 *     timeoutMs: 5000,
 *     failClosed: true,
 *   });
 *
 *   if (!result.ok) {
 *     process.stderr.write(`PROMPT HOOK BLOCKED: ${result.reason}\n`);
 *     process.exit(2);
 *   }
 *   process.exit(0);
 *
 * Readers: any hook script that needs LLM-evaluated allow/block.
 * Writers: stateless — calls localClassify in local-inference.ts.
 */

const HOOK_EXECUTOR_DEFAULTS = {
  timeoutMs: 5000,
  contextLimit: 1500,
  failClosed: true,
  substrate: 'classifier' as const,
  maxTokens: 120,
};

export interface PromptHookConfig {
  /** Stable name for this hook — used in logs and audit trail. */
  name: string;

  /**
   * Prompt template. Use {variable_name} placeholders that match keys in
   * the `variables` map. The executor performs simple string substitution
   * before calling the LLM — no Jinja, no escaping, just clarity.
   *
   * The prompt MUST instruct the model to respond with exactly one of:
   *   ALLOW: <reason>
   *   BLOCK: <reason>
   *
   * Anything else is treated as parse failure and falls back to the
   * fail-closed/fail-open setting.
   */
  prompt: string;

  /**
   * Functions that extract template variables from the raw hook input.
   * Each function receives the parsed hook JSON and returns a string.
   * The executor truncates each value to contextLimit chars before
   * substituting, so model context budgets stay predictable.
   */
  variables?: Record<string, (hookInput: any) => string>;

  /**
   * Which substrate to evaluate against.
   *   'classifier'      — Qwen3.5-9B on dedicated port 8005 (fast, ~600ms)
   *   'studio2-daily'   — Qwen3.5-35B for nuanced judgment (slower, ~3s)
   *   'studio1-identity' — Qwen3.5-27B identity-trained (when voice/character matters)
   *
   * Default: 'classifier'. Bump to a heavier substrate only when the
   * decision requires it.
   */
  substrate?: 'classifier' | 'studio2-daily' | 'studio1-identity';

  /** Max time the LLM call has before the executor gives up. */
  timeoutMs?: number;

  /**
   * On error (timeout, parse failure, network), what's the safe default?
   *   true  — fail-closed (BLOCK). Use for security-sensitive hooks.
   *   false — fail-open (ALLOW). Use for nice-to-have judgment hooks.
   *
   * Default: true. We prefer false negatives over false positives for safety.
   */
  failClosed?: boolean;

  /** Max chars per template variable before truncation. Default: 1500. */
  contextLimit?: number;

  /** Max output tokens from the LLM. Default: 120 — enough for ALLOW/BLOCK + reason. */
  maxTokens?: number;
}

export interface PromptHookResult {
  /** True = allow the operation, false = block it. */
  ok: boolean;

  /**
   * Human-readable explanation. Either the model's reason (on parse success)
   * or a system reason (on timeout/error/fallback).
   */
  reason: string;

  /** Raw LLM output for debugging. Empty string on hard error. */
  raw: string;

  /** Wall-clock duration of the LLM call. */
  durationMs: number;

  /** Did this result come from a fallback path (timeout/parse failure)? */
  fallback: boolean;

  /** Which substrate produced the result. */
  substrate: string;
}

/**
 * Execute a prompt hook against an LLM substrate and return a structured
 * allow/block decision.
 *
 * This function never throws — all errors are caught and converted into a
 * PromptHookResult with `fallback: true`. Hook scripts inspect `result.ok`
 * and exit with the appropriate code.
 */
export async function executePromptHook(
  hookInput: any,
  config: PromptHookConfig,
): Promise<PromptHookResult> {
  const start = Date.now();
  const timeoutMs = config.timeoutMs ?? HOOK_EXECUTOR_DEFAULTS.timeoutMs;
  const contextLimit = config.contextLimit ?? HOOK_EXECUTOR_DEFAULTS.contextLimit;
  const failClosed = config.failClosed ?? HOOK_EXECUTOR_DEFAULTS.failClosed;
  const substrate = config.substrate ?? HOOK_EXECUTOR_DEFAULTS.substrate;
  const maxTokens = config.maxTokens ?? HOOK_EXECUTOR_DEFAULTS.maxTokens;

  // Substitute template variables. Truncate each to contextLimit chars so
  // the prompt size stays bounded regardless of how big the hook input is.
  let resolvedPrompt = config.prompt;
  if (config.variables) {
    for (const [key, extractor] of Object.entries(config.variables)) {
      let value: string;
      try {
        value = String(extractor(hookInput) ?? '');
      } catch (err: any) {
        value = `[extraction failed: ${err?.message || 'unknown'}]`;
      }
      if (value.length > contextLimit) {
        value = value.slice(0, contextLimit) + '... [truncated]';
      }
      resolvedPrompt = resolvedPrompt.split(`{${key}}`).join(value);
    }
  }

  // Call the substrate. We use localClassify (which routes to the dedicated
  // classifier process by default) for the 'classifier' substrate, and the
  // generic localChat for heavier substrates.
  let raw = '';
  let fallback = false;
  let errMessage = '';

  try {
    if (substrate === 'classifier') {
      const { localClassify } = require('./local-inference.ts');
      raw = await localClassify(resolvedPrompt, {
        maxTokens,
        timeoutMs,
        fallback: '', // we want the empty string so we can detect timeout
      });
    } else {
      const { localChat } = require('./local-inference.ts');
      const target = substrate === 'studio2-daily' ? 'studio2-daily' : 'studio1-identity';
      const result = await localChat(resolvedPrompt, {
        substrate: target,
        maxTokens,
        timeoutMs,
        temperature: 0.2, // low temperature for judgment tasks
      });
      raw = result?.content || '';
    }
  } catch (err: any) {
    errMessage = err?.message || 'unknown error';
    fallback = true;
  }

  const durationMs = Date.now() - start;
  const trimmed = (raw || '').trim();

  // Parse the response. Strict contract: must start with ALLOW: or BLOCK:.
  // Anything else is a parse failure → fallback path.
  if (trimmed.startsWith('ALLOW:')) {
    return {
      ok: true,
      reason: trimmed.slice('ALLOW:'.length).trim() || 'allowed',
      raw: trimmed,
      durationMs,
      fallback: false,
      substrate,
    };
  }
  if (trimmed.startsWith('BLOCK:')) {
    return {
      ok: false,
      reason: trimmed.slice('BLOCK:'.length).trim() || 'blocked',
      raw: trimmed,
      durationMs,
      fallback: false,
      substrate,
    };
  }

  // Fallback path: timeout, parse failure, or empty response.
  fallback = true;
  const fallbackReason = errMessage
    ? `${config.name}: substrate error (${errMessage}) — fail-${failClosed ? 'closed' : 'open'}`
    : `${config.name}: response did not match ALLOW:/BLOCK: contract — fail-${failClosed ? 'closed' : 'open'}`;

  return {
    ok: !failClosed,
    reason: fallbackReason,
    raw: trimmed,
    durationMs,
    fallback,
    substrate,
  };
}

/**
 * Convenience helper for hook scripts: read stdin, parse JSON, execute the
 * hook, exit with the appropriate code, and write a one-line audit message
 * to stderr. Handles all the boilerplate hook scripts need.
 *
 * Usage at the bottom of a hook script:
 *
 *   if (require.main === module) {
 *     runPromptHookFromStdin({
 *       name: 'my-hook',
 *       prompt: '...',
 *       variables: {...},
 *     });
 *   }
 */
export async function runPromptHookFromStdin(config: PromptHookConfig): Promise<never> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookInput: any;
  try {
    hookInput = JSON.parse(input);
  } catch {
    process.stderr.write(`PROMPT HOOK ${config.name}: unparseable stdin — failing closed\n`);
    process.exit(2);
  }

  const result = await executePromptHook(hookInput, config);

  // Audit line on stderr (visible in hook logs, doesn't pollute stdout)
  const verdict = result.ok ? 'ALLOW' : 'BLOCK';
  const fallbackTag = result.fallback ? ' [fallback]' : '';
  process.stderr.write(
    `[prompt-hook] ${config.name} → ${verdict}${fallbackTag} (${result.durationMs}ms, ${result.substrate}): ${result.reason}\n`,
  );

  if (!result.ok) {
    process.exit(2);
  }
  process.exit(0);
}

// Export the helper for both ESM-style and CommonJS callers
module.exports = { executePromptHook, runPromptHookFromStdin };
