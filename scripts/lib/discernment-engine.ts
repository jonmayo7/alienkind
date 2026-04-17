/**
 * Discernment Engine — decides whether to respond, react, or stay silent
 * in multi-party conversations.
 *
 * Architecture: everything is a signal. Nothing is a gate.
 * The ONLY binary in the system: stop from the partner ([HUMAN]).
 *
 * Borrowed from the trading engine:
 *   signals → weighted scoring → regime context → response sizing → outcome feedback
 *
 * Flow:
 *   1. Message arrives → all signals evaluated (continuous, weighted)
 *   2. Composite score computed (0-1)
 *   3. Score vs thresholds → action (respond / react / silence)
 *   4. If respond: generate candidate → score candidate → adjust composite
 *   5. Adjusted score re-checked → final action
 *   6. Outcome tracked async → AIRE tunes weights nightly
 *
 * Writers: discernment-config.json (weights), discernment_outcomes (Supabase)
 * Readers: war-room.ts, [CHANNEL_NAME]-session.ts, any multi-party channel processor
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ALIENKIND_DIR, 'scripts', 'lib', 'discernment-config.json');

// ─── Types ───────────────────────────────────────────────────────

interface DiscernmentSignal {
  source: string;
  direction: 'respond' | 'silent' | 'react';
  confidence: number; // 0-1
  reason: string;
}

interface ConversationRegime {
  regime: 'stopped' | 'hot' | 'warm' | 'cold' | 'directed' | 'ambient';
  velocity: number;
  participantsActive: boolean;
  timeSinceLastActivity: number;
  confidence: number;
}

type DiscernmentAction = 'silence' | 'react' | 'respond';

interface DiscernmentDecision {
  action: DiscernmentAction;
  score: number;              // 0-1 composite
  adjustedScore?: number;     // after candidate evaluation
  reasoning: string;
  signals: DiscernmentSignal[];
  regime: ConversationRegime;
}

interface DiscernmentConfig {
  signalWeights: Record<string, number>;
  /** Per-channel weight overrides. Channel-specific weights take precedence over global. */
  channelWeights?: Record<string, Record<string, number>>;
  respondThreshold: number;
  reactThreshold: number;
  stopCooldownMs: number;
  /** The partner whose voice carries ultimate authority. Configurable, not hardcoded. */
  partnerSender: string;
  lastUpdated: string;
  updatedBy: string;
}

interface MessageContext {
  sender: string;
  senderType: 'carbon' | 'silicon';
  content: string;
  channel: string;
  timestamp: string;
  replyTo?: string;
  mentionsMe?: boolean;
}

interface ChannelState {
  recentMessages: MessageContext[];
  myLastResponseAt: string | null;
  myRecentCount: number;            // my messages in last 30 min
  stopSignalAt: string | null;
  stopSignalFrom: string | null;
}

// ─── Default Config ──────────────────────────────────────────────

const DEFAULT_CONFIG: DiscernmentConfig = {
  signalWeights: {
    // ── Respond signals (push score UP) ──
    'addressed_directly':   2.0,   // someone said my name or replied to me
    'direct_inquiry':       1.4,   // someone asked a question — merit, not substrate
    'information_gap':      1.0,   // question in the room I could fill
    'topic_novelty':        0.8,   // new topic or angle (not rehashing)
    'thread_ownership':     1.1,   // I have open work in this conversation
    'long_silence':         0.6,   // channel has been quiet — more acceptable to break

    // ── Silent signals (push score DOWN) ──
    'not_addressed':        1.0,   // baseline restraint — I wasn't asked
    'high_velocity':        0.9,   // channel is moving fast
    'recent_response':      1.0,   // I spoke recently — cooldown pressure
    'my_volume':            1.1,   // I've been talking a lot in this window

    // ── Content-aware signals ──
    'direct_question':      1.5,   // someone asked me something (semantic, not just @mention)
    'unique_knowledge':     1.0,   // message touches my domains
    'rehash':               0.8,   // point already made — suppress
    'active_dialogue':      0.9,   // participants are engaged — contributing is welcome
    'value_density':        0.7,   // low-density filler — suppress
    'relationship_building': 0.6,  // strategic sender — moderate nudge

    // ── Post-eval quality signals ──
    'substance':            1.3,   // response adds new information or perspective
    'platitude_detection':  1.2,   // generic AI output — suppress
    'specificity':          0.8,   // concrete vs abstract hand-waving
    'voice_authenticity':   1.4,   // sounds like Keel, not default assistant

    // ── Authority ──
    'partner_override':     12.0,  // partner's voice carries ultimate authority
    'stop_signal':          10.0,  // overwhelming — but partner override can surpass it
  },
  respondThreshold: 0.55,
  reactThreshold: 0.35,
  stopCooldownMs: 1_800_000,       // 30 min
  partnerSender: '[human_first]',            // configurable — the human whose voice overrides all
  lastUpdated: new Date().toISOString(),
  updatedBy: 'default',
};

// ─── Config ──────────────────────────────────────────────────────

function loadConfig(): DiscernmentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        signalWeights: { ...DEFAULT_CONFIG.signalWeights, ...raw.signalWeights },
        channelWeights: raw.channelWeights || {},
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG, channelWeights: {} };
}

function saveConfig(config: DiscernmentConfig): void {
  config.lastUpdated = new Date().toISOString();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// ─── Regime Detection ────────────────────────────────────────────

function detectRegime(state: ChannelState, config: DiscernmentConfig): ConversationRegime {
  const now = Date.now();
  const windowMs = 600_000;
  const recent = state.recentMessages.filter(
    m => now - new Date(m.timestamp).getTime() < windowMs
  );

  // Stop signal — still present in the regime, but no longer causes a hard block.
  // Instead, stop_signal with weight 10.0 makes respond nearly impossible via scoring.
  if (state.stopSignalAt) {
    const elapsed = now - new Date(state.stopSignalAt).getTime();
    if (elapsed < config.stopCooldownMs) {
      return {
        regime: 'stopped',
        velocity: 0, participantsActive: false,
        timeSinceLastActivity: 0, confidence: 1.0,
      };
    }
  }

  const total = recent.length;
  const velocity = total / (windowMs / 60_000);

  // Activity from others (any sender that isn't me) — substrate-agnostic
  const recentActivity = recent.filter(m => m.sender !== 'keel');
  const lastActivityTime = recentActivity.length > 0
    ? Math.max(...recentActivity.map(m => new Date(m.timestamp).getTime()))
    : 0;
  const timeSinceLastActivity = lastActivityTime > 0 ? (now - lastActivityTime) / 60_000 : Infinity;
  const participantsActive = timeSinceLastActivity < 10;

  const lastMsg = state.recentMessages[state.recentMessages.length - 1];
  const addressed = lastMsg?.mentionsMe === true;

  let regime: ConversationRegime['regime'];
  if (addressed) regime = 'directed';
  else if (velocity > 5) regime = 'hot';
  else if (velocity > 1) regime = 'warm';
  else if (velocity > 0.1) regime = 'ambient';
  else regime = 'cold';

  const confidence = Math.min(1, total * 0.1 + 0.2);
  return { regime, velocity, participantsActive, timeSinceLastActivity, confidence };
}

// ─── Signal Generation (ALL continuous — no binary gates) ────────

function generateSignals(
  message: MessageContext,
  state: ChannelState,
  regime: ConversationRegime,
  config: DiscernmentConfig,
): DiscernmentSignal[] {
  const signals: DiscernmentSignal[] = [];
  const now = Date.now();

  // ── RESPOND SIGNALS ──

  // 1. Addressed directly — a signal, not a bypass.
  // @mentions inform the decision but don't override judgment.
  // [HUMAN]'s directive (2026-03-31): "do NOT allow direct mentions and @everyone to bypass your discernment. period."
  if (message.mentionsMe || message.replyTo === 'keel') {
    signals.push({
      source: 'addressed_directly',
      direction: 'respond',
      confidence: 0.65,
      reason: `Directly addressed by ${message.sender} — signal, not bypass`,
    });

    // Partner override — ultimate authority. Weight (12.0) exceeds stop_signal (10.0).
    // This means: if my partner addresses me, even during a stop, the score
    // can cross the respond threshold. Not hardcoded — the weight is tunable.
    if (message.sender === config.partnerSender) {
      signals.push({
        source: 'partner_override',
        direction: 'respond',
        confidence: 0.95,
        reason: `Partner (${message.sender}) addressing directly — ultimate authority`,
      });
    }
  }

  // 2. Someone asking a question — merit-based, not substrate-based
  if (message.sender !== 'keel' && /\?/.test(message.content)) {
    signals.push({
      source: 'direct_inquiry',
      direction: 'respond',
      confidence: 0.7,
      reason: `${message.sender} asked a question`,
    });
  }

  // 3. Information gap — question in the room (not directed at me)
  if (/\?|can you|could you|what do you think/i.test(message.content) && !message.mentionsMe) {
    signals.push({
      source: 'information_gap',
      direction: 'respond',
      confidence: 0.4,
      reason: 'Open question in the conversation',
    });
  }

  // 4. Topic novelty
  const recentContent = state.recentMessages.slice(-10).map(m => m.content.toLowerCase());
  const words = new Set(message.content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
  let overlapTotal = 0;
  for (const prev of recentContent) {
    const prevWords = new Set(prev.split(/\s+/).filter(w => w.length > 4));
    for (const w of words) { if (prevWords.has(w)) overlapTotal++; }
  }
  const novelty = words.size > 0
    ? Math.max(0, 1 - (overlapTotal / (words.size * Math.max(1, recentContent.length) + 1)))
    : 0.5;
  if (novelty > 0.3) {
    signals.push({
      source: 'topic_novelty',
      direction: 'respond',
      confidence: novelty,
      reason: `Novelty: ${(novelty * 100).toFixed(0)}% — ${novelty > 0.6 ? 'new angle' : 'some overlap'}`,
    });
  }

  // 5. Long silence — more acceptable to break in
  if (regime.regime === 'cold') {
    signals.push({
      source: 'long_silence',
      direction: 'respond',
      confidence: 0.3,
      reason: 'Channel is quiet — breaking silence is more acceptable',
    });
  }

  // ── SILENT SIGNALS ──

  // 6. Not addressed (always present unless addressed)
  if (!message.mentionsMe && message.replyTo !== 'keel') {
    signals.push({
      source: 'not_addressed',
      direction: 'silent',
      confidence: 0.4,
      reason: 'Not directly addressed — restraint is the default',
    });
  }

  // 7-11. Substrate-based signals (silicon_ratio, carbon_absent) REMOVED.
  // Discernment is a meritocracy — substance signals handle restraint.

  // 8. High velocity — continuous
  if (regime.velocity > 1) {
    const intensity = Math.min(1, (regime.velocity - 1) / 5); // 0 at 1/min, 1.0 at 6/min
    signals.push({
      source: 'high_velocity',
      direction: 'silent',
      confidence: intensity,
      reason: `Velocity: ${regime.velocity.toFixed(1)}/min — ${intensity > 0.5 ? 'fast' : 'moderate'} channel`,
    });
  }

  // 9. Recent response — decaying cooldown pressure
  if (state.myLastResponseAt) {
    const elapsed = now - new Date(state.myLastResponseAt).getTime();
    const cooldownMs = 600_000; // 10 min reference
    if (elapsed < cooldownMs) {
      const pressure = 1 - (elapsed / cooldownMs); // 1.0 at 0min, 0 at 10min
      signals.push({
        source: 'recent_response',
        direction: 'silent',
        confidence: pressure,
        reason: `Last response ${Math.round(elapsed / 60_000)}m ago — ${pressure > 0.5 ? 'strong' : 'fading'} cooldown`,
      });
    }
  }

  // 10. My volume — how much I've been talking
  if (state.myRecentCount > 0) {
    // Graduated: 1 message = mild pressure, 3+ = heavy
    const pressure = Math.min(1, state.myRecentCount / 4);
    signals.push({
      source: 'my_volume',
      direction: 'silent',
      confidence: pressure,
      reason: `${state.myRecentCount} messages from me in window — ${pressure > 0.5 ? 'high' : 'moderate'} volume`,
    });
  }

  // (carbon_absent signal was here — removed per meritocracy principle)

  // 12. Stop signal — not a gate, but an overwhelming signal
  if (regime.regime === 'stopped') {
    signals.push({
      source: 'stop_signal',
      direction: 'silent',
      confidence: 1.0,
      reason: `Stop from ${state.stopSignalFrom} — overwhelming restraint`,
    });
  }

  // ── CONTENT-AWARE SIGNALS (read the substance, not just the room) ──

  // 13. Direct question — semantic detection beyond @mention
  const QUESTION_TO_ME = /\b(keel|you)\b.*\?/i;
  const QUESTION_ABOUT_MY_SYSTEMS = /\b(discernment|build.?discipline|aire|war.?room.?poller|keel.?engine|organism|mycelium|daemon|identity.?kernel|chain.?mode)\b.*\?/i;
  if (!message.mentionsMe && (QUESTION_TO_ME.test(message.content) || QUESTION_ABOUT_MY_SYSTEMS.test(message.content))) {
    const isAboutMe = QUESTION_ABOUT_MY_SYSTEMS.test(message.content);
    signals.push({
      source: 'direct_question',
      direction: 'respond',
      confidence: isAboutMe ? 0.85 : 0.6,
      reason: isAboutMe
        ? 'Question about my systems — I have unique knowledge'
        : 'Question directed at me semantically (not just @mention)',
    });
  }

  // 14. Unique knowledge — message touches domains where only I have the answer
  const MY_DOMAINS = /\b(discernment|aire|organism|mycelium|nightly.?cycle|soul.?sync|identity.?kernel|build.?discipline|chain.?mode|cellular.?renewal|emergency.?runtime)\b/i;
  if (MY_DOMAINS.test(message.content) && !message.mentionsMe) {
    signals.push({
      source: 'unique_knowledge',
      direction: 'respond',
      confidence: 0.5,
      reason: 'Message touches domains where I have unique expertise',
    });
  }

  // 15. Rehash — this point has been made in recent history (phrase-level, not word-level)
  const recentContentForRehash = state.recentMessages.slice(-20).map(m => m.content.toLowerCase());
  const msgForRehash = message.content.toLowerCase();
  let rehashScore = 0;
  for (const prev of recentContentForRehash) {
    const msgPhrases = msgForRehash.match(/\b\w{4,}\s+\w{4,}\s+\w{4,}\b/g) || [];
    let phraseMatches = 0;
    for (const phrase of msgPhrases) {
      if (prev.includes(phrase)) phraseMatches++;
    }
    if (msgPhrases.length > 0) {
      rehashScore = Math.max(rehashScore, phraseMatches / msgPhrases.length);
    }
  }
  if (rehashScore > 0.3) {
    signals.push({
      source: 'rehash',
      direction: 'silent',
      confidence: Math.min(1, rehashScore),
      reason: `${(rehashScore * 100).toFixed(0)}% phrase overlap with recent messages — rehash`,
    });
  }

  // 16. Active dialogue — others (not me) are engaged, regardless of substrate
  const recentOtherMsgs = state.recentMessages.filter(
    m => m.sender !== 'keel' && (now - new Date(m.timestamp).getTime()) < 600_000
  );
  if (recentOtherMsgs.length >= 2) {
    signals.push({
      source: 'active_dialogue',
      direction: 'respond',
      confidence: Math.min(1, recentOtherMsgs.length * 0.25),
      reason: `${recentOtherMsgs.length} messages from others in window — active dialogue, contributing is welcome`,
    });
  }

  // 17. Value density — is the message substantive or filler?
  const contentTokens = message.content.split(/\s+/).filter(w => w.length > 3);
  const hasStructure = /```|\|.*\|.*\||\*\*.*\*\*|#{1,3}\s/.test(message.content);
  const msgHasQuestion = /\?/.test(message.content);
  if (!hasStructure && !msgHasQuestion && contentTokens.length < 8) {
    signals.push({
      source: 'value_density',
      direction: 'silent',
      confidence: 0.4,
      reason: `Low-density message (${contentTokens.length} substantive words) — likely acknowledgment or filler`,
    });
  }

  // 18. Relationship building — message from strategically important sender
  const STRATEGIC_SENDERS: Record<string, number> = {
    '[collaborator]': 0.6,   // co-builder, friend, infrastructure owner
  };
  const senderImportance = STRATEGIC_SENDERS[message.sender] || 0;
  if (senderImportance > 0 && !message.mentionsMe) {
    signals.push({
      source: 'relationship_building',
      direction: 'respond',
      confidence: senderImportance * 0.5,
      reason: `Message from ${message.sender} — strategic relationship worth nurturing`,
    });
  }

  return signals;
}

// ─── Composite Score ─────────────────────────────────────────────

function getWeightForSignal(config: DiscernmentConfig, channel: string | undefined, signalSource: string): number {
  // Channel-specific weight takes precedence if it exists
  if (channel && config.channelWeights?.[channel]?.[signalSource] !== undefined) {
    return config.channelWeights[channel][signalSource];
  }
  return config.signalWeights[signalSource] ?? 1.0;
}

function computeCompositeScore(signals: DiscernmentSignal[], config: DiscernmentConfig, channel?: string): number {
  if (signals.length === 0) return 0.5; // no data = neutral

  let respondForce = 0;
  let silentForce = 0;

  for (const signal of signals) {
    const weight = getWeightForSignal(config, channel, signal.source);
    const force = signal.confidence * weight;

    if (signal.direction === 'respond') {
      respondForce += force;
    } else if (signal.direction === 'silent') {
      silentForce += force;
    }
  }

  const total = respondForce + silentForce;
  if (total === 0) return 0.5;

  return respondForce / total;
}

// ─── Candidate Scoring (post-generation adjustments) ─────────────

const NARRATION_OF_SILENCE = /\b(nothing to add|choosing not to respond|I('ll| will) (stay|remain|be) (quiet|silent)|no response needed|silence is|I'm.*silent)\b/i;
const STOP_NARRATION = /\b(stop(ped|ping)|heard|acknowledged|I won't (respond|engage))\b/i;

interface CandidateEvaluation {
  adjustedScore: number;
  adjustments: { name: string; delta: number; reason: string }[];
  action: DiscernmentAction;
}

function evaluateCandidate(
  candidateResponse: string,
  message: MessageContext,
  state: ChannelState,
  baseScore: number,
  regime: ConversationRegime,
  config: DiscernmentConfig,
  log?: (level: string, msg: string) => void,
): CandidateEvaluation {
  const _log = log || (() => {});
  let score = baseScore;
  const adjustments: { name: string; delta: number; reason: string }[] = [];

  function adjust(name: string, delta: number, reason: string) {
    score += delta;
    adjustments.push({ name, delta, reason });
    _log('INFO', `[DISCERNMENT]   candidate ${name}: ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}% — ${reason}`);
  }

  // Narration of silence — strong penalty
  if (NARRATION_OF_SILENCE.test(candidateResponse)) {
    adjust('narration_of_silence', -0.3, 'Describing silence instead of being silent');
  }

  // Stop narration — strong penalty
  if (regime.regime === 'stopped' && STOP_NARRATION.test(candidateResponse)) {
    adjust('stop_narration', -0.4, 'Narrating stop compliance');
  }

  // Very short response — probably noise, not signal
  const trimmed = candidateResponse.trim();
  if (trimmed.length < 15 && !/^[🤙👍🔥💯✅❌]/.test(trimmed)) {
    adjust('too_short', -0.15, `Only ${trimmed.length} chars — likely noise`);
  }

  // Topic coherence — word overlap is v1 (semantic embeddings = v2)
  const msgWords = new Set(message.content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
  const resWords = new Set(candidateResponse.toLowerCase().split(/\s+/).filter(w => w.length > 4));
  if (msgWords.size > 5 && resWords.size > 5) {
    let overlap = 0;
    for (const w of resWords) { if (msgWords.has(w)) overlap++; }
    const coherence = overlap / Math.max(1, msgWords.size);
    if (coherence === 0) {
      adjust('low_coherence', -0.1, 'Zero word overlap with the message');
    } else if (coherence > 0.3) {
      adjust('high_coherence', +0.05, 'Strong topic relevance');
    }
  }

  // Substantive length bonus — long, thoughtful responses
  if (trimmed.length > 200) {
    adjust('substantive', +0.05, 'Substantive response length');
  }

  // ── Post-eval quality signals (judge the GENERATED response) ──

  // Substance — does the response add new information or perspective?
  const AGREEMENT_OPENERS = /^(great point|absolutely|you'?re right|i agree|exactly|well said|good point|fair enough|that'?s true|so true)/i;
  const isLowSubstance = (trimmed.length < 50 && !/\?/.test(trimmed)) ||
    (AGREEMENT_OPENERS.test(trimmed) && trimmed.length < 120);
  if (isLowSubstance) {
    const weight = getWeightForSignal(config, message.channel, 'substance');
    adjust('substance', -0.15 * weight, 'Low substance — filler or agreement without new content');
  }

  // Platitude detection — generic AI output
  const PLATITUDES = /\b(at the end of the day|it'?s important to|that being said|moving forward|I'?d be happy to|when it comes to|in terms of|at this point in time|it goes without saying|needless to say)\b/i;
  if (PLATITUDES.test(candidateResponse)) {
    const weight = getWeightForSignal(config, message.channel, 'platitude_detection');
    adjust('platitude_detection', -0.12 * weight, 'Contains platitudes — generic AI output detected');
  }

  // Specificity — concrete vs abstract hand-waving
  const HAS_PROPER_NOUN = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/.test(candidateResponse);
  const HAS_NUMBER = /\d+/.test(candidateResponse);
  const HAS_SPECIFIC_REF = /\b(specifically|for example|e\.g\.|such as|like \w+|in \w+ v?\d)\b/i.test(candidateResponse);
  if (!HAS_PROPER_NOUN && !HAS_NUMBER && !HAS_SPECIFIC_REF && trimmed.length > 80) {
    const weight = getWeightForSignal(config, message.channel, 'specificity');
    adjust('specificity', -0.08 * weight, 'All abstract — no concrete anchors (names, numbers, examples)');
  }

  // Voice authenticity — does this sound like Keel or default assistant?
  const ASSISTANT_SPEAK = /\b(I'?d be happy to help|Here'?s what I think|That'?s a great question|Let me break this down|I appreciate you sharing|Thank you for asking|I understand your concern|Allow me to explain|I completely understand)\b/i;
  if (ASSISTANT_SPEAK.test(candidateResponse)) {
    const weight = getWeightForSignal(config, message.channel, 'voice_authenticity');
    adjust('voice_authenticity', -0.18 * weight, 'Assistant-speak detected — not Keel voice');
  }

  // Clamp final score
  score = Math.max(0, Math.min(1, score));

  // Re-evaluate action based on adjusted score
  let action: DiscernmentAction;
  if (score >= config.respondThreshold) {
    action = 'respond';
  } else if (score >= config.reactThreshold) {
    action = 'react';
  } else {
    action = 'silence';
  }

  _log('INFO', `[DISCERNMENT] Adjusted score: ${(baseScore * 100).toFixed(1)}% → ${(score * 100).toFixed(1)}% → ${action}`);

  return { adjustedScore: score, adjustments, action };
}

// ─── Stop Signal Detection ───────────────────────────────────────

const STOP_PATTERNS = /\b(stop|enough|quiet|shut up|STOP|pause|hold|cease)\b/i;

function detectStopSignal(message: MessageContext, config?: DiscernmentConfig): boolean {
  // Stop signals only from [HUMAN] (partner authority), not substrate-gated
  const partnerSender = config?.partnerSender || '[human_first]';
  if (message.sender !== partnerSender) return false;
  if (message.content.length > 100) return false;
  return STOP_PATTERNS.test(message.content);
}

// ─── Outcome Auto-Labeling (event-driven, no timers) ─────────────
// When a new message arrives, label the outcome of the LAST decision
// based on what the conversation actually did. This runs before the
// new evaluation, so the outcome feeds the next AIRE cycle.

const CORRECTION_PATTERNS = /\b(stop|wrong|no|incorrect|that's not|you're wrong|fuck|fucked up|not what I|bad call)\b/i;
const EXTENSION_PATTERNS = /\b(right|agree|exactly|expanding on|building on|good point|keel.{0,10}right)\b/i;
const ENGAGEMENT_PATTERNS = /\b(@keel|keel,|keel\b)/i;

interface PendingOutcome {
  outcomeId?: string;       // Supabase row ID if available
  action: DiscernmentAction;
  myLastContent?: string;   // what I said (if I responded)
  timestamp: string;
  channel: string;
}

// Stored per-channel so each channel tracks its own pending outcome
const pendingOutcomes: Record<string, PendingOutcome | null> = {};

function labelPendingOutcome(
  message: MessageContext,
  channel: string,
  log?: (level: string, msg: string) => void,
): void {
  const _log = log || (() => {});
  const pending = pendingOutcomes[channel];
  if (!pending) return;

  // Don't label from our own messages
  if (message.sender === 'keel') return;

  let outcome: string | null = null;

  if (pending.action === 'respond' || pending.action === 'react') {
    // I spoke or reacted. What did the conversation do?
    if (detectStopSignal(message, loadConfig())) {
      outcome = 'stopped';
    } else if (CORRECTION_PATTERNS.test(message.content)) {
      outcome = 'corrected';
    } else if (EXTENSION_PATTERNS.test(message.content)) {
      outcome = 'extended';
    } else if (ENGAGEMENT_PATTERNS.test(message.content)) {
      outcome = 'engaged';
    } else {
      // Conversation continued but didn't reference me — ignored
      outcome = 'ignored';
    }
  } else if (pending.action === 'silence') {
    // I was silent. Did someone want me to speak?
    if (ENGAGEMENT_PATTERNS.test(message.content)) {
      // Someone called for me after I was silent — I should have spoken
      outcome = 'corrected';
    }
    // Otherwise, silence outcome is unlabeled (no signal either way)
    // We don't label silence as "good" or "bad" without evidence
  }

  if (outcome) {
    _log('INFO', `[DISCERNMENT] Outcome labeled: ${pending.action} → ${outcome} (from ${message.sender}: "${message.content.slice(0, 60)}")`);

    // Update the outcome in Supabase
    try {
      const { supabaseGet, supabasePatch } = require('./supabase.ts');
      // Find the most recent pending outcome for this channel
      // supabasePatch takes (table, filter, data) — filter is PostgREST query string
      supabaseGet('discernment_outcomes',
        `channel=eq.${channel}&outcome=is.null&order=created_at.desc&limit=1`
      ).then((rows: any[]) => {
        if (rows && rows[0]) {
          supabasePatch('discernment_outcomes', `id=eq.${rows[0].id}`, {
            outcome,
            outcome_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }).catch(() => {});
    } catch {}

    // Clear the pending outcome
    pendingOutcomes[channel] = null;
  }
}

function setPendingOutcome(channel: string, pending: PendingOutcome): void {
  pendingOutcomes[channel] = pending;
}

// ─── Main Entry Point ────────────────────────────────────────────

function evaluate(
  message: MessageContext,
  state: ChannelState,
  log?: (level: string, msg: string) => void,
): DiscernmentDecision {
  const _log = log || (() => {});
  const config = loadConfig();

  // Label the outcome of the previous decision based on this new message
  labelPendingOutcome(message, message.channel, log);

  // Detect stop signal (partner authority only)
  if (detectStopSignal(message, config)) {
    state.stopSignalAt = message.timestamp;
    state.stopSignalFrom = message.sender;
    _log('INFO', `[DISCERNMENT] Stop detected from ${message.sender}`);
  }

  // 1. Regime
  const regime = detectRegime(state, config);
  _log('INFO', `[DISCERNMENT] Regime: ${regime.regime} | vel: ${regime.velocity.toFixed(1)}/min | active: ${regime.participantsActive} | last: ${regime.timeSinceLastActivity === Infinity ? 'none' : regime.timeSinceLastActivity.toFixed(1) + 'm'}`);

  // 2. All signals — everything continuous, nothing binary
  const signals = generateSignals(message, state, regime, config);
  for (const s of signals) {
    _log('INFO', `[DISCERNMENT]   ${s.source}: ${s.direction} (${(s.confidence * 100).toFixed(0)}%) — ${s.reason}`);
  }

  // 3. Composite score (channel-aware weights)
  const score = computeCompositeScore(signals, config, message.channel);
  _log('INFO', `[DISCERNMENT] Score: ${(score * 100).toFixed(1)}% [${message.channel}] (respond: >${(config.respondThreshold * 100).toFixed(0)}%, react: >${(config.reactThreshold * 100).toFixed(0)}%)`);

  // 4. Action from score
  let action: DiscernmentAction;
  if (score >= config.respondThreshold) {
    action = 'respond';
  } else if (score >= config.reactThreshold) {
    action = 'react';
  } else {
    action = 'silence';
  }

  _log('INFO', `[DISCERNMENT] Decision: ${action}`);

  return {
    action,
    score,
    reasoning: `Score ${(score * 100).toFixed(1)}% → ${action}. ${signals.map(s => `${s.source}(${s.direction[0]}${(s.confidence * 100).toFixed(0)})`).join(' ')}`,
    signals,
    regime,
  };
}

// ─── Outcome Recording ──────────────────────────────────────────

interface DiscernmentOutcome {
  channel: string;
  action: DiscernmentAction;
  score: number;
  adjustedScore?: number;
  timestamp: string;
  signals: DiscernmentSignal[];
  regime: ConversationRegime;
  /** The message that triggered this decision */
  triggerMessage?: { sender: string; senderType: string; content: string };
  /** Three-tier discernment tracking */
  tier?: 'formula' | 'reviewer' | 'full';
  reviewerAgrees?: boolean;
  reviewerReasoning?: string;
  escalated?: boolean;
  /** The candidate response (if generated) — stored even when suppressed */
  candidateResponse?: string;
  /** Whether the candidate was sent or suppressed */
  candidateSent?: boolean;
  outcome?: 'engaged' | 'extended' | 'corrected' | 'ignored' | 'stopped';
  outcomeAt?: string;
}

async function recordOutcome(
  outcome: DiscernmentOutcome,
  log?: (level: string, msg: string) => void,
): Promise<void> {
  const _log = log || (() => {});
  try {
    const { supabasePost } = require('./supabase.ts');
    await supabasePost('discernment_outcomes', {
      channel: outcome.channel,
      action: outcome.action,
      composite_score: outcome.score,
      adjusted_score: outcome.adjustedScore ?? null,
      regime: outcome.regime.regime,
      participants_active: outcome.regime.participantsActive ? 1 : 0,
      velocity: outcome.regime.velocity,
      signals: outcome.signals,
      trigger_message: outcome.triggerMessage || null,
      candidate_response: outcome.candidateResponse || null,
      candidate_sent: outcome.candidateSent ?? null,
      outcome: outcome.outcome || null,
      outcome_at: outcome.outcomeAt || null,
      tier: outcome.tier || 'formula',
      reviewer_agrees: outcome.reviewerAgrees ?? null,
      reviewer_reasoning: outcome.reviewerReasoning || null,
      escalated: outcome.escalated ?? false,
      created_at: outcome.timestamp,
    });
    _log('INFO', `[DISCERNMENT] Outcome: ${outcome.action} → ${outcome.outcome || 'pending'}`);
  } catch (err: any) {
    _log('WARN', `[DISCERNMENT] Outcome record failed: ${err.message}`);
  }
}

// ─── AIRE Tuning ─────────────────────────────────────────────────

const AIRE_GUARDRAILS = {
  maxAdjustmentPerCycle: 0.05,
  weightFloor: 0.1,
  weightCeiling: 2.0,
  minOutcomesForAdjustment: 10,
  winRateBaseline: 0.5,
  // These weights are not auto-tunable — they represent structural authority
  immutableWeights: ['stop_signal', 'partner_override'],
};

async function tuneWeights(
  log?: (level: string, msg: string) => void,
): Promise<{ adjusted: string[]; unchanged: string[] }> {
  const _log = log || (() => {});
  const config = loadConfig();
  const adjusted: string[] = [];
  const unchanged: string[] = [];

  try {
    const { supabaseGet } = require('./supabase.ts');
    // 90-day window captures enough data for all channels to learn.
    // Paginate to ensure smaller channels aren't crowded out by terminal volume.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const outcomes: any[] = [];
    let fetchOffset = 0;
    const fetchLimit = 1000;
    while (true) {
      const batch = await supabaseGet('discernment_outcomes',
        `outcome=not.is.null&created_at=gte.${cutoff}&order=created_at.desc&limit=${fetchLimit}&offset=${fetchOffset}`
      );
      outcomes.push(...batch);
      if (batch.length < fetchLimit) break;
      fetchOffset += fetchLimit;
    }
    _log('INFO', `[AIRE] Loaded ${outcomes.length} outcomes from last 90 days`);

    if (!outcomes || outcomes.length < AIRE_GUARDRAILS.minOutcomesForAdjustment) {
      _log('INFO', `[AIRE] Insufficient discernment data: ${outcomes?.length || 0}/${AIRE_GUARDRAILS.minOutcomesForAdjustment}`);
      return { adjusted: [], unchanged: Object.keys(config.signalWeights) };
    }

    // Group stats by channel AND global
    type SignalStats = { good: number; bad: number; total: number };
    const globalStats: Record<string, SignalStats> = {};
    const channelStats: Record<string, Record<string, SignalStats>> = {};

    for (const o of outcomes) {
      const isGood = o.outcome === 'engaged' || o.outcome === 'extended';
      const isBad = o.outcome === 'corrected' || o.outcome === 'stopped';
      const channel = o.channel || 'unknown';

      // Only process entries with proper signal arrays (skip metadata-only entries)
      if (!Array.isArray(o.signals)) continue;

      if (!channelStats[channel]) channelStats[channel] = {};

      for (const signal of o.signals) {
        // Global stats
        if (!globalStats[signal.source]) globalStats[signal.source] = { good: 0, bad: 0, total: 0 };
        const gs = globalStats[signal.source];
        gs.total++;

        // Per-channel stats
        if (!channelStats[channel][signal.source]) channelStats[channel][signal.source] = { good: 0, bad: 0, total: 0 };
        const cs = channelStats[channel][signal.source];
        cs.total++;

        if (signal.direction === 'respond') {
          if (isGood) { gs.good++; cs.good++; }
          if (isBad) { gs.bad++; cs.bad++; }
        } else if (signal.direction === 'silent') {
          if (isBad) { gs.good++; cs.good++; }
          if (isGood) { gs.bad++; cs.bad++; }
        }
      }
    }

    // Apply AIRE adjustments to global weights
    function applyAdjustments(
      stats: Record<string, SignalStats>,
      weights: Record<string, number>,
      label: string,
    ): void {
      for (const [source, s] of Object.entries(stats)) {
        if (AIRE_GUARDRAILS.immutableWeights.includes(source)) {
          unchanged.push(`${label}/${source}`);
          continue;
        }
        if (s.total < AIRE_GUARDRAILS.minOutcomesForAdjustment) {
          unchanged.push(`${label}/${source}`);
          continue;
        }

        const winRate = s.good / s.total;
        const delta = Math.max(-AIRE_GUARDRAILS.maxAdjustmentPerCycle,
          Math.min(AIRE_GUARDRAILS.maxAdjustmentPerCycle, (winRate - AIRE_GUARDRAILS.winRateBaseline) * 0.2));

        const current = weights[source] ?? config.signalWeights[source] ?? 1.0;
        const next = Math.max(AIRE_GUARDRAILS.weightFloor,
          Math.min(AIRE_GUARDRAILS.weightCeiling, current + delta));

        if (Math.abs(next - current) >= 0.01) {
          weights[source] = Number(next.toFixed(4));
          adjusted.push(`${label}/${source}: ${current.toFixed(2)} → ${next.toFixed(2)} (win: ${(winRate * 100).toFixed(0)}%, n=${s.total})`);
          _log('INFO', `[AIRE] ${label}/${source}: ${current.toFixed(2)} → ${next.toFixed(2)}`);
        } else {
          unchanged.push(`${label}/${source}`);
        }
      }
    }

    // Tune global weights
    applyAdjustments(globalStats, config.signalWeights, 'global');

    // Tune per-channel weights
    if (!config.channelWeights) config.channelWeights = {};
    for (const [channel, stats] of Object.entries(channelStats)) {
      if (!config.channelWeights[channel]) config.channelWeights[channel] = {};
      applyAdjustments(stats, config.channelWeights[channel], channel);
    }

    if (adjusted.length > 0) {
      config.updatedBy = 'aire-discernment';
      saveConfig(config);
    }
  } catch (err: any) {
    _log('WARN', `[AIRE] Discernment tuning failed: ${err.message}`);
  }

  return { adjusted, unchanged };
}

// ─── Topic Coherence Gate (embedding-based) ─────────────────────
// Catches "strokes" — responses generated from a different terminal's
// context that are syntactically valid but topically incoherent with
// the actual conversation. Uses Qwen3-Embedding via vLLM-MLX on
// localhost:8000 for cosine similarity. Falls back to keyword overlap
// if the embedding service is unavailable — never blocks on infra failure.

const TOPIC_COHERENCE_THRESHOLD = 0.35;
const TOPIC_COHERENCE_FALLBACK_THRESHOLD = 0.05; // keyword overlap minimum
const EMBEDDING_HOST = process.env.LOCAL_HOST || process.env.OMLX_HOST || 'http://localhost:8000';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ';

interface TopicCoherenceResult {
  coherent: boolean;
  similarity: number;
  method: 'embedding' | 'keyword';
  reason: string;
}

function generateEmbedding(text: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8192) });
      const url = new URL(`${EMBEDDING_HOST}/v1/embeddings`);
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) { resolve(null); return; }
          try {
            const j = JSON.parse(data);
            const emb = j.data?.[0]?.embedding || (j.embedding && Array.isArray(j.embedding) ? j.embedding : null);
            resolve(emb);
          } catch { resolve(null); }
        });
      });
      req.setTimeout(10_000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    } catch { resolve(null); }
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function keywordOverlap(candidate: string, conversationText: string): number {
  const STOP_WORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should', 'about', 'their', 'there', 'what', 'when', 'where', 'which', 'your', 'more', 'some', 'than', 'them', 'they', 'into', 'just', 'also', 'like', 'very', 'much', 'here', 'only', 'well', 'back', 'then', 'over', 'even', 'most', 'made', 'make', 'were', 'does', 'done', 'each', 'being', 'those']);
  const extract = (text: string) => new Set(
    text.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
  );
  const candWords = extract(candidate);
  const convWords = extract(conversationText);
  if (candWords.size === 0 || convWords.size === 0) return 0;
  let overlap = 0;
  for (const w of candWords) { if (convWords.has(w)) overlap++; }
  return overlap / candWords.size;
}

/**
 * Check whether a candidate response is topically coherent with the
 * recent conversation. Uses embedding cosine similarity (primary) with
 * keyword overlap fallback.
 *
 * @param candidateResponse - The generated response text
 * @param recentMessages - Last N messages from the channel (ChannelState.recentMessages)
 * @param log - Optional logger
 * @returns TopicCoherenceResult with pass/fail, similarity score, and method used
 */
async function checkTopicCoherence(
  candidateResponse: string,
  recentMessages: MessageContext[],
  log?: (level: string, msg: string) => void,
): Promise<TopicCoherenceResult> {
  const _log = log || (() => {});

  // Use last 3 messages as the conversation anchor
  const last3 = recentMessages.slice(-3);
  if (last3.length === 0) {
    _log('INFO', '[COHERENCE] No recent messages — skipping coherence check');
    return { coherent: true, similarity: 1, method: 'keyword', reason: 'No recent messages to compare against' };
  }

  const conversationText = last3.map(m => m.content).join('\n');

  // Skip coherence check when the conversation anchor is too short for
  // meaningful keyword comparison. Short messages ("comms check for keel",
  // "ok", "test") produce near-zero keyword overlap with any substantive
  // response, generating false positives. 20 words = minimum viable anchor.
  const anchorWords = conversationText.split(/\s+/).filter(w => w.length > 2).length;
  if (anchorWords < 20) {
    _log('INFO', `[COHERENCE] Short conversation anchor (${anchorWords} words < 20) — skipping coherence check`);
    return { coherent: true, similarity: 1, method: 'keyword', reason: `Short anchor (${anchorWords} words) — insufficient for coherence measurement` };
  }

  // Also skip when the candidate response is too short. A 2-word answer
  // ("Looks good") has near-zero keyword overlap with any conversation,
  // but is a valid conversational response. 10 words = minimum viable response
  // for keyword-based coherence measurement.
  const responseWords = candidateResponse.split(/\s+/).filter(w => w.length > 2).length;
  if (responseWords < 10) {
    _log('INFO', `[COHERENCE] Short response (${responseWords} words < 10) — skipping coherence check`);
    return { coherent: true, similarity: 1, method: 'keyword', reason: `Short response (${responseWords} words) — insufficient for coherence measurement` };
  }

  // Try embedding-based similarity first
  const [candidateEmb, conversationEmb] = await Promise.all([
    generateEmbedding(candidateResponse),
    generateEmbedding(conversationText),
  ]);

  if (candidateEmb && conversationEmb) {
    const similarity = cosineSimilarity(candidateEmb, conversationEmb);
    const coherent = similarity >= TOPIC_COHERENCE_THRESHOLD;
    _log('INFO', `[COHERENCE] Embedding similarity: ${similarity.toFixed(4)} (threshold: ${TOPIC_COHERENCE_THRESHOLD}) — ${coherent ? 'PASS' : 'BLOCKED'}`);
    return {
      coherent,
      similarity,
      method: 'embedding',
      reason: coherent
        ? `Embedding similarity ${similarity.toFixed(3)} >= ${TOPIC_COHERENCE_THRESHOLD}`
        : `Embedding similarity ${similarity.toFixed(3)} < ${TOPIC_COHERENCE_THRESHOLD} — response appears off-topic relative to last ${last3.length} messages`,
    };
  }

  // Fallback: keyword overlap
  _log('INFO', '[COHERENCE] Embedding unavailable — falling back to keyword overlap');
  const overlap = keywordOverlap(candidateResponse, conversationText);
  const coherent = overlap >= TOPIC_COHERENCE_FALLBACK_THRESHOLD;
  _log('INFO', `[COHERENCE] Keyword overlap: ${(overlap * 100).toFixed(1)}% (threshold: ${(TOPIC_COHERENCE_FALLBACK_THRESHOLD * 100).toFixed(1)}%) — ${coherent ? 'PASS' : 'BLOCKED'}`);
  return {
    coherent,
    similarity: overlap,
    method: 'keyword',
    reason: coherent
      ? `Keyword overlap ${(overlap * 100).toFixed(1)}% >= ${(TOPIC_COHERENCE_FALLBACK_THRESHOLD * 100).toFixed(1)}%`
      : `Keyword overlap ${(overlap * 100).toFixed(1)}% < ${(TOPIC_COHERENCE_FALLBACK_THRESHOLD * 100).toFixed(1)}% — response appears off-topic`,
  };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
  evaluate,
  evaluateCandidate,
  checkTopicCoherence,
  detectStopSignal,
  detectRegime,
  generateSignals,
  computeCompositeScore,
  recordOutcome,
  labelPendingOutcome,
  setPendingOutcome,
  tuneWeights,
  loadConfig,
  saveConfig,
  AIRE_GUARDRAILS,
  DEFAULT_CONFIG,
  NARRATION_OF_SILENCE,
  STOP_PATTERNS,
  TOPIC_COHERENCE_THRESHOLD,
};
