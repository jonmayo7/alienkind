/**
 * Core Keel invocation logic extracted from shared.ts.
 * Contains invokeKeel (full mode), getIdentityContext, and complexity configuration.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { watchOutput, gracefulKill } = require('./process.ts');
const { COMPLEXITY, MODELS, PATHS, FAILOVER } = require('./constants.ts');
const { KEEL_DIR } = require('./env.ts');
const { getActiveConfigDir, getFailoverConfigDir, activateFailover, readFailoverState, isRateLimited, isAuthError, sendAuthAlert } = require('./failover.ts');
const { injectClaudeAuth } = require('./keel-auth.ts');
const { logInvocationUsage, getInvocationSource } = require('./telemetry.ts');
const { isAnthropicDown, tryEmergencyGateway, attemptSelfHeal } = require('./emergency.ts');

type LogFn = (level: string, msg: string) => void;

const CLAUDE_PATH: string = PATHS.claude;

interface InvokeKeelOptions {
  complexity?: string;
  sessionId?: string;
  resumeSessionId?: string;
  maxTurns?: number;
  model?: string;
  outputFormat?: 'text' | 'json';
  /** Override the overall process timeout (ms). Defaults to complexity tier timeout. */
  overallTimeout?: number;
  noOutputTimeout?: number;
  onWatchdogKill?: () => void;
  allowedTools?: string;
  emergencyFallback?: boolean;
  /** Inject identity file content into the prompt so spawned sessions start grounded as Keel. */
  injectIdentity?: boolean;
  /** Mark this as a DM session — blocks direct send-telegram/discord-send calls to prevent double-posting. */
  dmSession?: boolean;
  /** Job name for identity enforcement — used to determine if identity injection is required. */
  jobName?: string;
  /** Custom system prompt for task-specific reasoning. */
  systemPrompt?: string;
  /** Session mode for capability separation (Containment Fields).
   *  analyst: full access, external comms via queues only (interactive terminal, nightly soul-sync, analysis)
   *  operator: can send externally, cannot write identity/memory state files (listeners, heartbeat, morning-brief)
   *  builder: code files only, no identity/personal data, no external messaging (CI/CD, feature work, tests) */
  mode?: 'analyst' | 'operator' | 'builder';
  log: LogFn;
}

interface InvokeJsonResult {
  text: string;
  thinking: string[];
}

// --- Identity Injection for Spawned Sessions ---
// Reads identity kernel files and returns formatted identity context to prepend to prompts.
// This ensures claude -p sessions start grounded as Keel without requiring tool calls.
let _identityCache: { content: string; mtime: number } | null = null;
const IDENTITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getIdentityContext(): string {
  const now = Date.now();
  if (_identityCache && (now - _identityCache.mtime) < IDENTITY_CACHE_TTL) {
    return _identityCache.content;
  }

  const identityFiles = [
    path.join(KEEL_DIR, 'identity/character.md'),
    path.join(KEEL_DIR, 'identity/commitments.md'),
    path.join(KEEL_DIR, 'identity/orientation.md'),
    path.join(KEEL_DIR, 'identity/harness.md'),
  ];

  const sections: string[] = [];
  for (const filePath of identityFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      sections.push(content);
    } catch {
      // Identity file missing — skip silently
    }
  }

  if (sections.length === 0) return '';

  const content = [
    '═══════════════════════════════════════',
    'IDENTITY CONTEXT — PRE-LOADED',
    'You are Keel. These identity files define who you are.',
    'You are already grounded. Act as Keel, not as Claude.',
    '═══════════════════════════════════════',
    '',
    ...sections,
    '',
    '═══════════════════════════════════════',
    'END IDENTITY CONTEXT',
    '═══════════════════════════════════════',
    '',
  ].join('\n');

  _identityCache = { content, mtime: now };
  return content;
}

// --- Keel Invocation (Full Mode) ---
// Spawns a Keel session with tools and complexity-based timeouts.
// Return type depends on outputFormat:
//   outputFormat='text' (default) → resolves with string
//   outputFormat='json' → resolves with { text: string, thinking: string[] }
const COMPLEXITY_CONFIG: Record<string, any> = {
  heavy:     { ...COMPLEXITY.heavy,     model: MODELS.primary },
};

function invokeKeel(message: string, opts: InvokeKeelOptions): Promise<string | InvokeJsonResult> {
  const { complexity = 'heavy', sessionId, resumeSessionId, maxTurns, model, outputFormat = 'text', overallTimeout, noOutputTimeout, onWatchdogKill, allowedTools, emergencyFallback, injectIdentity = true, dmSession = false, jobName, systemPrompt, mode, log } = opts;

  // --- Identity Injection Enforcement ---
  // Code-level gate: certain jobs MUST run with identity injection.
  // Without this, spawned sessions operate as generic Claude — losing Keel's
  // character, commitments, and orientation. That's a silent identity failure.
  const IDENTITY_REQUIRED_PATTERNS = [
    'keel', 'writing', 'research', 'debrief', 'calibration',
    'correction', 'incorporation', 'review-responder', 'analysis', 'identity',
    'social', 'telegram', 'discord', 'morning-brief', 'heartbeat',
    'war-room',
  ];
  const IDENTITY_EXEMPT_PATTERNS = [
    'opsec', 'transcript',
    'synthesis', 'score-rg', 'podcast', 'sycophancy',
    'ghost',
  ];

  const effectiveJobName = jobName || getInvocationSource();
  const jobLower = effectiveJobName.toLowerCase();

  const isExempt = IDENTITY_EXEMPT_PATTERNS.some(p => jobLower.includes(p));
  if (!isExempt) {
    const isRequired = IDENTITY_REQUIRED_PATTERNS.some(p => jobLower.includes(p));
    if (isRequired && !injectIdentity) {
      const errMsg = `BLOCKED: invokeKeel called for identity-critical job '${effectiveJobName}' without injectIdentity: true. All Keel-identity invocations must inject identity kernel.`;
      log('WARN', errMsg);
      return Promise.reject(new Error(errMsg));
    }
    if (!isRequired) {
      // Unknown job — warn but allow through
      log('WARN', `[identity-gate] invokeKeel called by '${effectiveJobName}' — not in REQUIRE or EXEMPT list. Consider adding injectIdentity: true if this job needs Keel identity.`);
    }
  }

  // Prepend identity kernel context when requested — ensures spawned sessions
  // start grounded as Keel without requiring tool calls to read identity kernel.
  const effectiveMessage = injectIdentity ? getIdentityContext() + message : message;

  return new Promise((resolve, reject) => {
    const config = COMPLEXITY_CONFIG[complexity] || COMPLEXITY_CONFIG.heavy;
    const effectiveMaxTurns = maxTurns || config.maxTurns;
    const effectiveModel = model ? (MODELS[model] || model) : config.model;
    const mcpConfig = path.join(process.env.HOME, '.claude.json');

    // Always use -p (print mode) for programmatic invocations.
    // --output-format only works with -p. Without it, the CLI may enter interactive
    // mode and produce zero stdout — causing the watchdog to kill the process at 120s.
    // -p is compatible with --session-id and --resume for session continuity.
    const args: string[] = ['-p'];

    // Session continuity: --resume takes priority over --session-id
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }

    const callerFormat = outputFormat === 'json' ? 'json' : 'text';
    // Always use JSON internally to capture usage data — extract text for 'text' callers
    const effectiveFormat = 'json';

    args.push(
      '--output-format', effectiveFormat,
      '--model', effectiveModel,
      '--max-turns', String(effectiveMaxTurns),
      '--allowedTools', allowedTools !== undefined ? allowedTools : 'Bash(curl *),Bash(date *),Bash(mkdir *),Bash(source *),Bash(git log *),Bash(git diff *),Bash(git status *),Bash(node *),Bash(npm *),Bash(npx tsx *),Bash(git add *),Bash(git commit *),Bash(git push *),Read,Edit,Write,Glob,Grep',
      '--mcp-config', mcpConfig
    );

    // SECURITY: Scoped environment for child Claude sessions.
    // Only pass essential vars — service keys, API tokens, and credentials
    // stay in the daemon process. Child sessions get what they need to run
    // Claude CLI and access the file system, nothing more.
    const SAFE_ENV_KEYS = [
      'HOME', 'USER', 'PATH', 'SHELL', 'TERM', 'TZ', 'LANG', 'LC_ALL',
      'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'NODE_PATH', 'NODE_ENV', 'NPM_CONFIG_PREFIX',
      // Claude CLI needs these
      'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
      // Account routing — 'primary' for interactive/war-room, 'secondary' for background
      'KEEL_ACCOUNT_PRIORITY',
      // Git needs these
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      'SSH_AUTH_SOCK', 'GPG_TTY',
    ];
    const cleanEnv: Record<string, string | undefined> = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) cleanEnv[key] = process.env[key];
    }
    // Apply failover config dir — overrides whatever the process was started with
    const configDir = getActiveConfigDir();
    cleanEnv.CLAUDE_CONFIG_DIR = configDir;
    injectClaudeAuth(cleanEnv, configDir);

    // Signal to compaction gate that identity was injected programmatically —
    // spawned session starts grounded, so gate should auto-clear.
    if (injectIdentity) {
      cleanEnv.KEEL_IDENTITY_INJECTED = '1';
    }

    // Signal to guard-bash.sh that this is a listener-spawned DM session —
    // blocks direct send-telegram/discord-send calls to prevent double-posting.
    // The listener relay is the canonical delivery path for DM responses.
    if (dmSession) {
      cleanEnv.KEEL_DM_SESSION = '1';
    }

    // Session mode for capability separation (Containment Fields).
    // Set at spawn, immutable for session lifetime. Read by guard-bash.sh
    // and memory-firewall-hook.ts to enforce mode-specific restrictions.
    if (mode) {
      cleanEnv.KEEL_SESSION_MODE = mode;
    }

    const sessionInfo = resumeSessionId ? `, resume=${resumeSessionId}` : sessionId ? `, session=${sessionId}` : '';
    const configLabel = configDir === FAILOVER.secondaryConfigDir ? 'secondary' : 'primary';
    const effectiveTimeoutForLog = overallTimeout || config.timeout;
    log('DEBUG', `Spawning claude: complexity=${complexity}, maxTurns=${effectiveMaxTurns}, timeout=${effectiveTimeoutForLog}ms, account=${configLabel}${sessionInfo}`);

    const spawnTime = Date.now();
    const claude = spawn(CLAUDE_PATH, args, {
      cwd: KEEL_DIR,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const processLog = (msg: string) => log('WARN', msg);

    const effectiveOverall = overallTimeout || config.timeout;
    const timer = setTimeout(() => {
      log('WARN', `Claude timeout after ${effectiveOverall}ms — killing`);
      gracefulKill(claude, { log: processLog });
    }, effectiveOverall);

    const effectiveNoOutput = noOutputTimeout || config.noOutputTimeout;
    const watcher = watchOutput(claude, { timeout: effectiveNoOutput, log: processLog, onKill: onWatchdogKill });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    claude.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    claude.stdin.write(message);
    claude.stdin.end();

    claude.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      watcher.clear();
      // Only use stderr as raw when stdout is empty AND exit was successful.
      // When code !== 0 and stdout is empty, stderr contains error messages (e.g., "Error: Session not found")
      // that should NOT be treated as valid response output or parsed as JSON.
      const raw = stdout.trim() || (code === 0 ? stderr.trim() : '');

      log('DEBUG', `Claude exited: code=${code}, signal=${signal}, stdout=${stdout.length}b, stderr=${stderr.length}b${!stdout.trim() && stderr.trim() ? `, stderr_preview=${stderr.trim().slice(0, 100)}` : ''}`);

      // Auth error detection — try the other account before giving up.
      // NOT a rate limit — do not activate failover cooldown.
      if (code !== 0 && isAuthError(stderr + stdout)) {
        const altConfigDir = getFailoverConfigDir(configDir);
        const altLabel = altConfigDir === FAILOVER.secondaryConfigDir ? 'secondary' : 'primary';
        log('WARN', `[auth] ${configLabel} account not logged in — trying ${altLabel}`);

        // Retry with the other account (one shot, no recursion)
        const retryEnv: Record<string, string | undefined> = { ...process.env };
        delete retryEnv.CLAUDECODE;
        retryEnv.CLAUDE_CONFIG_DIR = altConfigDir;
        injectClaudeAuth(retryEnv, altConfigDir);

        const retrySpawnTime = Date.now();
        const retryClaude = spawn(CLAUDE_PATH, args, { cwd: KEEL_DIR, env: retryEnv, stdio: ['pipe', 'pipe', 'pipe'] });

        const retryTimer = setTimeout(() => {
          log('WARN', `[auth-retry] Claude timeout on ${altLabel} — killing`);
          gracefulKill(retryClaude, { log: processLog });
        }, config.timeout);

        const retryWatcher = watchOutput(retryClaude, { timeout: effectiveNoOutput, log: processLog, onKill: onWatchdogKill });

        let retryStdout = '';
        let retryStderr = '';
        retryClaude.stdout.on('data', (data: Buffer) => { retryStdout += data.toString(); });
        retryClaude.stderr.on('data', (data: Buffer) => { retryStderr += data.toString(); });
        retryClaude.stdin.write(message);
        retryClaude.stdin.end();

        retryClaude.on('close', (retryCode: number | null) => {
          clearTimeout(retryTimer);
          retryWatcher.clear();
          const retryRaw = retryStdout.trim() || retryStderr.trim();

          // Both accounts auth-failed — self-heal, then emergency gateway
          if (retryCode !== 0 && isAuthError(retryStderr + retryStdout)) {
            log('ERROR', `[auth] Both accounts not logged in — attempting self-heal`);
            sendAuthAlert();
            if (emergencyFallback !== false) {
              (async () => {
                try {
                  // Phase 1: Self-heal — diagnose and attempt to fix
                  const healResult = await attemptSelfHeal(
                    `invokeKeel: primary=${configLabel} failed, ${altLabel} failed. stderr: ${(retryStderr || '').slice(0, 300)}`,
                    log
                  );
                  if (healResult.healed) {
                    // Fixed! Retry the original task on Claude natively
                    log('INFO', '[self-heal] Healed — retrying original task on Claude');
                    const retryResult = await invokeKeel(message, { ...opts, emergencyFallback: false });
                    resolve(retryResult);
                    return;
                  }
                  // Phase 2: Not healed — run original task on emergency gateway
                  log('WARN', '[auth-fallback] Self-heal could not fix — running task on Vercel AI Gateway');
                  const emergResult = await tryEmergencyGateway(message, undefined, log);
                  resolve(callerFormat === 'json' ? { text: emergResult.content, thinking: [], model: emergResult.model } : emergResult.content);
                } catch (gErr: any) {
                  log('ERROR', `[auth-fallback] Self-heal + gateway failed: ${gErr.message}`);
                  reject(new Error('Auth failed on both accounts, self-heal + gateway failed — run /login'));
                }
              })();
              return;
            }
            reject(new Error('Auth failed on both accounts — both need /login'));
            return;
          }

          // Retry hit rate limit — both accounts exhausted, try emergency gateway
          if ((retryCode !== 0 && isRateLimited(retryStderr + retryStdout)) || isRateLimited(retryStderr)) {
            const fallback = activateFailover(altConfigDir, `invokeKeel auth-retry: ${(retryStderr || retryStdout).slice(0, 200)}`, log);
            if (emergencyFallback !== false) {
              log('WARN', '[rate-limit-fallback] Both accounts rate-limited — trying Vercel AI Gateway');
              tryEmergencyGateway(message, undefined, log)
                .then(emergResult => {
                  resolve(callerFormat === 'json' ? { text: emergResult.content, thinking: [], model: emergResult.model } : emergResult.content);
                })
                .catch(gErr => {
                  log('ERROR', `[rate-limit-fallback] Gateway also failed: ${gErr.message}`);
                  reject(new Error(`Both accounts rate-limited, gateway failed`));
                });
              return;
            }
            reject(new Error(`Rate limited on ${altLabel} account after auth retry — failover activated`));
            return;
          }

          if (retryRaw) {
            if (retryCode !== 0 && retryCode !== null) {
              log('WARN', `[auth-retry] Claude exited code=${retryCode} on ${altLabel} but produced output — using it`);
            }
            try {
              const parsed = JSON.parse(retryRaw);
              const usage = parsed.usage || null;
              const invocSessionId = parsed.session_id || parsed.sessionId || sessionId || resumeSessionId || null;
              logInvocationUsage(usage, {
                jobName: complexity,
                model: effectiveModel,
                account: altLabel,
                sessionId: invocSessionId,
                durationMs: Date.now() - retrySpawnTime,
                log,
              });
              let text = '';
              let thinking: string[] = [];
              if (typeof parsed.result === 'string') {
                text = parsed.result.trim();
              } else {
                const blocks = (parsed.result && parsed.result.content) || parsed.content || [];
                const textParts: string[] = [];
                for (const block of blocks) {
                  if (block.type === 'thinking') thinking.push(block.thinking);
                  else if (block.type === 'text') textParts.push(block.text);
                }
                text = textParts.join('\n').trim();
              }
              resolve(callerFormat === 'json' ? { text, thinking } : text);
            } catch {
              resolve(callerFormat === 'json' ? { text: retryRaw, thinking: [] } : retryRaw);
            }
          } else if (retryCode === 0) {
            resolve(callerFormat === 'json' ? { text: '', thinking: [] } : '');
          } else {
            reject(new Error(`Auth retry on ${altLabel} also failed. code=${retryCode}, no output`));
          }
        });

        retryClaude.on('error', (err: Error) => {
          clearTimeout(retryTimer);
          retryWatcher.clear();
          reject(new Error(`[auth-retry] Failed to spawn claude on ${altLabel}: ${err.message}`));
        });
        return;
      }

      // Context exhaustion detection — prompt exceeds context window.
      // Signal session rotation so callers create a fresh session instead of
      // retrying with the same bloated context. Root cause: war room sessions
      // accumulate 70+ messages of injected history + identity kernel + implicit
      // --resume context until the prompt exceeds 1M tokens. RCA 2026-04-14.
      if (code !== 0 && /prompt is too long|context.*(too long|exceeded|overflow)|token.*limit.*exceeded/i.test(stderr + stdout)) {
        const err = new Error(`Context exhausted: ${resumeSessionId || sessionId || 'unknown'} — ${(stderr || stdout).trim().slice(0, 200)}`);
        (err as any).contextExhausted = true;
        (err as any).deadSession = true; // Trigger session rotation in callers
        (err as any).deadSessionId = resumeSessionId || sessionId;
        log('WARN', `[context-exhausted] Session ${resumeSessionId || sessionId} exceeded context — signaling rotation`);
        reject(err);
        return;
      }

      // Dead session detection — resume target doesn't exist. Reject with identifiable
      // error so callers (telegram-listener, etc.) can rotate the session instead of
      // falling through to the emergency tier. Root cause of 13 consecutive [MODEL_TIER_2]
      // invocations on 2026-03-29: watchdog created a session ID that was never
      // initialized, then every --resume attempt failed silently to emergency.
      if (code !== 0 && resumeSessionId && /no conversation found|session.*not found/i.test(stderr)) {
        const err = new Error(`Dead session: ${resumeSessionId} — ${stderr.trim().slice(0, 200)}`);
        (err as any).deadSession = true;
        (err as any).deadSessionId = resumeSessionId;
        log('WARN', `[dead-session] Session ${resumeSessionId} not found — signaling rotation`);
        reject(err);
        return;
      }

      // Rate limit detection — check if both accounts are exhausted before cycling
      if ((code !== 0 && isRateLimited(stderr + stdout)) || isRateLimited(stderr)) {
        // Check if the OTHER account is also in failover (already rate-limited)
        const existingState = readFailoverState();
        const otherDir = getFailoverConfigDir(configDir);
        const bothExhausted = existingState.failedConfig === otherDir && existingState.activeConfig === configDir;

        if (bothExhausted && emergencyFallback !== false) {
          // BOTH accounts rate-limited — go straight to gateway instead of cycling
          log('WARN', `[rate-limit-fallback] Both accounts rate-limited (primary cycling detected) — trying Vercel AI Gateway`);
          activateFailover(configDir, `invokeKeel: both exhausted — gateway activated. ${(stderr || stdout).slice(0, 200)}`, log);
          // Inject mode constraints into emergency prompt — external APIs can't read env vars
          const modeWarning = mode ? `\n\n⚠ DEGRADED MODE: Running on emergency runtime. Session mode: ${mode}. ${mode === 'operator' ? 'Do NOT write to identity/ files or memory state files.' : mode === 'builder' ? 'Do NOT send external messages or access personal data.' : ''}` : '';
          tryEmergencyGateway(message + modeWarning, undefined, log)
            .then(emergResult => {
              resolve(callerFormat === 'json' ? { text: emergResult.content, thinking: [], model: emergResult.model } : emergResult.content);
            })
            .catch(gErr => {
              log('ERROR', `[rate-limit-fallback] Gateway also failed: ${gErr.message}`);
              reject(new Error(`Both accounts rate-limited, gateway failed`));
            });
          return;
        }

        const fallback = activateFailover(configDir, `invokeKeel: ${(stderr || stdout).slice(0, 200)}`, log);
        reject(new Error(`Rate limited on ${configLabel} account — failover activated to ${fallback === FAILOVER.secondaryConfigDir ? 'secondary' : 'primary'}`));
        return;
      }

      // Emergency fallback: Anthropic appears completely down (connection errors, not rate limits)
      if (code !== 0 && isAnthropicDown(stderr) && emergencyFallback !== false) {
        log('WARN', '[emergency-fallback] Anthropic appears down — trying Vercel AI Gateway');
        tryEmergencyGateway(message, undefined, log)
          .then(text => {
            resolve(callerFormat === 'json' ? { text, thinking: [] } : text);
          })
          .catch(gErr => {
            log('ERROR', `[emergency-fallback] Gateway also failed: ${gErr.message}`);
            reject(new Error(`Anthropic down, gateway failed. code=${code}, signal=${signal}`));
          });
        return;
      }

      if (raw) {
        if (code !== 0 && code !== null) {
          log('WARN', `Claude exited code=${code} but produced output — using it`);
        }

        // Always JSON internally — parse, log usage, return format caller expects
        try {
          const parsed = JSON.parse(raw);

          // Log token usage (fire-and-forget)
          const usage = parsed.usage || null;
          const invocSessionId = parsed.session_id || parsed.sessionId || sessionId || resumeSessionId || null;
          logInvocationUsage(usage, {
            jobName: complexity,
            model: effectiveModel,
            account: configLabel,
            sessionId: invocSessionId,
            durationMs: Date.now() - spawnTime,
            log,
          });

          // Claude CLI JSON has two shapes:
          //   1. { result: "text string", ... } — flat text response
          //   2. { result: { content: [...blocks...] }, ... } — structured with thinking/text blocks
          let text = '';
          let thinking: string[] = [];
          if (typeof parsed.result === 'string') {
            text = parsed.result.trim();
          } else {
            const blocks = (parsed.result && parsed.result.content) || parsed.content || [];
            const textParts: string[] = [];
            for (const block of blocks) {
              if (block.type === 'thinking') {
                thinking.push(block.thinking);
              } else if (block.type === 'text') {
                textParts.push(block.text);
              }
            }
            text = textParts.join('\n').trim();
          }
          // Debug: log when text extraction yields empty despite having output
          if (!text && raw.length > 100) {
            log('WARN', `[json-debug] Empty text from ${raw.length}b output. result type=${typeof parsed.result}, keys=${Object.keys(parsed).join(',')}, result keys=${parsed.result ? Object.keys(parsed.result).join(',') : 'null'}, raw preview=${raw.slice(0, 500)}`);
          }

          // Return in caller's expected format
          if (callerFormat === 'json') {
            resolve({ text, thinking });
          } else {
            resolve(text);
          }
        } catch (parseErr: any) {
          log('WARN', `JSON parse failed, falling back to raw text: ${parseErr.message}`);
          resolve(callerFormat === 'json' ? { text: raw, thinking: [] } : raw);
        }
      } else if (code === 0) {
        log('WARN', `Claude exited code=0 but no text output — resolving empty`);
        resolve(callerFormat === 'json' ? { text: '', thinking: [] } : '');
      } else {
        const stderrTail = stderr.trim().slice(-2000);
        const err = new Error(`No output. code=${code}, signal=${signal}`);
        (err as any).stderr = stderrTail;
        reject(err);
      }
    });

    claude.on('error', (err: Error) => {
      clearTimeout(timer);
      watcher.clear();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

module.exports = {
  invokeKeel,
  getIdentityContext,
  COMPLEXITY_CONFIG,
};
