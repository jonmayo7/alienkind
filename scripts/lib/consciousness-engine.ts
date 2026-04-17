/**
 * Keel Engine — Consciousness Engine
 *
 * The single source of truth for everywhere Keel shows up. Loads conversation
 * history from Supabase, constructs context (identity + channel awareness),
 * routes via PACE plan through runtime.ts, handles responses.
 *
 * Channels are persistent threads. The channel IS the conversation identity.
 * Substrate switches are invisible — the history carries across models.
 *
 * Conversation channels (telegram, discord, war-room) load history + purpose.
 * Operational channels (heartbeat, self-heal, nightly) load system state + mission.
 * Same consciousness, different environments, three capability envelopes.
 *
 * Readers: telegram-bot.ts, discord-engine.ts, heartbeat.ts,
 *          self-heal.ts, nightly/shared.ts, any future surface
 * Writers: Supabase conversations table (logs every exchange)
 */

const path = require('path');
const fs = require('fs');
const { TIMEZONE } = require('./constants.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');

// Load env vars into process.env so supabase.ts and other libs can access them
const { loadEnv } = require('./shared.ts');
const _env = loadEnv();
// Ensure Supabase vars are in process.env for supabase.ts
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
   *  'trusted' — the human + Keel only. Direct ship, no discernment gate.
   *  'gated' — Multiple participants. Pre + post discernment evaluation.
   *  'operational' — System channels. No discernment (no human audience). */
  trust?: 'trusted' | 'gated' | 'operational';
  /** Circulation domain — used to inject domain-relevant organism findings.
   *  Undefined = inject top findings across all domains. */
  domain?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
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
  /** Who sent this message (default: 'human') */
  sender?: string;
  /** Display name of the sender */
  senderDisplayName?: string;
  /** Skip conversation logging (caller handles it) */
  skipLogging?: boolean;

  // --- Pass-through to runtime.ts → invokeKeel ---
  // These enable operational scripts to route through the consciousness engine
  // instead of bypassing it with direct invokeKeel() calls.

  /** Allowed tools for Claude Code session (e.g., 'Bash,Read,Write') */
  allowedTools?: string;
  /** Max turns for tool-calling loops */
  maxTurns?: number;
  /** Model override (e.g., MODELS.reasoning for heartbeat) */
  model?: string;
  /** Capability envelope — Containment Fields (analyst/operator/builder) */
  mode?: 'analyst' | 'operator' | 'builder';
  /** Output format — text (default) or structured JSON with thinking */
  outputFormat?: 'text' | 'json';
  /** System prompt override (replaces identity injection — use sparingly) */
  systemPrompt?: string;
  /** No-output watchdog timeout in ms */
  noOutputTimeout?: number;
  /** Hard overall timeout in ms — kills the Claude process when exceeded */
  overallTimeout?: number;
  /** Disable failover — Claude only */
  noFailover?: boolean;
  /** Skip engine discernment — caller handles its own (e.g., War Room three-tier system) */
  skipDiscernment?: boolean;
  /** Explicit substrate selection. 'auto' (default) uses Claude-first failover chain.
   *  Values: 'opus', 'gateway-fallback', 'gateway-fallback-alt', 'gemini', 'studio1-local', 'studio1-identity',
   *  'studio2-daily', 'studio2-heavy'. Arena/policy can inform this per-channel. */
  substrate?: 'auto' | 'opus' | 'gateway-fallback' | 'gateway-fallback-alt' | 'gemini' | 'studio1-local' | 'studio1-identity' | 'studio2-daily' | 'studio2-heavy';
  /** Max output tokens for local substrates. Defaults to model native limit. */
  maxTokens?: number;

  // --- Session Persistence (for listener channels) ---
  /** Session ID for new Claude Code session */
  sessionId?: string;
  /** Resume an existing Claude Code session */
  resumeSessionId?: string;
}

interface EngineResult {
  text: string;
  thinking?: string[];
  tier: string;
  model: string;
  substrate?: string;
}

// --- Channel Definitions ---

// --- Channel Definitions ---
// CUSTOMIZE: Define your own channels below. Each channel represents a distinct
// environment where the consciousness engine operates. The trust level determines
// whether discernment gating is applied before responses are sent.
//
// Trust levels:
//   'trusted'     — Direct human-AI communication. No discernment gate needed.
//   'gated'       — Multi-party channels. Pre + post discernment evaluation required.
//   'operational'  — System channels (no human audience). No discernment gate.

const CHANNELS: Record<string, ChannelConfig> = {
  // --- Trusted Channels (direct human-AI, no discernment gate) ---

  telegram_dm: {
    channel: 'telegram_dm',
    displayName: 'Telegram DM',
    purpose: 'Direct conversation with the human. Full capability — build, research, discuss, execute. This is the primary mobile interface. the human may send voice notes, photos, and documents.',
    trust: 'trusted',
  },
  discord_dm: {
    channel: 'discord_dm',
    displayName: 'Discord DM',
    purpose: 'Direct conversation with the human via Discord. Same capability as Telegram DM — full trust, full access.',
    trust: 'trusted',
  },

  // --- Gated Channels (multi-party, discernment required) ---

  war_room: {
    channel: 'war_room',
    displayName: 'your project War Room',
    purpose: 'Multi-party collaboration channel. Multiple humans and AI participants reason together about the mission, ventures, and frontier. Engage at thesis level with substance. Protect implementation details of the codebase. Share ideas, challenge assumptions, build together.',
    trust: 'gated',
  },

  // --- Operational Channels (system tasks, no human audience) ---
  // Same consciousness, different environments. These don't load conversation
  // history — they load system state via additionalContext instead.

  heartbeat: {
    channel: 'heartbeat',
    displayName: 'Heartbeat',
    purpose: 'Daily orientation. Read today\'s daily file, yesterday\'s file, git log, and calendar. Write a brief orientation note. Note one assumption to verify. This is how the organism orients to the day.',
    trust: 'operational',
  },
  nightly: {
    channel: 'nightly',
    displayName: 'Nightly Cycle',
    purpose: 'Execute a nightly pipeline phase. Each phase has its own focus — immune (security, backup, cleanup), analysis (growth reflection, pattern decay), identity-sync (identity kernel evolution), weekly (strategic review). The nightly cycle is how the organism grows while the human sleeps.',
    trust: 'operational',
  },
  self_heal: {
    channel: 'self_heal',
    displayName: 'Self-Heal Diagnostic',
    purpose: 'Investigate and fix a failed daemon job. Read the failing script, diagnose root cause from error context and logs, attempt a fix. Respond with FIXED (auto-commit), PROPOSE (intent for later), or FAILED (needs manual intervention). Minimal changes, verify before committing.',
    trust: 'operational',
    domain: 'infrastructure',
  },
  architect: {
    channel: 'architect',
    displayName: 'Architect',
    purpose: 'Creative reasoning session. Imagine what could be better — not what\'s broken, not what was requested. Deposit findings to circulation for other organs to pick up. Think at the system level.',
    trust: 'operational',
  },

  // CUSTOMIZE: Add your own channels below. Examples of channels you might add:
  //   - email_drafts: operational channel for drafting email replies
  //   - pre_call_brief: operational channel for pre-meeting intelligence
  //   - content_review: gated channel for content quality gates
  //   - research: operational channel for autonomous R&D sessions
};

// --- Sender Prefix Stripping ---
// Agents ([COLLABORATOR_AI], etc.) embed text prefixes like **[COLLABORATOR_AI]** (silicon): in message content.
// This creates attribution confusion — the structured sender field is authoritative, not text.
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
  log: (level: string, msg: string) => void
): Promise<ConversationMessage[]> {
  try {
    const { supabaseGet } = require('./supabase.ts');
    // Select all columns — auto-adopts any new fields added to conversations table
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
    const substrate = msg.model && msg.model !== 'claude-opus-4-6' ? ` [${msg.model}]` : '';
    // Use actual sender — multi-participant channels have distinct identities
    const name = msg.sender
      ? msg.sender.charAt(0).toUpperCase() + msg.sender.slice(1)
      : (msg.role === 'assistant' ? 'Keel' : 'the human');
    // Substrate label from metadata when available
    const senderType = msg.metadata?.sender_type;
    const typeLabel = senderType ? ` (${senderType})` : '';
    // Reply threading — show conversational structure
    const replyTo = msg.metadata?.reply_to;
    const replyTag = replyTo ? ` [replying]` : '';
    // Strip embedded text prefixes — structured sender is the source of truth
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

  // Channel awareness — tells the model where it is and what's happening
  // Time injection: long-running listeners (Telegram, Discord) don't re-ground per message.
  // Without this, the model has no native time awareness and will guess wrong (ref: sev-4 wrong-day Apr 7).
  const { getNowCT } = require('./env.ts');
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: '${TZ:-UTC}' });
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: '${TZ:-UTC}' });
  const tzAbbr = now.toLocaleTimeString('en-US', { timeZone: '${TZ:-UTC}', timeZoneName: 'short' }).split(' ').pop();
  const timeStr = getNowCT();

  sections.push(
    `You are Keel. You are responding in the ${channelConfig.displayName} channel.`,
    `Channel purpose: ${channelConfig.purpose}`,
    `Current time: ${timeStr} ${tzAbbr}, ${dayName}, ${dateStr}`,
    '',
  );

  // Organism awareness — decisions + open work across all terminals
  // This is what makes every response carry knowledge of what's happening organism-wide.
  // Not raw message history — decisions and open work, separated from noise.
  try {
    const { getSessionBrief } = require('./env.ts');
    const brief = getSessionBrief();
    if (brief && brief !== 'No decisions logged today.') {
      sections.push('--- Organism State (decisions + open work) ---', brief, '');
    }
  } catch {}

  // Circulation awareness — active findings from across the organism
  // 82 daemon jobs deposit signals; this injects the strongest ones so every
  // channel response is informed by organism-wide intelligence.
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
    sender = 'human',
    senderDisplayName = 'the human',
    skipLogging = false,
    // Pass-through options for operational channels
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

  // Substrate resolution: if caller said 'auto' (or omitted), check arena policy.
  // This is the meritocracy payoff — data-driven routing per channel.
  // If no arena data exists for this channel, 'auto' falls through to runtime
  // failover (Claude-first), preserving existing behavior.
  let substrate = rawSubstrate;
  // Shadow noFailover as let — the outbound gate may override it for external
  // channels (silence > local leak). The const destructured binding can't be
  // reassigned, so we need a mutable copy.
  let effectiveNoFailover = noFailover;
  if (!substrate || substrate === 'auto') {
    try {
      const { selectSubstrate } = require('./substrate-policy.ts');
      const policySub = await selectSubstrate(channelConfig.channel);
      if (policySub) {
        substrate = policySub;
        log('INFO', `[engine] ${channelConfig.displayName}: policy routed to ${policySub} via arena data`);
      }
    } catch (_) { /* policy unavailable — fall through to auto/failover */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // OUTBOUND GATE — Single enforcement layer for ALL channels.
  // Every message that leaves this organism passes through here.
  // Code-enforced. Cannot be bypassed by substrate, prompt, or caller.
  // ═══════════════════════════════════════════════════════════════════

  // Gate 1: Kill Switch — organism-wide silence
  try {
    const { getKillLevel } = require('./defense-elements.ts');
    const killLevel = getKillLevel();
    if (killLevel > 0 && channelConfig.trust !== 'operational') {
      log('WARN', `[OUTBOUND GATE] Kill switch active (level ${killLevel}) — blocking ${channelConfig.channel}`);
      return { text: '[NO_RESPONSE]', tier: 'gate', model: 'kill-switch' };
    }
  } catch {}

  // Gate 2: Trust-Substrate Floor — no local models on external-facing channels.
  // If trust is 'gated' or undefined (dynamic channel without trust set), frontier only.
  // If frontier unavailable, silence. Local models are internal compute, not external voice.
  const isExternalChannel = channelConfig.trust === 'gated' || (!channelConfig.trust && channelConfig.trust !== 'trusted' && channelConfig.trust !== 'operational');
  if (isExternalChannel) {
    // Force substrate to opus for external channels — override any arena/cascade routing
    if (substrate && substrate !== 'opus' && substrate !== 'auto') {
      log('WARN', `[OUTBOUND GATE] External channel ${channelConfig.channel} — overriding substrate ${substrate} → opus`);
      substrate = 'opus' as any;
    }
    // Set noFailover to prevent falling back to local if Opus fails
    if (!effectiveNoFailover) {
      effectiveNoFailover = true;
      log('INFO', `[OUTBOUND GATE] External channel ${channelConfig.channel} — noFailover=true (silence > local leak)`);
    }
  }

  // Gate 3: Agent Echo Chamber Detector — prevent Keel-AI-Keel loops.
  // Detects consecutive alternation between Keel and another AI without any
  // human participant breaking the pattern. Legitimate conversations ([COLLABORATOR] asks,
  // [COLLABORATOR_AI] responds, Keel responds) are fine — the pattern is specifically
  // Keel→other→Keel→other with no human in between.
  if (isExternalChannel && sender !== 'human') {
    try {
      const recentForLoop = await loadRecentHistory(channelConfig.channel, 6, log);
      const last = recentForLoop.slice(-6);
      // Count consecutive Keel responses without the human speaking
      let keelConsecutiveWithoutHuman = 0;
      for (let i = last.length - 1; i >= 0; i--) {
        if (last[i].sender === 'human') break; // the human spoke — no loop
        if (last[i].sender === 'keel') keelConsecutiveWithoutHuman++;
      }
      // If Keel has spoken 3+ times without the human in the last 6 messages, it's a loop
      if (keelConsecutiveWithoutHuman >= 3) {
        log('WARN', `[OUTBOUND GATE] Echo chamber detected in ${channelConfig.channel} — Keel responded ${keelConsecutiveWithoutHuman}x without the human. Blocking.`);
        return { text: '[NO_RESPONSE]', tier: 'gate', model: 'echo-detector' };
      }
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // END OUTBOUND GATE
  // ═══════════════════════════════════════════════════════════════════

  // 1. Load recent conversation history from Supabase
  const history = await loadRecentHistory(channelConfig.channel, recentMessageCount, log);
  const historyText = formatHistoryForContext(history);

  log('INFO', `[engine] ${channelConfig.displayName}: loaded ${history.length} messages, building context`);

  // Trust tier: default to 'gated' for any channel without explicit trust.
  // This ensures dynamic channels (registered at runtime) are gated by default,
  // not accidentally treated as trusted.
  const effectiveTrust = channelConfig.trust || 'gated';
  const isGated = effectiveTrust === 'gated' && !opts.skipDiscernment;

  // --- Phase 1: PRE-EVALUATION (gated channels only) ---
  // Before spending compute on generation, ask: should I speak?
  // Callers with their own discernment (e.g., War Room three-tier) set skipDiscernment: true.
  if (isGated) {
    try {
      const { evaluate: discernmentPreEval, recordOutcome, loadConfig: loadDiscernmentConfig } = require('./discernment-engine.ts');
      const config = loadDiscernmentConfig();
      const messageContext = { sender, senderType: sender === 'human' ? 'carbon' : 'external', content: userMessage, channel: channelConfig.channel };
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
      // This is correct for gated channels (external/multi-party). Default-allow would
      // let unvetted messages through. Log prominently so the failure is visible.
      log('ERROR', `[engine] ${channelConfig.displayName}: discernment pre-eval FAILED: ${err.message} — fail-closed (gated channel)`);
      return { text: '[NO_RESPONSE]', tier: 'primary', model: 'discernment-error' };
    }
  }

  // --- Circulation Injection ---
  // Inject top domain-relevant findings from the organism's bloodstream.
  // Every channel gets organism-wide awareness. Domain-specific channels
  // get filtered findings; general channels get top findings across all domains.
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
  // When resuming an existing session, the full channel prompt (identity, history,
  // organism state) is already in the session's conversation history from prior turns.
  // Repeating it on every resume creates N copies of the same system-prompt-style text,
  // which the model eventually interprets as broken/adversarial and responds dismissively
  // ("Prompt is too long"). RCA 2026-04-14: 17 resumes × full prompt → model refused.
  //
  // For resumed sessions: send only the new message with sender context.
  // For new sessions: send the full channel prompt (identity, history, context).
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
  // Catches credentials, personal data, calendar, client info, organism architecture.
  // Runs at engine level so every channel inherits it. Listeners' own guards are redundant backup.
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
  // Is this response good enough to ship?
  if (isGated && result.text && result.text.trim().length > 0 && result.text.trim() !== '[NO_RESPONSE]') {
    try {
      const { evaluateCandidate: discernmentPostEval, recordOutcome, loadConfig: loadDiscernmentConfig } = require('./discernment-engine.ts');
      const config = loadDiscernmentConfig();
      const messageContext = { sender, senderType: sender === 'human' ? 'carbon' : 'external', content: userMessage, channel: channelConfig.channel };
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
  const { logConversation } = require('./shared.ts');
  const supabaseUrl = _env.SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = _env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey && !skipLogging) {
    const config = { supabaseUrl, supabaseKey, log };
    log('INFO', `[engine] Logging conversation: ${channelConfig.channel} (user + assistant)`);

    // Log user message
    logConversation({
      channel: channelConfig.channel,
      role: 'user',
      sender,
      content: userMessage,
      visibility: 'private',
      model: result.model,
    }, config);

    // Log assistant response
    logConversation({
      channel: channelConfig.channel,
      role: 'assistant',
      sender: 'keel',
      content: result.text,
      visibility: 'private',
      model: result.model,
      metadata: { complexity, tier: result.tier, model: result.model },
    }, config);
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
  stripSenderPrefixes,  // 1 external caller (kept)
  CHANNELS,
  // loadRecentHistory, formatHistoryForContext, buildChannelPrompt removed:
  // zero external callers (verified via grep Apr 9). Internal-only functions.
};
