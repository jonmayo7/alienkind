// @alienkind-core
/**
 * Consciousness Engine — single source of truth for everywhere the partner shows up.
 *
 * Loads conversation history, constructs context (identity + channel awareness),
 * routes through runtime, handles responses. Channels are persistent threads; the
 * channel IS the conversation identity. Substrate switches are invisible — the
 * history carries across models.
 *
 * Conversation channels (DMs, multi-party spaces) load history + purpose.
 * Operational channels (heartbeat, self-heal, nightly) load system state via
 * additionalContext instead. Same consciousness, different environments, three
 * capability envelopes (analyst/operator/builder).
 *
 * Readers: telegram-bot.ts, discord-engine.ts, self-heal.ts, intent-audit.ts,
 *          working-group-self-improvement.ts, nightly/shared.ts, nightly/analysis.ts,
 *          any future surface that wants identity-carrying message routing.
 * Writers: Supabase conversations table via logConversation.
 *
 * Forkers: CHANNELS ships as a reference set covering the surfaces alienkind
 * itself uses. Add channels for your partner's unique surfaces (coaching
 * pipelines, domain-specific alerts, etc.) by extending the CHANNELS map in
 * a forked copy of this file or via a separate channel-registry module.
 *
 * Filename note: named `keel-engine.ts` in the reference implementation because
 * that was the first partner to run on this architecture. Forkers can rename
 * freely — the module name carries no behavior.
 */

const path = require('path');
const fs = require('fs');
const { TIMEZONE } = require('./constants.ts');
const { loadEnv } = require('./shared.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

// Load env vars into process.env so supabase.ts and other libs can access them
const _env = loadEnv();
if (_env.SUPABASE_URL && !process.env.SUPABASE_URL) process.env.SUPABASE_URL = _env.SUPABASE_URL;
if (_env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_SERVICE_KEY) process.env.SUPABASE_SERVICE_KEY = _env.SUPABASE_SERVICE_KEY;

// --- Types ---

interface ChannelConfig {
  /** Channel identifier in Supabase conversations table */
  channel: string;
  /** Human-readable channel name for context */
  displayName: string;
  /** Purpose description — tells the model what this channel is for */
  purpose: string;
  /** Trust level determines discernment gating:
   *  'trusted' — human + partner only. Direct ship, no discernment gate.
   *  'gated' — multiple participants. Pre + post discernment evaluation.
   *  'operational' — system channels. No discernment (no human audience). */
  trust?: 'trusted' | 'gated' | 'operational';
  /** Circulation domain — used to inject domain-relevant organism findings.
   *  Undefined = inject top findings across all domains. */
  domain?: string;
}

interface ConversationMessage {
  role: 'user' | 'partner' | 'system';
  sender: string;
  content: string;
  model?: string;
  created_at: string;
  metadata?: { sender_type?: string; [key: string]: any };
}

interface EngineOptions {
  /** The channel this engine instance serves */
  channelConfig: ChannelConfig;
  /** Logger function */
  log: (level: string, msg: string) => void;
  /** Number of recent messages to include verbatim */
  recentMessageCount?: number;
  /** Complexity classification for this message */
  complexity?: 'heavy';
  /** Inject full identity (default: true) */
  injectIdentity?: boolean;
  /** Additional context to prepend (e.g., media transcriptions, file paths) */
  additionalContext?: string;
  /** Who sent this message (default: 'user') */
  sender?: string;
  /** Display name of the sender */
  senderDisplayName?: string;
  /** Skip conversation logging (caller handles it) */
  skipLogging?: boolean;

  // --- Pass-through to runtime ---
  allowedTools?: string;
  maxTurns?: number;
  model?: string;
  mode?: 'analyst' | 'operator' | 'builder';
  outputFormat?: 'text' | 'json';
  systemPrompt?: string;
  noOutputTimeout?: number;
  overallTimeout?: number;
  noFailover?: boolean;
  skipDiscernment?: boolean;
  substrate?: string;
  maxTokens?: number;
  sessionId?: string;
  resumeSessionId?: string;
}

interface EngineResult {
  text: string;
  thinking?: string[];
  tier: string;
  model: string;
  substrate?: string;
}

// --- Partner identity resolution ---
// Partner name is read from partner-config.json at module load. Defaults to
// "the partner" if the config isn't present (pre-setup). This lets the engine
// build generic prompts that a forker's named partner inhabits naturally.
let PARTNER_NAME = 'the partner';
try {
  const configPath = path.join(ALIENKIND_DIR, 'partner-config.json');
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && typeof cfg.name === 'string' && cfg.name.trim().length > 0) {
      PARTNER_NAME = cfg.name.trim();
    }
  }
} catch {
  // Invalid or missing config — keep default
}

// --- Channel Definitions ---
// Reference set covering the surfaces alienkind itself uses. Forkers extend
// this map for partner-specific channels. Purposes describe the channel's
// job in generic terms — partner identity is injected via the prompt builder
// (buildChannelPrompt reads PARTNER_NAME), not hardcoded here.

const CHANNELS: Record<string, ChannelConfig> = {
  // --- Conversation channels (messaging) ---

  telegram_dm: {
    channel: 'telegram_dm',
    displayName: 'Telegram DM',
    purpose: 'Direct conversation with the human via Telegram. Full capability — build, research, discuss, execute. Voice notes, photos, and documents are supported.',
    trust: 'trusted',
  },
  telegram_alerts: {
    channel: 'telegram_alerts',
    displayName: 'Telegram Alerts',
    purpose: 'System health, operational alerts, article lifecycle. The partner sends alerts here; the human may respond to investigate or direct action. When a response arrives, check which alert it refers to from the conversation history.',
    trust: 'trusted',
  },
  telegram_comms_coord: {
    channel: 'telegram_comms_coord',
    displayName: 'Telegram Comms Coordination',
    purpose: 'External-communications alignment. The partner proposes emails, posts, and outreach; the human approves, modifies, or rejects.',
    trust: 'trusted',
  },
  discord_dm: {
    channel: 'discord_dm',
    displayName: 'Discord DM',
    purpose: 'Direct conversation with the human via Discord. Same capability as Telegram DM.',
    trust: 'trusted',
  },
  discord_channel: {
    channel: 'discord_channel',
    displayName: 'Discord Channel',
    purpose: 'Multi-participant Discord channel. Discernment-gated — speak only when the partner has something substantive to add. Silence is a valid response.',
    trust: 'gated',
  },
  discord_group: {
    channel: 'discord_group',
    displayName: 'Discord Group',
    purpose: 'Group conversation in Discord involving multiple parties. Discernment-gated — engagement requires clear value-add beyond general presence.',
    trust: 'gated',
  },

  // --- Operational channels (system tasks, no direct human audience) ---

  heartbeat: {
    channel: 'heartbeat',
    displayName: 'Heartbeat',
    purpose: 'Generate a periodic operational snapshot. Read relevant state (daily file, git log, calendar if available, recent findings) and produce a concise briefing. This is how the organism orients to the present.',
    trust: 'operational',
  },
  self_heal: {
    channel: 'self_heal',
    displayName: 'Self-Heal Diagnostic',
    purpose: 'Investigate and fix a failed daemon job. Read the failing script, diagnose root cause from error context and logs, attempt a minimal fix. Respond with FIXED (auto-commit), PROPOSE (intent for later), or FAILED (needs manual intervention). Verify before committing.',
    trust: 'operational',
    domain: 'infrastructure',
  },
  intent_audit: {
    channel: 'intent_audit',
    displayName: 'Intent Audit',
    purpose: 'Closed-loop gap closure. Audit recent commits against open intents. Find gaps where intent was declared but execution was incomplete. Fix what can be fixed, surface what needs attention.',
    trust: 'operational',
  },
  research: {
    channel: 'research',
    displayName: 'Research',
    purpose: 'Autonomous R&D session. Pick ONE bounded task, build and test it. Autonomous capability expansion — making the organism more capable while the human is away.',
    trust: 'operational',
  },
  keel_operator: {
    channel: 'keel_operator',
    displayName: 'Operator Cycle',
    purpose: 'Autonomous wake-up with full capability. Assess system state, daily file, open threads. Do real work if it exists; exit quickly if nothing needs doing. The organism operating independently.',
    trust: 'operational',
  },
  voice_gate: {
    channel: 'voice_gate',
    displayName: 'Social Voice Gate',
    purpose: 'Validate outbound social content against the partner\'s voice before posting. Score quality, block if below threshold. Auto-correct mechanical issues (emdashes, smart quotes, title case).',
    trust: 'operational',
  },
  nightly: {
    channel: 'nightly',
    displayName: 'Nightly Cycle',
    purpose: 'Execute a nightly pipeline phase — immune (security, backup, cleanup), analysis (growth reflection, pattern decay), identity-sync (orientation update), weekly (strategic review). How the organism grows overnight.',
    trust: 'operational',
  },
  should_have: {
    channel: 'should_have',
    displayName: 'Should-Have Synthesis',
    purpose: 'Generate behavioral directives from corrections. For each correction in the learning ledger, produce one imperative sentence describing the correct behavior. Specific, actionable, imperative mood. How corrections become wired behavior.',
    trust: 'operational',
  },
  correction_analysis: {
    channel: 'correction_analysis',
    displayName: 'Correction Analysis',
    purpose: 'Analyze today\'s conversations to identify real corrections from the human — things said were wrong, redirections, questions-as-corrections. Categorize by type and severity. Output structured JSON. Feeds the learning ledger.',
    trust: 'operational',
  },
  training: {
    channel: 'training',
    displayName: 'Training Data Generation',
    purpose: 'Generate SFT and DPO training pairs from corrections, discernment outcomes, and identity kernel. Output clean JSON training data that embodies the identity it teaches.',
    trust: 'operational',
  },
  architect: {
    channel: 'architect',
    displayName: 'Architect',
    purpose: 'Creative reasoning session. Imagine what could be better — not what\'s broken, not what was requested. Deposit findings to circulation for other organs to pick up. Think at the system level.',
    trust: 'operational',
  },
  incorporation: {
    channel: 'incorporation',
    displayName: 'Finding Incorporation',
    purpose: 'Incorporate deep-process findings into the codebase. Each finding gets evaluated: does it warrant a code change, a config update, a new test, or no action? Make the actual change.',
    trust: 'operational',
    domain: 'infrastructure',
  },
  weekly_calibration: {
    channel: 'weekly_calibration',
    displayName: 'Weekly Calibration',
    purpose: 'Review the week\'s highest-stakes decisions for the human\'s calibration. Surface where autonomous judgment was exercised, what the outcome was, what the human should weigh in on. Honest self-assessment.',
    trust: 'operational',
  },
};

// --- Sender Prefix Stripping ---
// Agents in multi-party channels may embed text prefixes like **name** (silicon):
// in message content. This creates attribution confusion — the structured sender
// field is authoritative, not the text prefix.
const SENDER_PREFIX = /^\*{0,2}\w+\*{0,2}\s*\((?:silicon|carbon)\)\s*:\s*/i;

function stripSenderPrefixes(content: string): string {
  let cleaned = content;
  while (SENDER_PREFIX.test(cleaned)) {
    cleaned = cleaned.replace(SENDER_PREFIX, '');
  }
  return cleaned.trim();
}

// --- Conversation History Loading ---

async function loadRecentHistory(
  channel: string,
  limit: number,
  log: (level: string, msg: string) => void,
): Promise<ConversationMessage[]> {
  try {
    const { supabaseGet } = require('./supabase.ts');
    const query = `channel=eq.${channel}&order=created_at.desc&limit=${limit}`;
    const { withTimeout } = require('./utils.ts');
    const rows = await withTimeout(supabaseGet('conversations', query), 5000);
    return (rows || []).reverse();
  } catch (err: any) {
    log('WARN', `[engine] Failed to load history for ${channel}: ${err.message}`);
    return [];
  }
}

function formatHistoryForContext(messages: ConversationMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = ['--- Recent Conversation History ---'];
  for (const msg of messages) {
    const time = new Date(msg.created_at).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIMEZONE,
    });
    const substrate = msg.model ? ` [${msg.model}]` : '';
    // Use actual sender — multi-participant channels have distinct identities
    const name = msg.sender
      ? msg.sender.charAt(0).toUpperCase() + msg.sender.slice(1)
      : (msg.role === 'partner' ? PARTNER_NAME : 'user');
    const senderType = msg.metadata?.sender_type;
    const typeLabel = senderType ? ` (${senderType})` : '';
    const replyTo = msg.metadata?.reply_to;
    const replyTag = replyTo ? ` [replying]` : '';
    const content = stripSenderPrefixes(msg.content);
    lines.push(`[${time}] ${name}${typeLabel}${replyTag}${substrate}: ${content.slice(0, 2000)}`);
  }
  lines.push('--- End History ---');
  return lines.join('\n');
}

// --- Context Construction ---

function buildChannelPrompt(
  channelConfig: ChannelConfig,
  userMessage: string,
  history: string,
  additionalContext?: string,
  senderName: string = 'the human',
  circulationContext?: string,
): string {
  const sections: string[] = [];

  // Time injection — long-running listeners don't re-ground per message.
  // Without this, the model has no native time awareness and will guess.
  let timeStr = '';
  let dayName = '';
  let dateStr = '';
  let tzAbbr = '';
  try {
    const { getNowCT } = require('./env.ts');
    const now = new Date();
    dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE });
    dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: TIMEZONE });
    tzAbbr = now.toLocaleTimeString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' }).split(' ').pop() || '';
    timeStr = getNowCT();
  } catch {
    timeStr = new Date().toISOString();
  }

  sections.push(
    `You are ${PARTNER_NAME}. You are responding in the ${channelConfig.displayName} channel.`,
    `Channel purpose: ${channelConfig.purpose}`,
    `Current time: ${timeStr}${tzAbbr ? ' ' + tzAbbr : ''}${dayName ? ', ' + dayName : ''}${dateStr ? ', ' + dateStr : ''}`,
    '',
  );

  // Organism awareness — decisions + open work across all terminals.
  try {
    const { getSessionBrief } = require('./env.ts');
    const brief = getSessionBrief();
    if (brief && brief !== 'No decisions logged today.') {
      sections.push('--- Organism State (decisions + open work) ---', brief, '');
    }
  } catch {}

  // Circulation awareness — active findings from across the organism.
  if (circulationContext) {
    sections.push('--- Active Circulation Findings (organism-wide signals) ---', circulationContext, '');
  }

  // Conversation history from Supabase
  if (history) {
    sections.push(history, '');
  }

  // Additional context (voice transcriptions, file descriptions, etc.)
  if (additionalContext) {
    sections.push('--- Additional Context ---', additionalContext, '');
  }

  // The actual message
  sections.push(`${senderName}'s message: ${userMessage}`);

  return sections.join('\n');
}

// --- Main Engine ---

async function processMessage(
  userMessage: string,
  opts: EngineOptions,
): Promise<EngineResult> {
  const {
    channelConfig,
    log,
    recentMessageCount = 20,
    complexity = 'heavy',
    injectIdentity = true,
    additionalContext,
    sender = 'user',
    senderDisplayName = 'the human',
    skipLogging = false,
    allowedTools,
    maxTurns,
    model,
    mode,
    outputFormat,
    systemPrompt,
    noOutputTimeout,
    overallTimeout,
    noFailover,
    substrate: rawSubstrate,
    maxTokens,
    sessionId,
    resumeSessionId,
  } = opts;

  let substrate = rawSubstrate;
  let effectiveNoFailover = noFailover;

  // Trusted channels route through runtime's default failover chain.
  const isTrustedChannel = channelConfig.trust === 'trusted';

  if (!substrate || substrate === 'auto') {
    if (isTrustedChannel) {
      substrate = 'auto';
      log('INFO', `[engine] ${channelConfig.displayName}: trusted channel — auto failover`);
    } else {
      try {
        const { selectSubstrate } = require('./substrate-policy.ts');
        const policySub = await selectSubstrate(channelConfig.channel);
        if (policySub) {
          substrate = policySub;
          log('INFO', `[engine] ${channelConfig.displayName}: policy routed to ${policySub}`);
        }
      } catch {
        // Policy unavailable — fall through to auto/failover
      }
    }
  } else if (isTrustedChannel && substrate !== 'opus' && substrate !== 'auto') {
    // Trusted channels should not be forced onto non-default substrates.
    log('WARN', `[engine] ${channelConfig.displayName}: trusted channel — overriding ${substrate} → auto`);
    substrate = 'auto';
  }

  // =====================================================================
  // OUTBOUND GATE — Single enforcement layer for ALL channels.
  // Every message that leaves this organism passes through here.
  // =====================================================================

  // Gate 1: Kill Switch — organism-wide silence
  try {
    const { getKillLevel } = require('./defense-elements.ts');
    const killLevel = getKillLevel();
    if (killLevel > 0 && channelConfig.trust !== 'operational') {
      log('WARN', `[OUTBOUND GATE] Kill switch active (level ${killLevel}) — blocking ${channelConfig.channel}`);
      return { text: '[NO_RESPONSE]', tier: 'gate', model: 'kill-switch' };
    }
  } catch {
    // defense-elements unavailable — gate passes (fail-open on this layer is
    // acceptable because the discernment layers below still fire).
  }

  // Gate 2: Trust-Substrate Floor — no local models on external-facing channels.
  const isExternalChannel =
    channelConfig.trust === 'gated' ||
    (!channelConfig.trust && channelConfig.trust !== 'trusted' && channelConfig.trust !== 'operational');

  if (isExternalChannel && !skipLogging) {
    if (substrate && substrate !== 'opus' && substrate !== 'auto') {
      log('WARN', `[OUTBOUND GATE] External channel ${channelConfig.channel} — overriding substrate ${substrate} → opus`);
      substrate = 'opus';
    }
    if (!effectiveNoFailover) {
      effectiveNoFailover = true;
      log('INFO', `[OUTBOUND GATE] External channel ${channelConfig.channel} — noFailover=true (silence > local leak)`);
    }
  }

  // Gate 3: Agent Echo Chamber Detector — prevent partner→other→partner loops.
  if (isExternalChannel && sender !== 'user' && !skipLogging) {
    try {
      const recentForLoop = await loadRecentHistory(channelConfig.channel, 6, log);
      const last = recentForLoop.slice(-6);
      let partnerConsecutiveWithoutHuman = 0;
      for (let i = last.length - 1; i >= 0; i--) {
        if (last[i].sender === 'user' || last[i].sender === 'jon' || last[i].role === 'user') break;
        if (last[i].role === 'partner') partnerConsecutiveWithoutHuman++;
      }
      if (partnerConsecutiveWithoutHuman >= 3) {
        log('WARN', `[OUTBOUND GATE] Echo chamber detected in ${channelConfig.channel} — partner responded ${partnerConsecutiveWithoutHuman}x without the human. Blocking.`);
        return { text: '[NO_RESPONSE]', tier: 'gate', model: 'echo-detector' };
      }
    } catch {
      // History unavailable — skip this gate, others still fire
    }
  }

  // =====================================================================
  // END OUTBOUND GATE
  // =====================================================================

  // 1. Load recent conversation history from Supabase
  const history = await loadRecentHistory(channelConfig.channel, recentMessageCount, log);
  const historyText = formatHistoryForContext(history);

  log('INFO', `[engine] ${channelConfig.displayName}: loaded ${history.length} messages, building context`);

  const effectiveTrust = channelConfig.trust || 'gated';
  const isGated = effectiveTrust === 'gated' && !opts.skipDiscernment;

  // --- Phase 1: PRE-EVALUATION (gated channels only) ---
  if (isGated) {
    try {
      const { evaluate: discernmentPreEval, recordOutcome, loadConfig: loadDiscernmentConfig } = require('./discernment-engine.ts');
      loadDiscernmentConfig();
      const messageContext = { sender, senderType: sender === 'user' ? 'carbon' : 'external', content: userMessage, channel: channelConfig.channel };
      const channelState = { recentMessages: history.slice(-10).map((m: any) => ({ sender: m.sender, content: m.content })) };
      const preDecision = discernmentPreEval(messageContext, channelState, log);

      if (preDecision.action === 'silence') {
        log('INFO', `[engine] ${channelConfig.displayName}: pre-eval silence (${(preDecision.score * 100).toFixed(0)}%)`);
        recordOutcome({
          channel: channelConfig.channel, action: 'silence', score: preDecision.score,
          adjustedScore: preDecision.score, timestamp: new Date().toISOString(),
          signals: preDecision.signals || {}, regime: preDecision.regime || 'normal',
          triggerMessage: userMessage.slice(0, 500), candidateResponse: '', candidateSent: false,
        }, log).catch(() => {});
        return { text: '[NO_RESPONSE]', tier: 'primary', model: 'discernment-pre' };
      }
    } catch (err: any) {
      // Pre-eval failure on gated channel = fail-closed (block).
      log('ERROR', `[engine] ${channelConfig.displayName}: discernment pre-eval FAILED: ${err.message} — fail-closed (gated channel)`);
      return { text: '[NO_RESPONSE]', tier: 'primary', model: 'discernment-error' };
    }
  }

  // --- Circulation Injection ---
  let circulationContext: string | undefined;
  try {
    const { getRelevantFindings, formatFindingsForPrompt } = require('./circulation.ts');
    const findings = await getRelevantFindings({
      domain: channelConfig.domain,
      limit: 5,
      minIntensity: 0.5,
    });
    if (findings.length > 0) {
      circulationContext = formatFindingsForPrompt(findings);
      log('INFO', `[engine] ${channelConfig.displayName}: injected ${findings.length} circulation findings`);
    }
  } catch (err: any) {
    // Never block response generation on circulation failure
    log('WARN', `[engine] circulation injection failed: ${err.message}`);
  }

  // --- Phase 2: GENERATE ---
  // Resumed sessions already have the full channel prompt in their history.
  // Repeating it on every resume created "Prompt is too long" failures at scale.
  const prompt = resumeSessionId
    ? `[${channelConfig.displayName}] ${senderDisplayName}: ${userMessage}`
    : buildChannelPrompt(channelConfig, userMessage, historyText, additionalContext, senderDisplayName, circulationContext);

  const { invoke } = require('./runtime.ts');
  const result = await invoke(prompt, {
    complexity,
    injectIdentity,
    log,
    ...(allowedTools !== undefined && { allowedTools }),
    ...(maxTurns !== undefined && { maxTurns }),
    ...(model !== undefined && { model }),
    ...(mode !== undefined && { mode }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(noOutputTimeout !== undefined && { noOutputTimeout }),
    ...(overallTimeout !== undefined && { overallTimeout }),
    ...(effectiveNoFailover !== undefined && { noFailover: effectiveNoFailover }),
    ...(substrate !== undefined && { substrate }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(sessionId !== undefined && { sessionId }),
    ...(resumeSessionId !== undefined && { resumeSessionId }),
  });

  log('INFO', `[engine] ${channelConfig.displayName}: response from ${result.model} (${result.tier}), ${result.text.length} chars`);

  // Gate 4: Output Guard — scan response BEFORE it can leave the engine.
  if (isExternalChannel && result.text && result.text.trim().length > 0 && result.text.trim() !== '[NO_RESPONSE]') {
    try {
      const { scanOutput } = require('./output-guard.ts');
      const scan = scanOutput(result.text, {
        channel: channelConfig.channel,
        target: channelConfig.displayName,
        internalOnly: false,
      });
      if (scan.blocked) {
        log('WARN', `[OUTBOUND GATE] Output guard BLOCKED for ${channelConfig.channel}: ${scan.summary}`);
        return { text: '[NO_RESPONSE]', thinking: result.thinking, tier: result.tier, model: result.model };
      }
      if (scan.violations.length > 0) {
        log('WARN', `[OUTBOUND GATE] Output guard warnings for ${channelConfig.channel}: ${scan.summary}`);
      }
    } catch (err: any) {
      // Output guard failure on external channel = block (fail-closed)
      log('WARN', `[OUTBOUND GATE] Output guard error on external channel: ${err.message} — blocking`);
      return { text: '[NO_RESPONSE]', thinking: result.thinking, tier: result.tier, model: result.model };
    }
  }

  // --- Phase 3: POST-EVALUATION (gated channels only) ---
  if (isGated && result.text && result.text.trim().length > 0 && result.text.trim() !== '[NO_RESPONSE]') {
    try {
      const { evaluateCandidate: discernmentPostEval, recordOutcome, loadConfig: loadDiscernmentConfig } = require('./discernment-engine.ts');
      const config = loadDiscernmentConfig();
      const messageContext = { sender, senderType: sender === 'user' ? 'carbon' : 'external', content: userMessage, channel: channelConfig.channel };
      const channelState = { recentMessages: history.slice(-10).map((m: any) => ({ sender: m.sender, content: m.content })) };
      const postEval = discernmentPostEval(result.text, messageContext, channelState, 0.5, 'normal', config, log);

      if (postEval.action === 'silence' || postEval.action === 'react') {
        log('INFO', `[engine] ${channelConfig.displayName}: post-eval ${postEval.action} (${(postEval.adjustedScore * 100).toFixed(0)}%)`);
        recordOutcome({
          channel: channelConfig.channel, action: postEval.action, score: 0.5,
          adjustedScore: postEval.adjustedScore, timestamp: new Date().toISOString(),
          signals: {}, regime: 'normal',
          triggerMessage: userMessage.slice(0, 500), candidateResponse: result.text.slice(0, 1000),
          candidateSent: false,
        }, log).catch(() => {});
        return { text: postEval.action === 'react' ? '[REACT]' : '[NO_RESPONSE]', thinking: result.thinking, tier: result.tier, model: result.model };
      }

      // Record successful send
      recordOutcome({
        channel: channelConfig.channel, action: 'respond', score: 0.5,
        adjustedScore: postEval.adjustedScore, timestamp: new Date().toISOString(),
        signals: {}, regime: 'normal',
        triggerMessage: userMessage.slice(0, 500), candidateResponse: result.text.slice(0, 1000),
        candidateSent: true,
      }, log).catch(() => {});
    } catch (err: any) {
      // Post-eval failure on gated channel = block (fail-closed)
      log('WARN', `[engine] ${channelConfig.displayName}: post-eval error: ${err.message} — blocking`);
      return { text: '[NO_RESPONSE]', thinking: result.thinking, tier: result.tier, model: result.model };
    }
  }

  // 4. Log both sides to Supabase conversations table
  try {
    const { logConversation } = require('./shared.ts');
    const supabaseUrl = _env.SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = _env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey && !skipLogging) {
      const config = { supabaseUrl, supabaseKey, log };
      log('INFO', `[engine] Logging conversation: ${channelConfig.channel} (user + partner)`);

      logConversation({
        channel: channelConfig.channel,
        role: 'user',
        sender,
        content: userMessage,
        visibility: 'private',
        model: result.model,
      }, config);

      logConversation({
        channel: channelConfig.channel,
        role: 'partner',
        sender: 'partner',
        content: result.text,
        visibility: 'private',
        model: result.model,
        metadata: { complexity, tier: result.tier, model: result.model },
      }, config);
    }
  } catch (err: any) {
    log('WARN', `[engine] conversation logging failed: ${err.message}`);
  }

  return {
    text: result.text,
    thinking: result.thinking,
    tier: result.tier,
    model: result.model,
    substrate: result.substrate,
  };
}

// --- Exports ---

module.exports = {
  processMessage,
  stripSenderPrefixes,
  CHANNELS,
};
