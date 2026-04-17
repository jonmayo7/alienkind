// @alienkind-core
/**
 * Emergency Tier — cloud fallback when the primary provider is down.
 *
 * Uses gateway.ts to route requests through an OpenAI-compatible gateway.
 * If the gateway is not configured (no AI_GATEWAY_API_KEY), invokeEmergency
 * throws CapabilityUnavailable with enable instructions instead of failing
 * silently.
 *
 * isAnthropicDown is a heuristic — if the error message matches known
 * down-patterns from EMERGENCY.downPatterns, return true. Callers use this
 * to decide whether to fall over or retry primary.
 */

const portable = require('./portable.ts');
const { CapabilityUnavailable } = portable;

const { EMERGENCY } = require('./constants.ts');
const { callGateway, isModelDown } = require('./gateway.ts');

function isAnthropicDown(error: string | Error): boolean {
  const msg = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return (EMERGENCY.downPatterns as string[]).some((p: string) => msg.includes(p)) || isModelDown(msg);
}

interface EmergencyInvokeOptions {
  messages: Array<{ role: string; content: string | null; name?: string; tool_call_id?: string; tool_calls?: any[] }>;
  tools?: any[];
  model?: string;
  log?: (level: string, msg: string) => void;
}

/**
 * Call the emergency gateway. Throws CapabilityUnavailable if no gateway key.
 * Callers wrap in try/catch. A clean failure here surfaces the enable path to
 * the human via the capability registry.
 */
async function invokeEmergency(opts: EmergencyInvokeOptions): Promise<{ content: string | null; model: string; tier: string }> {
  const log = opts.log || (() => {});
  log('INFO', '[emergency] Invoking gateway tier');
  const result = await callGateway({
    messages: opts.messages as any,
    tools: opts.tools,
    model: opts.model || EMERGENCY.primary,
    log,
  });
  return {
    content: result.content,
    model: result.model,
    tier: 'emergency',
  };
}

/**
 * Alternate name for callers that expect tryEmergencyGateway.
 */
const tryEmergencyGateway = invokeEmergency;

/**
 * Attempt self-heal on a recoverable error (auth, rate limit). Returns
 * { healed: true, diagnosis?: string } if the handler believes recovery
 * succeeded. Default implementation is a no-op that reports "no handler
 * available" — forkers wire their own self-heal logic here.
 */
async function attemptSelfHeal(
  _errorMessage: string,
  _log?: (level: string, msg: string) => void,
): Promise<{ healed: boolean; diagnosis?: string }> {
  return { healed: false, diagnosis: 'No self-heal handler configured. Investigate manually.' };
}

module.exports = {
  isAnthropicDown,
  invokeEmergency,
  tryEmergencyGateway,
  attemptSelfHeal,
};
