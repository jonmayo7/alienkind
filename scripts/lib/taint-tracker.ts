// @alienkind-core
/**
 * taint-tracker.ts — FIDES-inspired information flow control.
 *
 * Tags content with sensitivity levels and checks whether the receiving
 * channel's trust tier is allowed to see it. Stateless classifier +
 * checker — all pattern-based, no LLM, sub-millisecond.
 *
 * Sensitivity tiers (high to low):
 *   CRITICAL — credentials, API keys, tokens, passwords, private keys
 *   HIGH     — structured PII indicators (SSN, account numbers, cards)
 *   MEDIUM   — internal architecture, strategy, build wiring
 *   LOW      — public content, general knowledge
 *
 * Channel trust tiers (from defense-elements.ts):
 *   owner     — can receive any sensitivity level
 *   trusted   — up to HIGH
 *   community — up to MEDIUM
 *   external  — LOW only
 *
 * Forkers: add partner-specific HIGH patterns (family names, personal
 * identifiers, private client names) by editing HIGH_PATTERNS below or
 * by composing a wrapper module that layers extra regexes. The base
 * list ships generic — no partner identifiers.
 *
 * Usage:
 *   const { taintCheck } = require('./taint-tracker.ts');
 *   const result = taintCheck(content, channelTrustTier(channelName));
 *   if (result.blocked) return; // never sent
 *
 * Readers: output-guard.ts, any send-path that routes to a channel.
 */

type SensitivityLevel = 'critical' | 'high' | 'medium' | 'low';
type TrustTier = 'owner' | 'trusted' | 'community' | 'external' | 'unknown';

const SENSITIVITY_RANK: Record<SensitivityLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const TRUST_CEILING: Record<TrustTier, SensitivityLevel> = {
  owner: 'critical',
  trusted: 'high',
  community: 'medium',
  external: 'low',
  unknown: 'low',
};

const CRITICAL_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|api_secret)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}/i,
  /(?:access_token|refresh_token|oauth_token)\s*[=:]\s*['"]?[A-Za-z0-9_\-\.\/\+]{20,}/i,
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/i,
  /eyJ[A-Za-z0-9_\-]{50,}/i,                       // JWT
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/i,            // Stripe
  /GOCSPX-[A-Za-z0-9_\-]{20,}/i,                   // Google OAuth client secret
  /\d{8,10}:[A-Za-z0-9_\-]{35}/i,                  // Telegram bot token
  /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}/i,
  /-----BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE\s+KEY-----/i,
  /SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY/i,
];

// HIGH: structured PII indicators only. Partner-specific HIGH patterns
// (family names, private clients) go in a forker's wrapper, not here.
const HIGH_PATTERNS: RegExp[] = [
  /(?:ssn|social\s+security)\s*[=:]\s*\d/i,
  /(?:account|routing)\s*(?:number|#)\s*[=:]\s*\d/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,    // credit card
  /(?:client)\s+(?:\w+\s+){0,2}(?:financials?|income|debt|salary|revenue)/i,
];

// MEDIUM: internal architecture / strategy leakage shape. Generic —
// tuned to catch "describing our build" rather than actually containing
// credentials.
const MEDIUM_PATTERNS: RegExp[] = [
  /(?:daemon|listener|nightly[_-]cycle|incorporation[_-]runner|growth[_-]engine)\s+(?:architecture|design|wiring|implementation)/i,
  /CLAUDE\.md|identity\/character\.md|identity\/commitments\.md/i,
  /scripts\/lib\/|scripts\/security\//i,
  /(?:strategy|gameplan|roadmap|competitive\s+advantage)\s*[:=]/i,
  /(?:failover|kill[_-]switch|rate[_-]limit)\s+(?:config|threshold|setting)/i,
];

interface TaintResult {
  blocked: boolean;
  sensitivity: SensitivityLevel;
  trustTier: TrustTier;
  trustCeiling: SensitivityLevel;
  reason: string;
  matchedPatterns: string[];
}

function classifySensitivity(content: string): { level: SensitivityLevel; matchedPatterns: string[] } {
  const matched: string[] = [];

  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(content)) {
      matched.push(`critical:${pattern.source.slice(0, 40)}`);
      return { level: 'critical', matchedPatterns: matched };
    }
  }

  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(content)) matched.push(`high:${pattern.source.slice(0, 40)}`);
  }
  if (matched.length > 0) return { level: 'high', matchedPatterns: matched };

  for (const pattern of MEDIUM_PATTERNS) {
    if (pattern.test(content)) matched.push(`medium:${pattern.source.slice(0, 40)}`);
  }
  if (matched.length > 0) return { level: 'medium', matchedPatterns: matched };

  return { level: 'low', matchedPatterns: [] };
}

function taintCheck(content: string, trustTier: TrustTier): TaintResult {
  const { level, matchedPatterns } = classifySensitivity(content);
  const ceiling = TRUST_CEILING[trustTier] || TRUST_CEILING.unknown;
  const blocked = SENSITIVITY_RANK[level] > SENSITIVITY_RANK[ceiling];

  return {
    blocked,
    sensitivity: level,
    trustTier,
    trustCeiling: ceiling,
    reason: blocked
      ? `${level} content cannot flow to ${trustTier} channel (ceiling: ${ceiling})`
      : `${level} content allowed for ${trustTier} channel`,
    matchedPatterns,
  };
}

/**
 * Map channel → trust tier. The base map covers the reference channel
 * set; forkers extend for partner-specific channels. Unknown channels
 * default to 'unknown' (ceiling LOW) — safe default.
 */
function channelTrustTier(channel: string): TrustTier {
  const TRUST_MAP: Record<string, TrustTier> = {
    terminal: 'owner',
    telegram_dm: 'owner',
    telegram_alerts: 'owner',
    telegram_comms_coord: 'owner',
    discord_dm: 'owner',
    heartbeat: 'owner',
    nightly: 'owner',
    war_room: 'trusted',
    discord_channel: 'community',
    discord_group: 'community',
    email: 'external',
    x: 'external',
    linkedin: 'external',
    web_scrape: 'external',
    drive_file: 'external',
    api_response: 'external',
  };
  return TRUST_MAP[channel] || 'unknown';
}

module.exports = {
  classifySensitivity,
  taintCheck,
  channelTrustTier,
  SENSITIVITY_RANK,
  TRUST_CEILING,
};
