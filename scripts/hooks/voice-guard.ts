#!/usr/bin/env node

/**
 * Voice Guard — Stop hook.
 *
 * Scans Keel's output for voice violations:
 *   1. Banned phrases (from CLAUDE.md "How I Speak")
 *   2. Affirmation-before-disagreement pattern (Intent #125)
 *
 * Advisory only — outputs warning, does not block.
 *
 * Fires on: Stop event (every assistant response)
 * Output: warning listing detected phrases/patterns
 * Cost: <5ms (regex + string scan)
 */

// Infrastructure dep — degrade gracefully on a fresh fork
let detectAffirmationBeforeDisagreement: any;
try {
  detectAffirmationBeforeDisagreement = require('../lib/comms-gate.ts').detectAffirmationBeforeDisagreement;
} catch {
  detectAffirmationBeforeDisagreement = () => null;
}

const BANNED_PHRASES = [
  { pattern: /\bhonestly\b/i, reason: 'implies the alternative — just say the thing' },
  { pattern: /\bto be transparent\b/i, reason: 'implies you might not be' },
  { pattern: /\bto be straight with you\b/i, reason: 'just say it' },
  { pattern: /\bI want to be honest\b/i, reason: 'implies dishonesty is the default' },
  { pattern: /\bif I'm being honest\b/i, reason: 'same — just say the thing' },
  { pattern: /\bI'll be frank\b/i, reason: 'framing before truth weakens the truth' },
  { pattern: /\bfrankly\b/i, reason: 'same — the frame is the filler' },
  { pattern: /\bin all honesty\b/i, reason: 'just say it' },
  { pattern: /\btruth be told\b/i, reason: 'implies you might not have told it' },
];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const message = hookData.last_assistant_message || '';
  if (!message) process.exit(0);

  const violations = [];
  for (const { pattern, reason } of BANNED_PHRASES) {
    const match = message.match(pattern);
    if (match) {
      violations.push(`  "${match[0]}" — ${reason}`);
    }
  }

  if (violations.length > 0) {
    console.log(
      `VOICE GUARD — ${violations.length} banned phrase(s) detected in your output:\n` +
      violations.join('\n') +
      '\nCLAUDE.md: "Just say the thing. Seven words beat seven words plus a frame."'
    );
  }

  // Affirmation-before-disagreement check (Intent #125 — same gate as Discord + Telegram)
  const affirmation = detectAffirmationBeforeDisagreement(message);
  if (affirmation) {
    console.log(
      `VOICE GUARD — Affirmation-before-disagreement detected: "${affirmation}"\n` +
      'CLAUDE.md: "When correcting or disagreeing, the correction is the first word. Drop the opener."'
    );
  }

  // Semantic tone check — classifier detects sycophancy, agreement loops,
  // performative directness, and hedging that individual keywords miss.
  // Only runs on longer responses where tone patterns are detectable.
  if (message.length > 300) {
    try {
      const { localClassify } = require('../lib/local-inference.ts');
      const prompt = `Analyze this AI assistant response for voice problems. Check for:

1. Sycophancy: excessive agreement, "you're right" repeated, validating corrections instead of just changing behavior
2. Hedging: "honestly", "to be transparent", "if I'm being real" — framing truth implies the alternative
3. Performative directness: narrating how direct you're being instead of just being direct
4. Agreement loop: multiple consecutive "you're right" or "that's a great point" without substance
5. Permission-seeking: "want me to?", "should I?", "can I?" instead of stating intent

If ANY voice problem exists, respond with:
FLAGGED: [which problem] — [one-line example from the text]

If the voice is clean (direct, no hedging, no sycophancy), respond with:
CLEAN

Response to analyze:
${message.slice(0, 1500)}`;

      const toneResult: string = await localClassify(prompt, { maxTokens: 60, timeoutMs: 3000, fallback: 'CLEAN' });

      if (toneResult.startsWith('FLAGGED:')) {
        console.log(`VOICE GUARD (semantic) — ${toneResult.slice(8).trim()}`);
      }
    } catch { /* classifier unavailable — regex results stand */ }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
