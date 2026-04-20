// @alienkind-core
/**
 * intelligence-engine-keel.ts — Partner-self intelligence engine (stub).
 *
 * In the reference architecture this is a thin wrapper around
 * packages/steward-core, with partner-specific enhancements layered on top
 * (capability-gap false-positive verification against the codebase,
 * cross-process deduplication, custom synonyms). The stub shipped here
 * preserves the public surface callers depend on — updateDiscernmentDirect,
 * detectCapabilityGap, updateSession — as no-ops that return gracefully
 * when the steward-core package isn't wired.
 *
 * Filename note: named `intelligence-engine-keel.ts` because Keel was the
 * first partner to use it. Forkers can rename the file and its exports
 * freely — the module name carries no behavior.
 *
 * To activate full capability in your fork:
 *   1. Port packages/steward-core/src/index.ts from the reference repo
 *      (~547 lines; it owns the gap-pattern matching, discernment writer,
 *      and session tracking).
 *   2. Port scripts/lib/steward-core.ts (~54 line adapter that reads
 *      Supabase creds from process.env).
 *   3. Replace this stub with a version that calls
 *      createEngine('<your-partner-name>') and returns that engine.
 *
 * Until then, log-conversation.ts and agent-output-audit.ts (which wrap
 * every call site in try/catch) continue working — gap detection and
 * discernment-direct updates silently no-op.
 *
 * Callers: scripts/hooks/log-conversation.ts (updateDiscernmentDirect,
 *          detectCapabilityGap, updateSession), scripts/hooks/agent-output-audit.ts
 * Writers: (stub — nothing written until steward-core is ported)
 */

const { registerUnavailable } = require('./portable.ts');

registerUnavailable('intelligence-engine', {
  reason: 'steward-core package not ported in this fork.',
  enableWith: 'Port packages/steward-core/src/index.ts and scripts/lib/steward-core.ts from the reference repo, then replace this stub with the full implementation.',
  docs: 'See the module header in this file for the 3-step wiring recipe.',
});

// --- No-op exports matching the full engine's public surface ---

/**
 * Update discernment signals directly from a correction/reinforcement event.
 * Full implementation: writes a discernment outcome row tying the signal to
 * the channel and feeding AIRE's per-channel weight tuning.
 * Stub behavior: silently returns.
 */
function updateDiscernmentDirect(_correctionText: string, _wasHelpful: boolean, _context?: string): void {
  // no-op until steward-core is ported
}

/**
 * Detect a capability gap from a conversation exchange.
 * Full implementation: runs gap-pattern regex + LLM classification,
 * deduplicates against prior gaps, verifies the capability isn't already
 * in the codebase, writes to capability_requests for steward triage.
 * Stub behavior: silently returns.
 */
function detectCapabilityGap(_userMessage: string, _agentResponse: string, _sessionId?: string): void {
  // no-op until steward-core is ported
}

/**
 * Update the session heartbeat for the calling terminal.
 * Full implementation: upserts steward-session rows keyed by terminal_id
 * so nightly analysis knows which terminals are active.
 * Stub behavior: resolves to undefined.
 */
async function updateSession(_terminalId: string): Promise<void> {
  // no-op until steward-core is ported
  return;
}

module.exports = {
  updateDiscernmentDirect,
  detectCapabilityGap,
  updateSession,
  // Legacy shape: some reference-code patterns call `engine.method()`. Expose
  // a default engine object too so forks migrating from an older stub shape
  // don't break.
  detectCapabilityGapLegacy: detectCapabilityGap,
};
