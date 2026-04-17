// @alienkind-core
/**
 * Failover state — which config directory is active when the primary Anthropic
 * account is rate-limited or unreachable. Thin state machine: primary ↔ secondary.
 *
 * Forkers with a single Anthropic account can ignore this entirely — everything
 * defaults to the primary config. Forkers with two accounts (e.g., two Max
 * plans) can point the state file at their alternate config dir during outages.
 */

const fs = require('fs');
const path = require('path');

const portable = require('./portable.ts');
const { resolveRepoRoot } = portable;

const ROOT = resolveRepoRoot();
const STATE_FILE = path.join(ROOT, 'logs', 'failover-state.json');

interface FailoverState {
  active: 'primary' | 'secondary';
  activatedAt?: string;
  reason?: string;
  primaryConfigDir?: string;
  secondaryConfigDir?: string;
}

function readFailoverState(): FailoverState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { active: 'primary' };
  }
}

function writeFailoverState(state: FailoverState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

function getActiveConfigDir(): string | undefined {
  const state = readFailoverState();
  return state.active === 'secondary' ? state.secondaryConfigDir : state.primaryConfigDir;
}

function getFailoverConfigDir(): string | undefined {
  const state = readFailoverState();
  return state.active === 'primary' ? state.secondaryConfigDir : state.primaryConfigDir;
}

function activateFailover(reason: string): void {
  const state = readFailoverState();
  writeFailoverState({
    ...state,
    active: state.active === 'primary' ? 'secondary' : 'primary',
    activatedAt: new Date().toISOString(),
    reason,
  });
}

const RATE_LIMIT_PATTERNS = ['rate_limit', '429', 'too many requests', 'quota exceeded'];
const AUTH_PATTERNS = ['unauthorized', '401', 'invalid_api_key', 'not logged in', 'authentication', 'auth'];

function isRateLimited(error: string | Error): boolean {
  const msg = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => msg.includes(p));
}

function isAuthError(error: string | Error): boolean {
  const msg = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  return AUTH_PATTERNS.some((p) => msg.includes(p));
}

function sendAuthAlert(_label: string, _err: Error): void {
  // Hook point — forkers wire their own alerting here (Telegram, Discord, email).
  // Default: log to stderr so the message isn't lost.
  try {
    process.stderr.write(`[failover] Auth error (${_label}): ${_err.message}\n`);
  } catch { /* ok */ }
}

module.exports = {
  readFailoverState,
  writeFailoverState,
  getActiveConfigDir,
  getFailoverConfigDir,
  activateFailover,
  isRateLimited,
  isAuthError,
  sendAuthAlert,
};
