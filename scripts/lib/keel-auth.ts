// @alienkind-core
/**
 * Auth — Claude Code OAuth helper.
 *
 * Forkers who use Claude Code via a Max plan don't need this — Claude Code
 * manages its own credentials. This module exists for scripts that spawn
 * Claude Code as a child process with a specific config directory, which is
 * only needed for multi-account failover.
 *
 * Single-account forkers: these functions are no-ops.
 */

const fs = require('fs');
const path = require('path');

interface AuthCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check whether Claude Code can authenticate with the current config.
 * Returns { ok: true } optimistically unless we can prove otherwise.
 * Callers that care run a real ping instead of trusting this.
 */
function checkAuth(_configDir?: string): AuthCheckResult {
  // Can't cheaply verify without actually calling the CLI. Return optimistic.
  // Scripts that need hard verification should call claude directly and parse stderr.
  return { ok: true };
}

/**
 * Inject OAuth token into the child process env if the env var is set.
 * Returns a new env object; does NOT mutate process.env.
 */
function injectClaudeAuth(baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === 'string') out[k] = v;
  }
  // If an OAuth token is explicitly set, pass it through under Claude Code's expected name.
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_OAUTH_TOKEN;
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}

module.exports = {
  checkAuth,
  injectClaudeAuth,
};
