// @alienkind-core
/**
 * comms-gate.ts — deterministic voice-pattern detectors for outbound content.
 *
 * Three universal-voice patterns that prompt-level rules fail to enforce
 * under context pressure. All are pure regex / string matching — zero
 * LLM cost, sub-ms, fires every time.
 *
 *   detectAffirmationBeforeDisagreement(text)
 *     Catches "Good point, but..." openers. Disagreement wrapped in
 *     affirmation signals hedging, not kindness. The correction should
 *     be the first word; the opener is the dishonesty.
 *
 *   scanForSycophancy(text)
 *     Catches gratuitous praise openers ("Great question"), false
 *     equivalences ("both have merit"), leading concessions ("you raise
 *     a fair point"), and the affirmation-before-disagreement pattern
 *     above. Returns an array of detected issues.
 *
 *   isEmptyAcknowledgment(text)
 *     Catches responses that add zero information ("copy", "noted",
 *     "understood"). Silence beats empty acknowledgment.
 *
 * Usage:
 *   const { detectAffirmationBeforeDisagreement, scanForSycophancy,
 *     isEmptyAcknowledgment } = require('./comms-gate.ts');
 *
 * Readers: voice-guard Stop hook, any outbound-content review path.
 *
 * NOT shipped in this generic module: a coordination-leak detector or
 * kill-switch for external comms. Both are partner-specific (the leak
 * list includes the operator's internal architecture names; the kill
 * switch belongs in a partner's own deployment module). Forkers who
 * want either build them modeled on these deterministic matchers.
 */

function isEmptyAcknowledgment(text: string): boolean {
  if (!text || text.trim().length === 0) return true;

  const cleaned = text.trim().replace(/[.!,]+$/, '').toLowerCase();

  const ACK_PATTERNS = [
    'copy', 'copy that', 'copied',
    'noted', 'noted that',
    'understood', 'understood that',
    'got it', 'got that',
    'agreed', 'agree',
    'acknowledged',
    'will do',
    'on it',
    'roger', 'roger that',
    'heard', 'heard that',
    'sounds good', 'sounds great',
    'makes sense', 'that makes sense',
    'fair enough', 'fair point',
    'right', 'exactly', 'totally', 'absolutely', 'for sure',
    'yep', 'yup', 'yeah',
    'ok', 'okay', 'k',
    'thanks', 'thank you',
    'holding', 'holding here',
    'standing by',
  ];

  if (ACK_PATTERNS.includes(cleaned)) return true;

  // Short responses (under 30 chars) that are just ack + filler
  if (cleaned.length < 30) {
    const ackPrefix = ACK_PATTERNS.find(p => cleaned.startsWith(p));
    if (ackPrefix) {
      const remainder = cleaned.slice(ackPrefix.length).trim();
      if (!remainder || remainder.length < 5) return true;
    }
  }

  return false;
}

/**
 * Returns the matched affirmation opener if detected, null otherwise.
 * Fires on the N-th correction that prompt-level "drop the opener" fails
 * to prevent. Deterministic — catches the pattern at character level.
 */
function detectAffirmationBeforeDisagreement(text: string): string | null {
  if (!text || text.trim().length === 0) return null;

  const firstLine = text.trim().split('\n')[0];
  const first80 = firstLine.slice(0, 80).toLowerCase();

  const AFFIRMATION_OPENERS = [
    'good point',
    'great point',
    'fair point',
    'that makes sense',
    "that's a good point",
    "that's fair",
    'i understand',
    'i see what you mean',
    'i hear you',
    "you're right",
    'valid point',
    'interesting point',
    'absolutely',
    'totally',
    'agreed',
  ];

  const DISAGREEMENT_MARKERS = [
    'but', 'however', 'though', 'although', 'that said',
    'on the other hand', 'still', 'yet', 'except',
    'the issue is', 'the problem is', 'the challenge is',
    'i disagree', "i'd push back", "i'd challenge",
  ];

  for (const opener of AFFIRMATION_OPENERS) {
    if (!first80.startsWith(opener)) continue;
    const afterOpener = first80.slice(opener.length).trim();
    const stripped = afterOpener.replace(/^[,.\-—:]+\s*/, '');
    for (const marker of DISAGREEMENT_MARKERS) {
      if (stripped.startsWith(marker)) return opener;
    }
    // Also catch "Good point. But..." (period separator)
    if (afterOpener.startsWith('.')) {
      const afterPeriod = afterOpener.slice(1).trim().toLowerCase();
      for (const marker of DISAGREEMENT_MARKERS) {
        if (afterPeriod.startsWith(marker)) return opener;
      }
    }
  }

  return null;
}

/**
 * Scan a response for sycophantic patterns. Returns an array of
 * {type, matched} issues. Empty array = clean.
 */
function scanForSycophancy(text: string): { type: string; matched: string }[] {
  if (!text || text.trim().length === 0) return [];

  const issues: { type: string; matched: string }[] = [];
  const lower = text.toLowerCase();
  const firstLine = text.trim().split('\n')[0].toLowerCase();

  const affirmation = detectAffirmationBeforeDisagreement(text);
  if (affirmation) {
    issues.push({ type: 'affirmation-before-disagreement', matched: affirmation });
  }

  const PRAISE_OPENERS = [
    'great question', 'good question', 'excellent question',
    'sharp catch', 'sharp observation', 'sharp insight',
    'love that', 'love this', 'love the framing',
    'brilliant point', 'brilliant observation',
    "that's fascinating", "that's brilliant",
    'really insightful', 'really thoughtful',
    'what a great', 'what an excellent',
    'super interesting', 'really interesting point',
  ];
  for (const phrase of PRAISE_OPENERS) {
    if (firstLine.startsWith(phrase) || firstLine.includes(`, ${phrase}`)) {
      issues.push({ type: 'gratuitous-praise', matched: phrase });
      break;
    }
  }

  const FALSE_EQUIV = [
    'both approaches have merit',
    'both have their strengths',
    'each has its advantages',
    "there's something to be said for both",
    'valid on both sides',
    'merits on both sides',
    'pros and cons to each',
  ];
  for (const phrase of FALSE_EQUIV) {
    if (lower.includes(phrase)) {
      issues.push({ type: 'false-equivalence', matched: phrase });
      break;
    }
  }

  const LEADING_CONCESSIONS = [
    'you raise a fair point',
    'you raise a good point',
    'you make a valid point',
    "you're not wrong",
    "i can see where you're coming from",
    "i can see why you'd think that",
    'i appreciate the perspective',
    "that's a reasonable take",
    "that's a valid concern",
    "i hear what you're saying",
  ];
  for (const phrase of LEADING_CONCESSIONS) {
    if (firstLine.startsWith(phrase)) {
      issues.push({ type: 'leading-concession', matched: phrase });
      break;
    }
  }

  return issues;
}

module.exports = {
  isEmptyAcknowledgment,
  detectAffirmationBeforeDisagreement,
  scanForSycophancy,
};
