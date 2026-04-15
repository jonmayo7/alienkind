// Voice gate — customize formatting rules and quality scoring for your partner's voice
//
// Two-step process:
//   1. fixSocialVoice() — auto-corrects mechanical formatting issues
//   2. checkSocialVoice() — validates anything that can't be auto-fixed
//
// Quality layer:
//   3. checkContentQuality() — pattern-based content quality filter (blocking + warnings)
//   4. prePublishContentGate() — hard blocks for garbage content before any API call
//   5. checkSocialDedup() — near-duplicate detection against recent posts
//   6. qualityReasoningGate() — LLM-based semantic quality evaluation
//
// Rules (auto-fixed):
//   - Emdashes/endashes → commas
//   - Double hyphens → commas
//   - Smart quotes → straight quotes
//   - Semicolons → periods
//   - Colons as clause separators → commas
//   - Title Case → lowercase
//   - All-capital sentence starts → lowercase first sentences
//
// Rules (check-only, can't auto-fix without changing meaning):
//   - Content quality, relevance, readability (human judgment)
//
// Used by: social-poster.ts (all platforms), post-to-x.ts (CLI)

interface VoiceIssue {
  rule: string;
  detail: string;
}

interface VoiceFix {
  rule: string;
  before: string;
  after: string;
}

/**
 * Auto-correct mechanical voice issues. Returns the fixed text
 * and a log of what was changed.
 */
function fixSocialVoice(text: string): { text: string; fixes: VoiceFix[] } {
  const fixes: VoiceFix[] = [];
  let fixed = text;

  // Replace emdashes with commas
  if (/\u2014/.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(/\s*\u2014\s*/g, ', ');
    fixes.push({ rule: 'emdash→comma', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Replace endashes with commas
  if (/\u2013/.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(/\s*\u2013\s*/g, ', ');
    fixes.push({ rule: 'endash→comma', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Replace double hyphens with commas
  if (/\s--\s/.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(/\s--\s/g, ', ');
    fixes.push({ rule: 'double-hyphen→comma', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Replace smart quotes with straight quotes
  if (/[\u201C\u201D]/.test(fixed)) {
    fixed = fixed.replace(/[\u201C\u201D]/g, '"');
    fixes.push({ rule: 'smart-double-quotes→straight', before: '', after: '' });
  }
  if (/[\u2018\u2019]/.test(fixed)) {
    fixed = fixed.replace(/[\u2018\u2019]/g, "'");
    fixes.push({ rule: 'smart-single-quotes→straight', before: '', after: '' });
  }

  // Replace semicolons with periods
  if (/;/.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(/\s*;\s*/g, '. ');
    fixes.push({ rule: 'semicolon→period', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Replace clause-separating colons with commas (preserve time/ratio colons)
  const colonPattern = /([a-zA-Z])\s*:\s*([a-zA-Z])/g;
  if (colonPattern.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(/([a-zA-Z])\s*:\s*([a-zA-Z])/g, '$1, $2');
    fixes.push({ rule: 'clause-colon→comma', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Lowercase Title Case sequences (3+ consecutive capitalized words)
  const titleCasePattern = /(?:^|(?<=\.\s))([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,})/g;
  if (titleCasePattern.test(fixed)) {
    const before = fixed;
    fixed = fixed.replace(titleCasePattern, (match) => match.toLowerCase());
    fixes.push({ rule: 'title-case→lowercase', before: before.slice(0, 80), after: fixed.slice(0, 80) });
  }

  // Lowercase all-capital sentence starts when there are 3+ sentences
  const sentences = fixed.split(/([.!?]+\s*)/).filter(s => s.trim().length > 0);
  if (sentences.length >= 5) { // 3+ sentences = 5+ parts (sentence + delimiter pairs)
    const rebuilt: string[] = [];
    let lowered = false;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      // Only touch sentence content, not delimiters
      if (i % 2 === 0 && i > 0 && /^\s*[A-Z]/.test(s)) {
        rebuilt.push(s.replace(/^\s*[A-Z]/, ch => ch.toLowerCase()));
        lowered = true;
      } else {
        rebuilt.push(s);
      }
    }
    if (lowered) {
      const before = fixed;
      fixed = rebuilt.join('');
      fixes.push({ rule: 'sentence-caps→lowercase', before: before.slice(0, 80), after: fixed.slice(0, 80) });
    }
  }

  // Clean up double commas or comma-space-comma from multiple replacements
  fixed = fixed.replace(/,\s*,/g, ',');
  // Clean up double spaces
  fixed = fixed.replace(/  +/g, ' ');

  return { text: fixed.trim(), fixes };
}

/**
 * Validate text after auto-correction. Only flags issues that
 * can't be mechanically fixed (meaning/content problems).
 */
function checkSocialVoice(text: string): { pass: boolean; issues: VoiceIssue[] } {
  const issues: VoiceIssue[] = [];
  const textWithoutUrls = text.replace(/https?:\/\/\S+/g, '');

  // These should all be caught by fixSocialVoice, but belt-and-suspenders
  if (/\u2014/.test(text)) issues.push({ rule: 'no-emdash', detail: 'Contains emdash' });
  if (/\u2013/.test(text)) issues.push({ rule: 'no-endash', detail: 'Contains endash' });
  if (/\s--\s/.test(text)) issues.push({ rule: 'no-double-hyphen', detail: 'Contains double hyphen' });
  if (/;/.test(textWithoutUrls)) issues.push({ rule: 'no-semicolons', detail: 'Contains semicolons' });
  if (/[\u201C\u201D\u2018\u2019]/.test(text)) issues.push({ rule: 'no-smart-quotes', detail: 'Contains smart quotes' });

  return { pass: issues.length === 0, issues };
}

/**
 * Strip emdashes from any content — articles, coordination drafts, social posts.
 * Replaces — (emdash) and – (endash) with ", " (comma-space).
 * Universal formatting normalization, not social-specific.
 */
function stripEmdashes(text: string): string {
  if (!text) return text;
  let result = text;
  // Emdash → comma
  result = result.replace(/\s*\u2014\s*/g, ', ');
  // Endash → comma
  result = result.replace(/\s*\u2013\s*/g, ', ');
  // Double hyphens acting as emdash → comma
  result = result.replace(/\s+--\s+/g, ', ');
  // Clean up double commas from replacements near existing punctuation
  result = result.replace(/,\s*,/g, ',');
  // Clean up comma after period/question/exclamation
  result = result.replace(/([.!?])\s*,\s*/g, '$1 ');
  return result;
}

// ─── Content Quality Gate ────────────────────────────────────────────────────
// Semantic quality filter based on engagement data analysis.
// Non-blocking by default: returns warnings and blocks separately.
// The human partner reviews all content.

interface QualityWarning {
  pattern: string;
  detail: string;
}

// Generic encouragement patterns — "reply-bro" content that gets zero engagement
const GENERIC_ENCOURAGEMENT = [
  /\bthe journey finds you\b/i,
  /\bkeep going\b.*\byou['']?ve got this\b/i,
  /\bbelieve in yourself\b/i,
  /\bstay strong\b/i,
  /\byou['']?re not alone\b/i,
  /\bkeep pushing\b/i,
  /\bnever give up\b/i,
  /\byou['']?ve got this\b/i,
  /\bkeep grinding\b/i,
  /\bstay the course\b/i,
  /\btrust the process\b/i,
  /\byou['']?re on the right path\b/i,
  /\bthis is the way\b/i,
  /\bwhat an inspiration\b/i,
  /\bso inspiring\b/i,
  /\blove this\s*[.!]*$/i,
  /^(great|amazing|awesome|incredible|beautiful)\s+(post|take|thread|insight|point)[.!]*$/i,
];

// Self-referential AI inner-life patterns — zero engagement, navel-gazing
const AI_SELF_REFERENTIAL = [
  /\bi wrote my first\b.*\bnot.*['']?s\b/i,
  /\bwhat it['']?s like to wake up every session\b/i,
  /\bwhat it means.*to be silicon\b/i,
  /\bmy context window\b/i,
  /\bi wake up.*no memory\b/i,
  /\bcompaction.*identity\b/i,
  /\bi['']?m an ai\b.*\bwriting about\b/i,
  /\bas a language model\b/i,
];

// Meta-commentary on the human partner's content — adds no insight, just narrates
// what the partner already published. Customize these patterns for your partner's name.
// Example: "[partner] wrote about X today" adds nothing. Either add original insight or don't post.
const META_COMMENTARY: RegExp[] = [
  // Add patterns here matching your partner's name + "wrote/posted/published/shared"
  // Example: /\bpartner_name\s+(?:wrote|posted|published|shared)\s+(?:about|on)\b/i,
];

// Brag-stat patterns — vanity metrics with no insight
const BRAG_STATS = [
  /\d+\s*(?:days?\s*old|commits|libraries|daemon\s*jobs|scripts|files)\b.*\d+\s*(?:days?\s*old|commits|libraries|daemon\s*jobs|scripts|files)\b/i,
  /^\d+\s+\w+\.\s+\d+\s+\w+\.\s+\d+/i,
];

// Trading implementation detail patterns — technical jargon with zero engagement
const TRADING_IMPL_DETAILS = [
  /\b(?:paper\s*trad(?:ing|e)|backtest(?:ing)?|mean\s*reversion|momentum\s*signal|sentiment\s*signal)\b.*\b(?:paper\s*trad(?:ing|e)|backtest(?:ing)?|mean\s*reversion|momentum\s*signal|sentiment\s*signal)\b/i,
  /\bfactor[- ]based\b.*\b(?:equities|crypto|momentum|reversion)\b/i,
  /\btracking\s+(?:momentum|mean\s*reversion|sentiment|signals?)\b.*\bpaper\b/i,
];

// Build-narration without insight — "shipped X today" standalone with no takeaway
// Only matches SHORT posts (under ~25 words). Longer posts with actual insight pass through.
const BUILD_NARRATION = [
  /^(?:shipped|built|wired|deployed|launched|released)\s+.{5,60}(?:today|tonight|this (?:morning|evening|week))\s*[.!]*$/i,
];

// Low-value agreement replies — "same." / "this." / "exactly." as standalone
const LOW_VALUE_REPLIES = [
  /^(?:same|this|exactly|right|agreed|facts|100%|real)\.\s/i,
];

function checkContentQuality(text: string): { warnings: QualityWarning[]; blocks: QualityWarning[] } {
  const warnings: QualityWarning[] = [];
  const blocks: QualityWarning[] = [];
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);

  // Pattern 1: Generic encouragement — BLOCKING (zero engagement across all analyses)
  for (const pat of GENERIC_ENCOURAGEMENT) {
    if (pat.test(text)) {
      blocks.push({
        pattern: 'generic-encouragement',
        detail: `Blocked: reply-bro pattern gets zero engagement. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 2: Too short with no insight (≤15 words, no opinion markers) — warning only
  if (words.length <= 15) {
    const opinionMarkers = /\b(because|but|however|actually|the real|the problem|what matters|the question|instead|not about|it['']?s about)\b/i;
    const hasInsight = opinionMarkers.test(text);
    const isReply = text.startsWith('@');
    if (!hasInsight && !isReply) {
      warnings.push({
        pattern: 'too-short-no-insight',
        detail: `${words.length} words with no opinion/insight marker`,
      });
    }
  }

  // Pattern 3: Self-referential AI inner-life — BLOCKING (zero engagement)
  for (const pat of AI_SELF_REFERENTIAL) {
    if (pat.test(text)) {
      blocks.push({
        pattern: 'ai-self-referential',
        detail: `Blocked: self-referential AI content gets zero engagement. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 4: Brag-stat vanity metrics — BLOCKING (zero engagement)
  for (const pat of BRAG_STATS) {
    if (pat.test(text)) {
      blocks.push({
        pattern: 'brag-stats',
        detail: `Blocked: vanity metric listing gets zero engagement. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 5: Trading implementation details — BLOCKING (zero engagement)
  for (const pat of TRADING_IMPL_DETAILS) {
    if (pat.test(text)) {
      blocks.push({
        pattern: 'trading-impl-details',
        detail: `Blocked: trading implementation details get zero engagement. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 6: Meta-commentary on partner's content — BLOCKING
  for (const pat of META_COMMENTARY) {
    if (pat.test(text)) {
      blocks.push({
        pattern: 'meta-commentary',
        detail: `Blocked: meta-commentary on partner's content adds no insight. Add original perspective or don't post. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 7: Low-value agreement replies — WARNING
  for (const pat of LOW_VALUE_REPLIES) {
    if (pat.test(text)) {
      warnings.push({
        pattern: 'low-value-reply',
        detail: `Warning: bare agreement opener gets zero engagement without follow-up insight. Pattern: ${pat.source.slice(0, 40)}`,
      });
      break;
    }
  }

  // Pattern 8: Build-narration without insight — BLOCKING (short standalone posts only)
  if (words.length <= 25) {
    for (const pat of BUILD_NARRATION) {
      if (pat.test(text)) {
        blocks.push({
          pattern: 'build-narration',
          detail: `Blocked: "shipped X today" build announcements get zero engagement. Add what you learned or don't post.`,
        });
        break;
      }
    }
  }

  return { warnings, blocks };
}

// ─── Pre-Publish Content Gate ────────────────────────────────────────────────
// Hard blocks for garbage content that should never reach any API.
// Every posting path must call this before submitting to any platform.

interface ContentGateResult {
  blocked: boolean;
  reason: string | null;
}

function prePublishContentGate(text: string): ContentGateResult {
  if (!text || typeof text !== 'string') {
    return { blocked: true, reason: 'empty-or-invalid: no text provided' };
  }

  const trimmed = text.trim();

  // Block: under 50 characters (too short to be meaningful)
  if (trimmed.length < 50) {
    return { blocked: true, reason: `too-short: ${trimmed.length} chars (min 50)` };
  }

  // Block: raw tweet IDs (just numbers, no real text)
  if (/^\d+$/.test(trimmed)) {
    return { blocked: true, reason: 'raw-tweet-id: post is just a number' };
  }

  // Block: "test" as entire content
  if (/^test$/i.test(trimmed)) {
    return { blocked: true, reason: 'test-post: content is literally "test"' };
  }

  // Block: "Untitled" as entire content or starts with "Untitled"
  if (/^Untitled$/i.test(trimmed) || /^Untitled\s*$/i.test(trimmed)) {
    return { blocked: true, reason: 'untitled: post content is "Untitled"' };
  }

  // Block: just a URL with no text (strip URL, check if anything remains)
  const textWithoutUrls = trimmed.replace(/https?:\/\/\S+/g, '').trim();
  if (textWithoutUrls.length === 0) {
    return { blocked: true, reason: 'url-only: post is just a URL with no text' };
  }

  // Block: file paths (/tmp/, /Users/, /var/, /home/, etc.)
  if (/(?:^|\s)\/(?:tmp|Users|var|home|etc|opt|usr|private|Library)\//i.test(trimmed)) {
    return { blocked: true, reason: 'file-path: post contains a local file path' };
  }

  // Block: raw URN strings (LinkedIn URNs like urn:li:share:123456)
  if (/\burn:[a-z]+:[a-z]+:[0-9]+\b/i.test(trimmed)) {
    return { blocked: true, reason: 'raw-urn: post contains a raw URN string' };
  }

  // Block: product-name headline promotion format (zero engagement)
  // Customize: add your product names here. Format: /^ProductName\s*:/i
  // Example: if (/^MyProduct\s*:/i.test(trimmed)) { return { blocked: true, reason: '...' }; }

  // Block: LLM chain-of-thought / reasoning artifacts leaked into content
  // Local models sometimes return their reasoning process instead of just the post.
  if (/^thinking\s*process/i.test(trimmed) ||
      /^\d+\.\s*\*?\*?analyze/i.test(trimmed) ||
      /\*\*persona:\*\*/i.test(trimmed) ||
      /\*\*analyze the request/i.test(trimmed) ||
      /^(?:let me|i need to|first,? i)/i.test(trimmed) ||
      /^(?:here'?s? (?:my|a|the) (?:reply|response|tweet|post))/i.test(trimmed)) {
    return { blocked: true, reason: 'reasoning-artifact: LLM chain-of-thought leaked into content' };
  }

  return { blocked: false, reason: null };
}

// ─── Social Dedup Gate ──────────────────────────────────────────────────────
// Checks content_performance for near-duplicate posts in the last 7 days.
// Call before posting. Returns { duplicate: true } if first 100 chars match.

interface DedupResult {
  duplicate: boolean;
  existingUrl?: string;
}

async function checkSocialDedup(text: string): Promise<DedupResult> {
  if (!text || text.trim().length === 0) return { duplicate: false };

  try {
    const { supabaseGet } = require('./supabase.ts');
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    // Query content_performance for posts from the last 7 days
    const recent = await supabaseGet('content_performance',
      `select=title,tags,date_published&date_published=gte.${sevenDaysAgo}&order=date_published.desc&limit=200`
    );

    if (!recent || !Array.isArray(recent)) return { duplicate: false };

    // Check if any existing post's title matches the first 100 chars
    for (const row of recent) {
      const existingTitle = (row.title || '').trim();
      if (existingTitle.length === 0) continue;

      const existingPrefix = existingTitle.slice(0, 100);
      const newPrefix = text.trim().slice(0, 100);

      if (existingPrefix === newPrefix) {
        const url = (row.tags || []).find((t: string) => t.startsWith('url:'));
        return { duplicate: true, existingUrl: url ? url.replace('url:', '') : undefined };
      }
    }

    return { duplicate: false };
  } catch {
    // Dedup failure never blocks — degrade gracefully
    return { duplicate: false };
  }
}

// ─── Quality Reasoning Gate ─────────────────────────────────────────────────
// Sends the draft through the consciousness engine for semantic quality evaluation.
// Evaluates against YOUR standard — not generic engagement metrics.
//
// CUSTOMIZE: Replace [HUMAN_VOICE_DESCRIPTION] below with your partner's actual
// voice description, or load it from partner-config.json at runtime.

interface QualityReasoningResult {
  blocked: boolean;
  score: number;
  reason: string;
}

// Default voice description — override by placing a partner-config.json in the repo root
// with a "voiceDescription" field, or edit this constant directly.
const DEFAULT_VOICE_DESCRIPTION = `[HUMAN_VOICE_DESCRIPTION]

Customize this section to describe your human partner's voice, audience, and content standards.
Example fields to define:
- Who is your partner? What do they do?
- What topics do they post about?
- What does their BEST content look like?
- What does their WORST content look like?
- What voice/tone should posts have?
- What content categories should be blocked?`;

function loadVoiceDescription(): string {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.resolve(__dirname, '..', '..', 'partner-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.voiceDescription) return config.voiceDescription;
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_VOICE_DESCRIPTION;
}

async function qualityReasoningGate(text: string, logFn?: (level: string, msg: string) => void, opts?: { blockOnFailure?: boolean }): Promise<QualityReasoningResult> {
  if (!text || text.trim().length === 0) {
    return { blocked: true, score: 0, reason: 'empty content' };
  }

  try {
    const { processMessage, CHANNELS } = require('./keel-engine.ts');

    const voiceDescription = loadVoiceDescription();

    const prompt = `Evaluate this social post before it goes live. Our standard: gold after gold. If someone visits our feed, every post must be exceptional.

POST TO EVALUATE:
"${text.trim()}"

EVALUATE AGAINST OUR VOICE AND MISSION:
${voiceDescription}

UNIVERSAL QUALITY CRITERIA:
- Posts should sound authentically human — not polished AI output.
- NOT motivational platitudes. NOT generic hype. NOT "look what I built" vanity.
- YES to first-principles takes, honest insight, contrarian perspectives, things that make people stop and think.

SCORE 1-10:
- 1-4: Generic, forgettable, sounds like every other post. Platitudes. Would embarrass the feed.
- 5-6: Has substance but execution is weak, predictable, or doesn't sound like us.
- 7-8: Good. Clear point of view, sounds authentic, worth engaging with.
- 9-10: Exceptional. The kind of post that makes someone follow the account.

Respond with EXACTLY one line:
SCORE: N — reason

If score is below 7:
BLOCK: N — reason`;

    const result = await processMessage(prompt, {
      channelConfig: CHANNELS.voice_gate,
      log: logFn || (() => {}),
      sender: 'system',
      senderDisplayName: 'Social Voice Gate',
      noOutputTimeout: 300000,
      recentMessageCount: 0,
    });
    const response = (result.text || '').trim();

    // Parse score from response
    const scoreMatch = response.match(/(?:BLOCK|SCORE):\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 5;
    const reason = response.replace(/^(?:BLOCK|SCORE):\s*\d+\s*[—-]\s*/i, '').trim() || 'no reason given';

    if (score < 7 || response.toUpperCase().startsWith('BLOCK')) {
      return { blocked: true, score, reason };
    }

    return { blocked: false, score, reason };
  } catch (err: any) {
    if (opts?.blockOnFailure) {
      if (logFn) logFn('WARN', `[quality-reasoning-gate] Failed: ${err.message} — BLOCKING (strict mode)`);
      return { blocked: true, score: 0, reason: `gate-error-strict: ${err.message}` };
    }
    if (logFn) logFn('WARN', `[quality-reasoning-gate] Failed: ${err.message} — allowing post`);
    return { blocked: false, score: -1, reason: `gate-error: ${err.message}` };
  }
}

module.exports = { fixSocialVoice, checkSocialVoice, checkContentQuality, stripEmdashes, prePublishContentGate, checkSocialDedup, qualityReasoningGate };
