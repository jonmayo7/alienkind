/**
 * Learning Ledger — Behavioral correction and reinforcement tracking for Keel.
 *
 * Captures patterns that the human corrects or reinforces. Upserts on repeat patterns
 * (increments occurrence_count). Enables frequency-weighted gap prioritization.
 *
 * Usage:
 *   const { logLearning, getFrequentPatterns, getRecentLearnings, searchLearnings } = require('./learning-ledger.ts');
 */

const { supabasePost, supabaseGet, supabasePatch } = require('./supabase.ts');

interface LogLearningParams {
  patternName: string;
  correctionText: string;
  context?: string;
  sourceChannel?: string;
  sessionId?: string;
  category?: 'behavioral' | 'technical' | 'communication' | 'prioritization';
  sentiment?: 'correction' | 'reinforcement';
  severity?: number;
  keelResponse?: string;
  shouldHave?: string;
  causalConfidence?: number; // 0-1: how confident is the causal attribution? Enables revision trajectories.
}

interface RecordCorrectionParams {
  pattern: string;
  correctionText: string;
  severity?: number;
  sourceChannel?: string;
  keelResponse?: string;
}

interface QueryOptions {
  category?: string;
  sentiment?: string;
  limit?: number;
  days?: number;
}

interface SearchOptions {
  limit?: number;
}

/**
 * Log a learning (correction or reinforcement).
 * Upsert: if pattern_name exists, increment occurrence_count + update text; else insert.
 * Fire-and-forget — returns ID or null.
 */
async function logLearning({
  patternName,
  correctionText,
  context,
  sourceChannel,
  sessionId,
  category,
  sentiment,
  severity,
  keelResponse,
  shouldHave,
  causalConfidence,
}: LogLearningParams): Promise<number | null> {
  if (!patternName || !correctionText) {
    if (typeof console !== 'undefined') console.warn(`[learning-ledger] logLearning skipped: missing ${!patternName ? 'patternName' : 'correctionText'}`);
    return null;
  }
  try {
    // Check if pattern already exists
    const existing = await supabaseGet(
      'learning_ledger',
      `select=id,occurrence_count&pattern_name=eq.${encodeURIComponent(patternName)}&limit=1`
    );

    if (existing && existing.length > 0) {
      const row = existing[0];
      const existingText = (row.correction_text || '').slice(0, 100).toLowerCase();
      const newText = correctionText.slice(0, 100).toLowerCase();
      const isSameContent = existingText === newText || (existingText.length > 20 && newText.includes(existingText.slice(0, 40)));

      if (isSameContent) {
        // Same correction repeated — increment count
        const newCount = (row.occurrence_count || 1) + 1;
        const patch: Record<string, any> = {
          occurrence_count: newCount,
          source_channel: sourceChannel || null,
          session_id: sessionId || null,
        };
        if (keelResponse) patch.keel_response = keelResponse;
        if (shouldHave) patch.should_have = shouldHave;
        if (causalConfidence !== undefined) patch.causal_confidence = causalConfidence;
        await supabasePatch(`learning_ledger`, `id=eq.${row.id}`, patch);
      } else {
        // Same pattern, DIFFERENT correction text — create new entry to preserve history
        const rows = await supabasePost('learning_ledger', {
          pattern_name: patternName,
          correction_text: correctionText,
          context: context || null,
          source_channel: sourceChannel || null,
          session_id: sessionId || null,
          category: category || 'behavioral',
          sentiment: sentiment || 'correction',
          severity: severity || 5,
          occurrence_count: 1,
          keel_response: keelResponse || null,
          should_have: shouldHave || null,
          causal_confidence: causalConfidence !== undefined ? causalConfidence : null,
        }, { prefer: 'return=representation' });
        return rows && rows[0] ? rows[0].id : row.id;
      }

      // Bridge: mirror corrections with 3+ occurrences to learning_opportunities table.
      // Only bridge SPECIFIC patterns — practice categories (practice-*, validated-*)
      // are too broad for the learning_opportunities table. They're learning categories, not actionable
      // patterns. Also only bridge at the threshold (=== 3), not on every subsequent
      // occurrence — the learning_ledger is the source of truth for occurrence counts.
      const isCategory = patternName.startsWith('practice-') || patternName.startsWith('validated-');
      if ((sentiment === 'correction') && newCount === 3 && !isCategory) {
        try {
          const { recordLearningOpportunity } = require('./learning-opportunities.ts');
          await recordLearningOpportunity({
            pattern: `learning-${patternName}`,
            description: correctionText.slice(0, 300),
            context: context || sourceChannel || null,
            category: 'behavioral' as const,
            severity: severity || 5,
            sourceChannel: sourceChannel || 'learning-ledger',
          });
        } catch {
          // Non-fatal — don't break learning ledger
        }
      }

      return row.id;
    }

    // Insert new
    const rows = await supabasePost('learning_ledger', {
      pattern_name: patternName,
      correction_text: correctionText,
      context: context || null,
      source_channel: sourceChannel || null,
      session_id: sessionId || null,
      category: category || 'behavioral',
      sentiment: sentiment || 'correction',
      severity: severity || 5,
      occurrence_count: 1,
      keel_response: keelResponse || null,
      should_have: shouldHave || null,
      causal_confidence: causalConfidence !== undefined ? causalConfidence : null,
    }, { prefer: 'return=representation' });

    return rows && rows[0] ? rows[0].id : null;
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[learning-ledger] logLearning failed:', err.message);
    return null;
  }
}

/**
 * Get most frequent patterns, ordered by occurrence_count desc.
 */
async function getFrequentPatterns(opts: QueryOptions = {}): Promise<any[]> {
  try {
    let query = 'select=*&order=occurrence_count.desc';
    if (opts.category) query += `&category=eq.${opts.category}`;
    if (opts.sentiment) query += `&sentiment=eq.${opts.sentiment}`;
    query += `&limit=${opts.limit || 20}`;
    return await supabaseGet('learning_ledger', query);
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[learning-ledger] getFrequentPatterns failed:', err.message);
    return [];
  }
}

/**
 * Get recent learnings, ordered by created_at desc.
 */
async function getRecentLearnings(opts: QueryOptions = {}): Promise<any[]> {
  try {
    const days = opts.days || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    let query = `select=*&created_at=gte.${since}&order=created_at.desc`;
    if (opts.category) query += `&category=eq.${opts.category}`;
    if (opts.sentiment) query += `&sentiment=eq.${opts.sentiment}`;
    query += `&limit=${opts.limit || 50}`;
    return await supabaseGet('learning_ledger', query);
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[learning-ledger] getRecentLearnings failed:', err.message);
    return [];
  }
}

/**
 * Full-text search across pattern_name, correction_text, and context.
 */
async function searchLearnings(queryText: string, opts: SearchOptions = {}): Promise<any[]> {
  try {
    const tsQuery = queryText.trim().split(/\s+/).join(' & ');
    const limit = opts.limit || 20;
    const query = `select=*&fts=fts.${encodeURIComponent(tsQuery)}&order=occurrence_count.desc&limit=${limit}`;
    return await supabaseGet('learning_ledger', query);
  } catch (err: any) {
    if (typeof console !== 'undefined') console.error('[learning-ledger] searchLearnings failed:', err.message);
    return [];
  }
}

interface DetectionResult {
  sentiment: 'correction' | 'reinforcement';
  severity: number;
  signalWords: string[];
  behaviorCategory: string;
}

/**
 * Map signal word combinations to a positive-practice behavioral category.
 * Categories describe WHAT practice to cultivate, not what failure occurred.
 * Positive framing: when surfaced at boot, these prime toward practice, not avoidance.
 */
function classifyBehaviorCategory(
  signalWords: string[],
  sentiment: 'correction' | 'reinforcement',
  correctionSignals: number,
  redirectionSignals: number,
  reinforcementSignals: number,
): string {
  const lc = signalWords.map(w => w.toLowerCase());
  const has = (word: string) => lc.some(w => w.includes(word));

  if (sentiment === 'reinforcement') {
    if (has('perfect') || has('nailed') || has('beautiful')) return 'excellence-confirmed';
    if (has('exactly') || has('right')) return 'pattern-validated';
    return 'practice-affirmed';
  }

  // Corrections → positive-practice equivalents
  if (has('stop') || has("don't") || has('dont') || has('never')) return 'boundary-recognition';
  if (has('i said') || has('i meant')) return 'active-listening';
  if (has('wrong') && (has("that's") || has('thats'))) return 'accuracy-verification';
  if (has('wrong')) return 'precision-practice';
  if (has("that's not") || has('thats not') || has('not what')) return 'alignment-calibration';
  if (redirectionSignals > correctionSignals) return 'adaptive-response';
  if (has('actually') && correctionSignals === 0) return 'adaptive-response';
  if (has('instead') || has('try again') || has('what i want') || has('what i need')) return 'adaptive-response';
  return 'continuous-improvement';
}

/**
 * Build a positive-practice pattern name from detection result.
 * Format: "practice-{category}" for corrections, "validated-{category}" for reinforcements.
 * Surfaced at boot, these prime toward growth, not avoidance.
 */
function buildPatternName(detection: DetectionResult): string {
  return `${detection.sentiment === 'reinforcement' ? 'validated' : 'practice'}-${detection.behaviorCategory}`;
}

// Signal patterns for regex-based correction/reinforcement detection (Phase 1)
const CORRECTION_SIGNALS = [
  /\bno\b/i, /\bwrong\b/i, /\bthat'?s not\b/i, /\bi said\b/i,
  /\bi meant\b/i, /\bstop doing\b/i, /\bdon'?t do that\b/i,
  /\bnever do\b/i, /\bwrong approach\b/i, /\bthat'?s wrong\b/i,
  // the human's actual correction patterns (learned 2026-03-19, pruned 2026-03-20):
  // Kept: emotional intensity signals unambiguously indicating corrections
  /\bpissed off\b/i, /\bfrustrat(?:ed|ing)\b/i,
  /\bis this a platitude\b/i,
  /\bam i misunderstanding\b/i, /\bi don'?t want\b/i,
  /\bwhy (?:do|did) you keep\b/i,
  /\bI did not choose\b/i,
  // Removed 2026-03-20 (false-positive magnets in technical discussion):
  // "root cause", "we need to fix", "how did we not", "broken", "you did",
  // "how will you", "shit", "troubled" — appear in normal non-correction context
];
const REDIRECTION_SIGNALS = [
  /\bactually\b/i, /\binstead\b/i, /\bwhat i want\b/i,
  /\btry again\b/i, /\bnot what i\b/i, /\bwhat i need\b/i,
  /\bthat'?s not (?:what|how)\b/i, /\bi'?m (?:saying|asking)\b/i,
  /\bnot necessarily\b/i, /\bi think we should\b/i,
];
const REINFORCEMENT_SIGNALS = [
  /\bperfect\b/i, /\bexactly\b/i, /\bthat'?s right\b/i,
  /\byes like that\b/i, /\bgood\b/i, /\bgreat job\b/i,
  /\bnailed it\b/i, /\bbeautiful\b/i,
  /\bthat sounds awesome\b/i, /\bhell (?:fuck )?ya\b/i,
];

/**
 * Detect correction, redirection, or reinforcement signals in a message.
 * Guard: signal must appear in first 60 chars OR 2+ signals must match.
 * Returns null if no confident detection.
 */
function detectCorrection(message: string): DetectionResult | null {
  if (!message || message.length < 2) return null;

  // Extract the human's actual message from system preambles.
  // System prompts contain signal words that cause false positives.
  // Multiple extraction strategies, from most to least specific.
  let text = message;

  // Strategy 1: Telegram prompt has "the human's message:" marker
  const humanMsgMarker = text.lastIndexOf("the human's message:");
  if (humanMsgMarker !== -1) {
    text = text.slice(humanMsgMarker + "the human's message:".length).trim();
  }
  // Strategy 2: Terminal sessions — the user's text is the actual message,
  // but hooks inject system context. If we see system preamble markers,
  // try to find the user's text after them.
  else if (text.includes('You are Keel') || text.includes('SessionStart:')) {
    // Channel prompts from keel-engine ("You are Keel. You are responding in the X channel.")
    // are pure system prompts with no user message — skip entirely
    if (text.startsWith('You are Keel. You are responding in')) {
      return null;
    }
    // Look for the last user-authored segment (after all system blocks)
    const segments = text.split(/(?:SessionStart:|UserPromptSubmit|<system-reminder>)/);
    const lastSegment = segments[segments.length - 1]?.trim();
    // If the last segment is still mostly system text, skip
    if (!lastSegment || lastSegment.length < 5 || lastSegment.includes('CLAUDE.md')) {
      return null;
    }
    text = lastSegment;
  }
  if (!text || text.length < 2) return null;

  // Guard: skip coaching transcript content — words like "perfect", "nailed it"
  // appear naturally in transcripts when clients are praised, contaminating the
  // learning ledger with false reinforcements. See: self-assessment Apr 8-9,
  // "validated-excellence-confirmed" inflated 50x by transcript language.
  const TRANSCRIPT_MARKERS = /\bTRANSCRIPT:|^Title:.*Recorded:|Participants:.*Speaker|Word count: \d+|client arc:/im;
  if (TRANSCRIPT_MARKERS.test(text)) return null;

  const startSlice = text.slice(0, 60);
  const matchedSignals: { word: string; sentiment: string }[] = [];

  for (const rx of CORRECTION_SIGNALS) {
    const m = text.match(rx);
    if (m) matchedSignals.push({ word: m[0], sentiment: 'correction' });
  }
  for (const rx of REDIRECTION_SIGNALS) {
    const m = text.match(rx);
    if (m) matchedSignals.push({ word: m[0], sentiment: 'redirection' });
  }
  for (const rx of REINFORCEMENT_SIGNALS) {
    const m = text.match(rx);
    if (m) matchedSignals.push({ word: m[0], sentiment: 'reinforcement' });
  }

  if (matchedSignals.length === 0) {
    // Regex found nothing. Run 7B classifier as secondary detection.
    // If the 7B detects a correction regex missed, log it with source='semantic'.
    // Non-blocking, fire-and-forget — doesn't delay the hook.
    if (text.length > 30) {
      try {
        const http = require('http');
        const prompt = `Classify this message from a human to their AI partner. Is it:
- CORRECTION: the human is correcting a mistake, redirecting behavior, or expressing dissatisfaction
- REINFORCEMENT: the human is praising, confirming, or encouraging a behavior
- NEUTRAL: neither correction nor reinforcement

Reply with ONLY one word: CORRECTION, REINFORCEMENT, or NEUTRAL

Message: ${text.slice(0, 500)}`;

        const req = http.request({
          hostname: '127.0.0.1', port: 8000, path: '/v1/chat/completions',
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          timeout: 2000,
        }, (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => {
            try {
              const response = JSON.parse(data).choices?.[0]?.message?.content?.trim().toUpperCase() || '';
              if (response.startsWith('CORRECTION') || response.startsWith('REINFORCEMENT')) {
                // Log as a file for the training pipeline to pick up
                const fs = require('fs');
                const logPath = require('path').resolve(__dirname, '..', '..', 'logs', 'semantic-corrections.jsonl');
                fs.appendFileSync(logPath, JSON.stringify({
                  timestamp: new Date().toISOString(),
                  classification: response.startsWith('CORRECTION') ? 'correction' : 'reinforcement',
                  source: 'vllm-mlx-7b',
                  text: text.slice(0, 300),
                  regex_missed: true,
                }) + '\n');
              }
            } catch { /* best-effort */ }
          });
        });
        req.on('error', () => {});
        req.write(JSON.stringify({
          model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
          messages: [{ role: 'user', content: prompt }],
          stream: false, temperature: 0, max_tokens: 5,
        }));
        req.end();
      } catch { /* never block */ }
    }
    return null;
  }

  // Guard: require signal in first 60 chars OR 2+ signals total
  const hasEarlySignal = matchedSignals.some(s => startSlice.match(new RegExp(s.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')));
  if (!hasEarlySignal && matchedSignals.length < 2) return null;

  // Determine dominant sentiment
  const corrections = matchedSignals.filter(s => s.sentiment === 'correction');
  const redirections = matchedSignals.filter(s => s.sentiment === 'redirection');
  const reinforcements = matchedSignals.filter(s => s.sentiment === 'reinforcement');

  let sentiment: 'correction' | 'reinforcement';
  let severity: number;

  if (corrections.length >= reinforcements.length && corrections.length >= redirections.length) {
    sentiment = 'correction';
    // Variable severity: single signal = mild, multiple = stronger
    severity = corrections.length >= 3 ? 8 : corrections.length >= 2 ? 6 : 4;
  } else if (redirections.length > reinforcements.length) {
    sentiment = 'correction'; // redirections are soft corrections
    severity = redirections.length >= 2 ? 5 : 3;
  } else {
    sentiment = 'reinforcement';
    severity = reinforcements.length >= 3 ? 5 : 3;
  }

  const signalWords = matchedSignals.map(s => s.word);
  const behaviorCategory = classifyBehaviorCategory(
    signalWords,
    sentiment,
    corrections.length,
    redirections.length,
    reinforcements.length,
  );

  // Guard: generic "continuous-improvement" fallback is the catch-all for unclassified
  // corrections. With broad CORRECTION_SIGNALS, 2 signals in normal conversation is common
  // (e.g., "no" + "root cause" in technical discussion). Require 3+ correction signals
  // for the unclassified fallback to fire — ensures only genuine multi-signal corrections
  // make it through. Threshold raised 2026-03-20 after self-assessment found 93 false
  // positives inflating correction rate from ~42% to 86%.
  if (behaviorCategory === 'continuous-improvement' && corrections.length <= 2) {
    return null;
  }

  return {
    sentiment,
    severity,
    signalWords,
    behaviorCategory,
  };
}

/**
 * Convenience wrapper for logging corrections from non-hook contexts
 * (Telegram affirmation detection, Discord comms gate, etc.).
 */
async function recordCorrection({
  pattern,
  correctionText,
  severity,
  sourceChannel,
  keelResponse,
}: RecordCorrectionParams): Promise<number | null> {
  return logLearning({
    patternName: pattern,
    correctionText,
    category: 'behavioral',
    sentiment: 'correction',
    severity: severity || 5,
    sourceChannel: sourceChannel || 'unknown',
    keelResponse: keelResponse || undefined,
  });
}

/**
 * Get stale corrections — corrections that haven't recurred in N days.
 * These may be resolved (good) or dormant (review needed).
 * Fallibilism: corrections that stuck may themselves be wrong.
 */
async function getStaleLearnings(opts: { days?: number; limit?: number } = {}): Promise<any[]> {
  const staleDays = opts.days || 60;
  const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
  try {
    return await supabaseGet(
      'learning_ledger',
      `select=id,pattern_name,correction_text,occurrence_count,severity,updated_at&sentiment=eq.correction&updated_at=lt.${cutoff}&order=occurrence_count.desc&limit=${opts.limit || 20}`
    );
  } catch (err: any) {
    if (typeof console !== 'undefined') console.warn(`[learning-ledger] getStaleLearnings failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  logLearning,
  recordCorrection,
  getFrequentPatterns,
  getRecentLearnings,
  getStaleLearnings,
  searchLearnings,
  detectCorrection,
  buildPatternName,
};
