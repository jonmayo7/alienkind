// @alienkind-core
/**
 * Shared — barrel re-export for scripts that want invocation + failover +
 * auth + logging together.
 *
 * Prefer importing from the sub-modules directly when you only need one or
 * two functions. Importing from shared.ts pulls the entire tree, which is
 * fine for daemon/listener runtimes but wasteful for lightweight CLI tools.
 *
 * Sub-modules this barrel exposes:
 *   env.ts            — ALIENKIND_DIR, loadEnv, requireEnv, date utils, daily logger
 *   keel-logger.ts    — createLogger, classifyMessage, logConversation
 *   failover.ts       — state, active/failover config dir, isRateLimited, isAuthError
 *   keel-auth.ts      — checkAuth, injectClaudeAuth
 *   telemetry.ts      — logInvocationUsage
 *   sentinel.ts       — createSentinel
 *   emergency.ts      — isAnthropicDown, invokeEmergency, attemptSelfHeal
 *   invoke-keel.ts    — invokeKeel (alias to invoke.ts)
 */

process.env.TZ = process.env.TZ || require('./constants.ts').TIMEZONE;

const env = require('./env.ts');
const logger = require('./keel-logger.ts');
const failover = require('./failover.ts');
const auth = require('./keel-auth.ts');
const telemetry = require('./telemetry.ts');
const sentinel = require('./sentinel.ts');
const emergency = require('./emergency.ts');
const invoke = require('./invoke-keel.ts');

module.exports = {
  // env.ts
  ALIENKIND_DIR: env.ALIENKIND_DIR,
  loadEnv: env.loadEnv,
  requireEnv: env.requireEnv,
  getCDTDate: env.getCDTDate,
  getNowCT: env.getNowCT,
  logToDaily: env.logToDaily,
  logDecision: env.logDecision,
  getDecisions: env.getDecisions,
  getSessionBrief: env.getSessionBrief,

  // keel-logger.ts
  createLogger: logger.createLogger,
  classifyMessage: logger.classifyMessage,
  logConversation: logger.logConversation,

  // failover.ts
  readFailoverState: failover.readFailoverState,
  writeFailoverState: failover.writeFailoverState,
  getActiveConfigDir: failover.getActiveConfigDir,
  getFailoverConfigDir: failover.getFailoverConfigDir,
  activateFailover: failover.activateFailover,
  isRateLimited: failover.isRateLimited,
  isAuthError: failover.isAuthError,

  // keel-auth.ts
  checkAuth: auth.checkAuth,
  injectClaudeAuth: auth.injectClaudeAuth,

  // telemetry.ts
  logInvocationUsage: telemetry.logInvocationUsage,

  // sentinel.ts
  createSentinel: sentinel.createSentinel,

  // emergency.ts
  isAnthropicDown: emergency.isAnthropicDown,
  invokeEmergency: emergency.invokeEmergency,
  attemptSelfHeal: emergency.attemptSelfHeal,

  // invoke-keel.ts
  invokeKeel: invoke.invokeKeel,
};
