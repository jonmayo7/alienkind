// @alienkind-core
/**
 * Hook Dispatcher — Runtime Adapter Library
 *
 * Fires the same hooks as Claude Code, using the same scripts, same JSON
 * stdin contract, same exit code semantics. Used by alternate runtime
 * adapters (emergency runtime, custom CLIs) when Claude Code is not the
 * runtime. When Claude Code IS the runtime, hooks fire natively — this
 * library is not called. No dual-fire risk because only one runtime is
 * active at a time.
 *
 * Source of truth: .claude/settings.local.json (Claude Code native format).
 * This is the same file Claude Code reads natively, so Path A and Path B
 * see the same hook registry. If it is missing or unparsable, the module
 * calls registerUnavailable('hook-dispatch', ...) once and every fire*
 * function returns { blocked: false, output: '' } — a safe no-op. That
 * lets the alternate runtime keep working before the human has configured
 * hooks.
 *
 * Usage:
 *   const { firePreToolUse, firePostToolUse } = require('./hooks.ts');
 *   const result = firePreToolUse('Bash', { command: 'git push' }, sessionId, log);
 *   if (result.blocked) { // handle block }
 *
 * Readers: emergency-tools.ts, runtime adapters
 * Writers: .claude/settings.local.json (canonical — copy from the .example
 *          template and edit by hand; Claude Code reads the same file)
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const { registerUnavailable } = require('./portable.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(ALIENKIND_DIR, '.claude', 'settings.local.json');

// --- Types ---

interface HookEntry {
  /** Claude Code native: always 'command'. Kept optional for future types. */
  type?: string;
  /** Full shell command including runtime (e.g., 'node scripts/hooks/foo.ts'). */
  command: string;
}

interface HookGroup {
  /** Tool matcher (e.g., 'Bash', 'Edit'). Omit for event-level hooks. */
  matcher?: string;
  hooks: HookEntry[];
}

interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
}

interface HookPayload {
  session_id: string;
  tool_input?: Record<string, any>;
  tool_output?: string;
}

interface HookResult {
  blocked: boolean;
  output: string;
}

type LogFn = (level: string, msg: string) => void;

// --- Config loader ---

let _hookConfig: HookSettings | null = null;
let _unavailableRegistered = false;

function loadConfig(): HookSettings {
  if (_hookConfig) return _hookConfig;

  if (!fs.existsSync(SETTINGS_PATH)) {
    if (!_unavailableRegistered) {
      registerUnavailable('hook-dispatch', {
        reason: '.claude/settings.local.json not found — alternate-runtime hook dispatch cannot fire enforcement hooks',
        enableWith: 'Copy .claude/settings.local.json.example to .claude/settings.local.json. Claude Code reads the same file natively — Path A and Path B stay in sync.',
      });
      _unavailableRegistered = true;
    }
    _hookConfig = { hooks: {} };
    return _hookConfig;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as HookSettings;
    if (!parsed.hooks) parsed.hooks = {};
    _hookConfig = parsed;
  } catch (err: any) {
    if (!_unavailableRegistered) {
      registerUnavailable('hook-dispatch', {
        reason: `Failed to parse .claude/settings.local.json: ${err.message}`,
        enableWith: 'Validate the JSON syntax. Running `node -e "JSON.parse(require(\'fs\').readFileSync(\'.claude/settings.local.json\', \'utf8\'))"` will point at the error.',
      });
      _unavailableRegistered = true;
    }
    _hookConfig = { hooks: {} };
  }

  return _hookConfig;
}

// --- Core dispatcher ---

function dispatchHooks(
  eventType: string,
  toolName: string | null,
  payload: HookPayload,
  log: LogFn
): HookResult {
  const config = loadConfig();
  const groups = (config.hooks && config.hooks[eventType]) || [];

  let blocked = false;
  let output = '';

  for (const group of groups) {
    if (group.matcher && group.matcher !== toolName) continue;

    for (const hook of group.hooks) {
      if (!hook.command) continue;
      try {
        const result = spawnSync('bash', ['-c', hook.command], {
          input: JSON.stringify(payload),
          cwd: ALIENKIND_DIR,
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, ALIENKIND_DIR },
        });

        if (result.stdout) output += result.stdout;

        // exit 2 = blocked (enforcement hooks)
        if (result.status === 2) {
          blocked = true;
          if (result.stderr) output += result.stderr;
          log('WARN', `[hooks] ${eventType}/${toolName}: BLOCKED by ${hook.command}`);
        }
      } catch (err: any) {
        log('WARN', `[hooks] ${eventType}/${toolName}/${hook.command}: ${err.message}`);
      }
    }
  }

  return { blocked, output };
}

// --- Public API (mirrors Claude Code hook events) ---

function fireSessionStart(sessionId: string, log: LogFn): HookResult {
  return dispatchHooks('SessionStart', null, { session_id: sessionId }, log);
}

function firePreToolUse(
  toolName: string,
  toolInput: Record<string, any>,
  sessionId: string,
  log: LogFn
): HookResult {
  return dispatchHooks('PreToolUse', toolName, { session_id: sessionId, tool_input: toolInput }, log);
}

function firePostToolUse(
  toolName: string,
  toolInput: Record<string, any>,
  toolOutput: string,
  sessionId: string,
  log: LogFn
): HookResult {
  return dispatchHooks('PostToolUse', toolName, {
    session_id: sessionId,
    tool_input: toolInput,
    tool_output: (toolOutput || '').slice(0, 5000),
  }, log);
}

function fireUserPromptSubmit(sessionId: string, log: LogFn): HookResult {
  return dispatchHooks('UserPromptSubmit', null, { session_id: sessionId }, log);
}

function firePreCompact(sessionId: string, log: LogFn): HookResult {
  return dispatchHooks('PreCompact', null, { session_id: sessionId }, log);
}

function fireStop(sessionId: string, log: LogFn): HookResult {
  return dispatchHooks('Stop', null, { session_id: sessionId }, log);
}

module.exports = {
  fireSessionStart,
  firePreToolUse,
  firePostToolUse,
  fireUserPromptSubmit,
  firePreCompact,
  fireStop,
  dispatchHooks,
  loadConfig,
};
