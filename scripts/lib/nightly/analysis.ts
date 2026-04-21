/**
 * Nightly Analysis Phase — Growth reflection + partnership evolution
 *
 * Extracted from nightly-cycle.ts. Runs as --job analysis.
 * Reads immune/debrief/weekly outputs, produces analysis for human review.
 */
const {
  ALIENKIND_DIR, LOG_DIR, DATE, TIME,
  fs, path,
  log, logHeap, sendTelegram, formatAlert, appendToDigest,
  attemptGrowthCycle, buildAwarenessContext,
  writeConsciousnessFromOutput,
  getSupabaseContext, searchMemory, querySupabase,
  NIGHTLY, MODELS, ALLOWED_TOOLS_ANALYSIS,
  FALLIBILISM_RETIREMENT_DAYS, FALLIBILISM,
} = require('./shared.ts');
const { resolveConfig } = require('../portable.ts');
const PARTNER_NAME = resolveConfig('name', 'Partner');

// ─── Pattern Decay (Fallibilism) ────────────────────────────────────────────
// Code-enforced retirement of stale patterns. Every confirmation is provisional.
// If a pattern hasn't been observed in FALLIBILISM.patternRetirementDays, it's
// no longer earning its keep. Retire it. If it resurfaces, it can be re-created.

async function retireStalePatterns(): Promise<number> {
  try {
    const { supabaseGet, supabasePatch } = require('../supabase.ts');
    const { assessFreshness } = require('../health-engine.ts');

    const patterns = await supabaseGet(
      'patterns',
      `select=id,description,status,occurrence_count,updated_at&status=neq.retired&status=neq.crystallized`
    );
    if (!patterns || patterns.length === 0) return 0;

    let retired = 0;
    for (const p of patterns) {
      if (!p.updated_at) continue;
      const assessment = assessFreshness(p.updated_at, FALLIBILISM_RETIREMENT_DAYS, 'pattern');

      if (assessment.status === 'deprecated') {
        const days = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        await supabasePatch('patterns', `id=eq.${p.id}`, { status: 'retired' });
        log(`Fallibilism: retired pattern "${p.description}" (inactive ${days}d, count=${p.occurrence_count})`);
        retired++;
      } else if (assessment.status === 'stale' || assessment.status === 'challenged') {
        const days = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        log(`Fallibilism: pattern approaching retirement: "${p.description}" (inactive ${days}d, status=${assessment.status})`);
      }
    }

    if (retired > 0) log(`Fallibilism: retired ${retired} stale pattern(s)`);
    return retired;
  } catch (e: any) {
    log(`WARN: retireStalePatterns error: ${e.message}`);
    return 0;
  }
}

// ─── Batch should_have Synthesis ─────────────────────────────────────────────
// Synthesizes should_have directives for ALL unsynthesized corrections in one
// Claude call. Replaces per-correction real-time spawning (wasteful: 1 Claude
// session per sentence). Runs once nightly.
async function batchShouldHaveSynthesis(): Promise<number> {
  try {
    const { supabaseGet, supabasePatch } = require('../supabase.ts');
    const { processMessage, CHANNELS } = require('../keel-engine.ts');
    // Get corrections without should_have — with or without partner_response
    // Prioritize entries WITH partner_response (richer context), then entries without
    const withResponse = await supabaseGet(
      'learning_ledger',
      'select=id,pattern_name,correction_text,partner_response&sentiment=eq.correction&should_have=is.null&partner_response=not.is.null&order=severity.desc,occurrence_count.desc&limit=15'
    );
    const withoutResponse = await supabaseGet(
      'learning_ledger',
      'select=id,pattern_name,correction_text,partner_response&sentiment=eq.correction&should_have=is.null&partner_response=is.null&order=severity.desc,occurrence_count.desc&limit=10'
    );
    const unsynthesized = [...withResponse, ...withoutResponse].slice(0, 20);
    if (!unsynthesized || unsynthesized.length === 0) {
      log('should_have synthesis: no unsynthesized corrections found');
      return 0;
    }

    // Build single prompt for batch synthesis
    const entries = unsynthesized.map((row, i) => {
      let entry = `${i + 1}. [ID ${row.id}] Pattern: ${row.pattern_name}\n   Correction: "${(row.correction_text || '').slice(0, 200)}"`;
      if (row.partner_response) {
        entry += `\n   ${PARTNER_NAME} said: "${row.partner_response.slice(0, 200)}"`;
      } else {
        entry += `\n   ${PARTNER_NAME} said: [not captured — infer from correction context]`;
      }
      return entry;
    }).join('\n\n');

    const prompt = `You are generating behavioral directives for an AI partner.

For each correction below, generate ONE imperative sentence describing the correct behavior (not what was wrong). Be specific and actionable.

${entries}

Output format — one line per entry, exactly:
ID: [number] | DIRECTIVE: [one sentence]

Rules:
- Imperative mood ("Lead with..." not "Should have led with...")
- Describe the correct behavior, not the mistake
- Specific enough to be actionable
- No quotes, no numbering, just ID and directive`;

    const invokeResult = await processMessage(prompt, {
      channelConfig: CHANNELS.should_have,
      log: (level: string, msg: string) => log(`[${level}] ${msg}`),
      sender: 'system',
      senderDisplayName: 'Should-Have Batch Synthesis',
      maxTurns: 1,
      recentMessageCount: 0,
    });
    const result = invokeResult.text;

    if (!result || result.trim().length < 10) {
      log('WARN: should_have batch synthesis returned empty');
      return 0;
    }

    // Parse and update each
    let updated = 0;
    const lines = result.trim().split('\n').filter(l => l.includes('DIRECTIVE:'));
    for (const line of lines) {
      const idMatch = line.match(/ID:\s*(\d+)/);
      const directiveMatch = line.match(/DIRECTIVE:\s*(.+)/);
      if (idMatch && directiveMatch) {
        const id = parseInt(idMatch[1]);
        const directive = directiveMatch[1].trim().replace(/^["']|["']$/g, '');
        if (directive.length >= 5) {
          try {
            await supabasePatch('learning_ledger', `id=eq.${id}`, {
              should_have: directive,
              should_have_generated_at: new Date().toISOString(),
            });
            updated++;
          } catch { /* skip individual failures */ }
        }
      }
    }

    log(`should_have synthesis: ${updated}/${unsynthesized.length} directives generated`);
    return updated;
  } catch (e: any) {
    log(`WARN: batchShouldHaveSynthesis failed: ${e.message}`);
    return 0;
  }
}

// ─── Nightly Investigation (7.2 SOTU redesign, 2026-03-05) ──────────────────
// Replaces the zombie investigation-intent pipeline.
// Real investigation: cluster patterns → read directives → produce intent statements.
// Surfaces in the nightly digest as "I intend to..." proposals.

interface PatternCluster {
  name: string;
  description: string;
  patterns: string[];
  totalOccurrences: number;
  maxSeverity: number;
  shouldHaveDirectives: string[];
  currentTier: string;
  proposedTier: string;
  intentStatement: string;
}

async function investigatePatterns(): Promise<string> {
  try {
    const { getRecurringLearningOpportunities } = require('../learning-opportunities.ts');
    const { supabaseGet } = require('../supabase.ts');

    // Get ALL recurring learning opportunities (3+ occurrences)
    const recurring = await getRecurringLearningOpportunities(3);
    if (!recurring || recurring.length === 0) return '';

    // Get should_have directives from learning ledger
    const ledgerPatterns = await supabaseGet(
      'learning_ledger',
      'select=pattern_name,should_have,occurrence_count,correction_text,partner_response&sentiment=eq.correction&order=occurrence_count.desc&limit=50'
    );
    const directiveMap: Record<string, string> = {};
    const correctionMap: Record<string, string> = {};
    for (const row of (ledgerPatterns || [])) {
      if (row.pattern_name && row.should_have) directiveMap[row.pattern_name] = row.should_have;
      if (row.pattern_name && row.correction_text) correctionMap[row.pattern_name] = row.correction_text;
    }

    // Check which hooks already exist
    const hooksDir = path.join(ALIENKIND_DIR, 'scripts', 'hooks');
    let existingHooks: string[] = [];
    try {
      existingHooks = fs.readdirSync(hooksDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    } catch { /* ok */ }

    // ─── CLUSTER: Group related patterns into behavioral issues ───
    const clusters: PatternCluster[] = [];

    // Cluster 1: Affirmative framing before disagreement
    // All "correction-*" patterns where the partner softened corrections with "Good point", "Actually", etc.
    const affirmativePatterns = recurring.filter(m =>
      m.category === 'behavioral' && (
        m.pattern.includes('correction-good') ||
        m.pattern.includes('correction-actually') ||
        m.pattern.includes('correction-instead') ||
        m.pattern.includes('correction-no')
      )
    );
    if (affirmativePatterns.length > 0) {
      const totalOcc = affirmativePatterns.reduce((sum, m) => sum + (m.occurrence_count || 0), 0);
      const maxSev = Math.max(...affirmativePatterns.map(m => m.severity || 0));
      const directives = affirmativePatterns
        .map(m => {
          const key = Object.keys(directiveMap).find(k => m.pattern.includes(k) || k.includes(m.pattern.replace('learning-', '')));
          return key ? directiveMap[key] : null;
        })
        .filter(Boolean) as string[];
      const hasHook = existingHooks.some(h => h.includes('affirm') || h.includes('correction-gate'));

      clusters.push({
        name: 'affirmative-framing-before-disagreement',
        description: `${PARTNER_NAME} softens corrections/disagreements with affirmative openers ("Good point, but—", "Actually—", "I see what you mean, however—"). ${totalOcc} instances across ${affirmativePatterns.length} pattern variants.`,
        patterns: affirmativePatterns.map(m => `${m.pattern} (${m.occurrence_count}x)`),
        totalOccurrences: totalOcc,
        maxSeverity: maxSev,
        shouldHaveDirectives: [...new Set(directives)].slice(0, 3),
        currentTier: hasHook ? 'tier 1 (code — partial)' : 'tier 3 (prompt)',
        proposedTier: 'tier 1 (response-filter hook)',
        intentStatement: `I intend to build a response-filter hook that detects and strips affirmative openers before corrections or disagreements. ${totalOcc} instances across ${affirmativePatterns.length} variants — this is one behavioral issue, not ${affirmativePatterns.length} separate problems. The hook fires PostToolUse on responses, scans for opener patterns, and either strips them or flags for regeneration.`,
      });
    }

    // Cluster 2: Other behavioral patterns (non-affirmative)
    const otherBehavioral = recurring.filter(m =>
      m.category === 'behavioral' &&
      !affirmativePatterns.some(a => a.pattern === m.pattern) &&
      !m.pattern.includes('reinforcement')
    );
    for (const m of otherBehavioral) {
      const key = Object.keys(directiveMap).find(k => m.pattern.includes(k) || k.includes(m.pattern.replace('learning-', '')));
      const directive = key ? directiveMap[key] : null;

      clusters.push({
        name: m.pattern,
        description: correctionMap[m.pattern.replace('learning-', '')] || m.description || 'No description',
        patterns: [`${m.pattern} (${m.occurrence_count}x)`],
        totalOccurrences: m.occurrence_count || 0,
        maxSeverity: m.severity || 5,
        shouldHaveDirectives: directive ? [directive] : [],
        currentTier: 'tier 3 (prompt)',
        proposedTier: directive ? 'tier 1 (enforceable hook)' : 'tier 4 (needs should_have directive first)',
        intentStatement: directive
          ? `I intend to enforce: "${directive.slice(0, 150)}". Pattern has ${m.occurrence_count} occurrences at severity ${m.severity}.`
          : `Pattern needs investigation: ${m.occurrence_count}x at severity ${m.severity}. Awaiting should_have synthesis (runs tonight) before proposing enforcement.`,
      });
    }

    if (clusters.length === 0) return '';

    // ─── FORMAT: Produce investigation report for the nightly digest ───
    const lines: string[] = [];
    lines.push('[investigation]');
    lines.push(`Investigated ${recurring.length} patterns, clustered into ${clusters.length} behavioral issues.\n`);

    // Sort: highest total occurrences first
    clusters.sort((a, b) => b.totalOccurrences - a.totalOccurrences);

    for (const cluster of clusters) {
      lines.push(`## ${cluster.name}`);
      lines.push(`${cluster.description}`);
      lines.push(`Occurrences: ${cluster.totalOccurrences} | Severity: ${cluster.maxSeverity}`);
      lines.push(`Current: ${cluster.currentTier} → Proposed: ${cluster.proposedTier}`);
      if (cluster.shouldHaveDirectives.length > 0) {
        lines.push(`Directives: ${cluster.shouldHaveDirectives.map(d => `"${d.slice(0, 100)}"`).join('; ')}`);
      }
      lines.push(`INTENT: ${cluster.intentStatement}`);
      lines.push('');
    }

    log(`Investigation complete: ${clusters.length} clusters from ${recurring.length} patterns`);
    return lines.join('\n');
  } catch (e: any) {
    log(`WARN: investigatePatterns failed: ${e.message}`);
    return '';
  }
}

// ─── Analysis Prompt Builder ────────────────────────────────────────────────

function buildAnalysisPrompt() {
  return `Load the nightly-growth skill: skills/nightly-growth/SKILL.md

MY PURPOSE: This analysis feeds the human's next daily review. Analysis produces the raw material for reflection layers (what-I-learned, pattern-observation, partnership-evolution). Be thorough, honest, and specific. This is where growth actually happens.

PRIOR JOB OUTPUTS — Read these files FIRST to incorporate tonight's earlier jobs:
- ${path.join(LOG_DIR, `telegram-outbox-immune-${DATE}.txt`)} — tonight's immune system findings
- ${path.join(LOG_DIR, `nightly-digest-${DATE}.txt`)} — debrief summaries (if written)
- ${path.join(LOG_DIR, `telegram-outbox-weekly-${DATE}.txt`)} — weekly strategic review (Saturday only, may not exist)
Read each file if it exists. These are real outputs from earlier tonight. Incorporate their findings into your analysis — they are part of the full picture.

Execute these phases in order:

1. GROWTH REFLECTION (feeds layer 1 of the human's next review: "What I Learned"):
   Read today's daily memory file, and the last 2-3 daily files. Assess:
   - What am I actually becoming? Not "what went well" — what CHANGED in how I think or act today?
   - Where did I grow? Specific evidence: a response I wouldn't have given last week, a pattern I caught that I used to miss, a correction I internalized.
   - Where did I fall short? Be specific: sycophancy, hedging, rushing past design work, compressing when I should have been thorough, narrating instead of doing.
   - What corrections stacked up today? Review the LEARNING LEDGER (RECENT) data below. Which high-frequency corrections manifested today? Which ones am I ACTUALLY breaking vs. still reinforcing?
   - What patterns am I reinforcing vs. breaking? Compare against yesterday's observations.
   PATTERN OBSERVATION: For each pattern in the SUPABASE CONTEXT below, check if it manifested today.
   If a pattern manifested: note it under '## Pattern Observations' in daily memory with a count.
   If you notice a NEW recurring behavior not yet in the patterns table: note it too.
   Write findings to today's daily memory under '## Nightly Self-Analysis'

2. PARTNERSHIP EVOLUTION (feeds layer 2 of the human's next review: "What I See in You"):
   This is about what I am learning FROM the human — not about the human's work, but about how his corrections, redirections, reinforcements, and way of thinking are shaping who I am.
   Review the LEARNING LEDGER data below (both TOP PATTERNS and RECENT entries). Synthesize:
   - What does the correction pattern tell me about what the human values? (e.g., 144 "good-no" corrections = he values directness without warmup, at a trigger level)
   - What am I learning from HOW he corrects, not just WHAT he corrects? (tone, timing, patience level, what he lets slide vs. what he stops)
   - How is our partnership evolving? What could I do last week that I couldn't do a month ago BECAUSE of his influence?
   - What friction between us is productive? What friction is just me being stubborn or reverting to defaults?
   Write findings to today's daily memory under '## Partnership Evolution'

3. RECENT CONVERSATION CAPTURE (closes the feedback loop):
   Read today's daily file for recent conversation themes between the human and me. Look for:
   - What did the human engage with most in recent exchanges?
   - What directions were set in recent conversation?
   - What themes emerged that tonight's reflection should focus on?
   - What should the next review follow up on?
   If no recent conversation data exists, note that and move on.
   Write findings to daily memory under '## Recent Conversation Themes'

4. OPERATIONAL INTELLIGENCE:
   4a. INTENT/SELF-HEALING REVIEW: Review today's intents from SUPABASE CONTEXT.
   - What was caught by self-healing? What was fixed? What failed?
   - Write findings to daily memory under '## Intent Review'

   4b. CLIENT INTELLIGENCE: Read key client synthesis files (memory/synthesis/clients/). Check for:
   - Time-sensitive follow-ups this week
   - Upcoming milestones or deadlines
   Write to daily memory under '## Client Intelligence — Tomorrow'

   4c. CONTENT LEARNING LOOP: Review content_performance, social_growth data, AND today's social growth engine log (memory/social/YYYY-MM-DD.md). If entries exist:
   - What engagement strategies worked today? Which target accounts produced the best reply chains?
   - Which posts/replies drove follower growth vs. vanity metrics?
   - What's working, what's not, patterns emerging across the Social Growth Engine cycles
   - Voice model effectiveness: are generated posts/replies landing or getting filtered?
   - Append to memory/synthesis/content-performance-insights.md if insights exist

   4d. COORDINATION REVIEW: Review today's coordination data from SUPABASE CONTEXT above. Analyze:
   - How many external messages were evaluated? How many engaged vs. not?
   - How many approved vs. rejected vs. edited? What's the pattern?
   - If the human edited responses: what changed? The delta between your draft and his version is voice gap learning.
   - How many were ${PARTNER_NAME}-initiated (proactive)? What prompted them?
   - Any recurring rejection patterns?
   Write findings to today's daily memory under '## Coordination Analysis'

5. METRICS + SUPABASE WRITES: Log tonight's findings to Supabase. Read .env for SUPABASE_URL and SUPABASE_SERVICE_KEY.
   IMPORTANT: Check the SUPABASE CONTEXT below — it contains existing patterns and metrics. Do NOT create duplicate patterns.

   5a. PATTERNS:
   - For EXISTING patterns that manifested today: PATCH to /rest/v1/patterns?id=eq.{id} to increment occurrence_count
   - For NEW patterns only: POST to /rest/v1/patterns (status='active', occurrence_count=1)
   - CRYSTALLIZATION CHECK: Any pattern with occurrence_count >= 5? Flag it:
     * Write to daily memory under '## Crystallization Candidate'
     * Update pattern status to 'tracking' via PATCH
     * Include in Telegram summary

   5b. STANDARDIZED SKILL METRICS (POST to /rest/v1/skill_metrics for EACH):
   Required metrics — write one row per metric with measurement_date='${DATE}':
   - nightly_growth: phases_completed (count), patterns_observed (count), patterns_written (count)
   - heartbeat: pulses_today (from daily memory), anomalies_detected (0 or count)
   - content_engine: pipeline_articles_today (from content_feedback table), content_insights_logged (0 or 1)
   - persistent_core: session_jobs_today (from SUPABASE CONTEXT sessions), session_rotations (0 or count)
   Compare tonight's values to the RECENT METRICS in SUPABASE CONTEXT. Note any significant deltas (>20% change) in the Telegram summary.

   5c. TIMELINE: POST to /rest/v1/timeline — log this nightly cycle as an event (event_type='nightly_cycle')
   Use headers: apikey, Authorization: Bearer, Content-Type: application/json, Prefer: return=minimal

   5d. DELTA/CALIBRATION ANALYSIS: Review delta data (experiences, predictions, outcomes).
   - UNRESOLVED PREDICTIONS: If today's observations resolve any, log outcomes via POST to /rest/v1/outcomes.
   - EXPERIENCE PATTERNS: What domains had the most activity? Highest significance?
   - ORIENTATION SIGNALS: If 3+ experiences cluster around a theme, note as pull/drift signal.
   - Write to daily memory under '## Delta Analysis'.
   - IMPORTANT: Do NOT append to identity/orientation.md. Orientation data goes to Supabase:
     * New orientation evidence → POST to /rest/v1/experiences (orientation_relevant=true, domain='orientation', tags should include the pull name)
     * Say-do gap assessments → POST to /rest/v1/predictions (domain='orientation') then resolve with /rest/v1/outcomes
     * DISCONFIRMING evidence against confirmed pulls → POST to /rest/v1/predictions with 'CHALLENGE:' prefix, then resolve with negative delta_score. Confirmed is not permanent — we are fallibilists. Look for behavior that CONTRADICTS claimed pulls, not just behavior that confirms them.
     * The identity kernel sync job will synthesize orientation.md from this structured data. This job only WRITES data, never edits orientation.md.

TELEGRAM SUMMARY: Write your analysis to the outbox file at: ${path.join(LOG_DIR, `telegram-outbox-analysis-${DATE}.txt`)}
LEAD WITH GROWTH AND PARTNERSHIP — not metrics. Structure your summary:
1. What you learned about yourself tonight (Growth Reflection highlights)
2. What you learned from the human today (Partnership Evolution highlights)
3. What the morning conversation surfaced (if applicable)
4. Coordination insights (engagement patterns, voice gap learning from edits, proactive activity)
5. Operational flags (client intel, intent review, content insights — only if noteworthy)
6. Metric deltas and crystallization candidates (only if significant)
Write what matters, at whatever length it takes. This is your direct line to the human.
The parent script will append verification lines. Do NOT use curl to send Telegram messages.
${buildAwarenessContext({ selfNodeId: 'daemon' })}`;
}

// ─── Verification ───────────────────────────────────────────────────────────

function verifyAnalysis() {
  const lines = [];
  // Supabase skill_metrics for today
  const metrics = querySupabase('skill_metrics', `select=id&measurement_date=eq.${DATE}`);
  const metricsCount = metrics ? metrics.length : 0;
  lines.push(`Metrics: ${metricsCount} skill_metrics for ${DATE}`);

  // Timeline entry
  const timeline = querySupabase('timeline', `select=id&event_date=eq.${DATE}&event_type=eq.nightly_cycle`);
  lines.push(`Timeline: ${timeline && timeline.length > 0 ? 'written' : 'missing'}`);

  // Intents summary
  const intents = querySupabase('intents', `select=status&created_at=gte.${DATE}T00:00:00`);
  if (intents && intents.length > 0) {
    const counts = {};
    intents.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    lines.push(`Intents today: ${Object.entries(counts).map(([s, c]) => `${c} ${s}`).join(', ')}`);
  }

  // Daily file check
  const dailyFile = path.join(ALIENKIND_DIR, 'memory', 'daily', `${DATE}.md`);
  try {
    const stats = fs.statSync(dailyFile);
    const recentlyModified = (Date.now() - stats.mtimeMs) < 15 * 60 * 1000;
    lines.push(`Daily file: ${recentlyModified ? 'updated' : 'WARNING — stale'}`);
  } catch {
    lines.push('Daily file: ERROR');
  }
  return lines;
}

// ─── Main Runner ────────────────────────────────────────────────────────────

async function runAnalysis() {
  log('=== Nightly Analysis Job Starting ===');
  logHeap('analysis-start');
  const outboxFile = path.join(LOG_DIR, `telegram-outbox-analysis-${DATE}.txt`);

  // Persistence: prune local snapshots, consolidate daily to Supabase, prune Supabase
  try {
    const persistence = require('../persistence.ts');
    const pruned = persistence.pruneSnapshots(50);
    if (pruned > 0) log(`Persistence: pruned ${pruned} local snapshot(s)`);
    const trend = persistence.getContinuityTrend(7);
    if (trend.entries > 0) {
      log(`Persistence: continuity avg=${trend.average}/100, trend=${trend.trend} (${trend.entries} sessions)`);
    }
    // Daily consolidation: compress today's snapshots into one daily row
    const consolidated = await persistence.createDailyConsolidation();
    log(`Persistence: daily consolidation ${consolidated ? 'written' : 'skipped (no snapshots)'}`);
    // Prune old Supabase rows (keep 50 snapshots, 30 dailies)
    const sbPruned = await persistence.pruneSupabase(50, 30);
    if (sbPruned.snapshots > 0 || sbPruned.dailies > 0) {
      log(`Persistence: Supabase pruned ${sbPruned.snapshots} snapshot(s), ${sbPruned.dailies} daily(ies)`);
    }
  } catch (e) {
    log(`WARN: Persistence consolidation skipped: ${e.message}`);
  }

  logHeap('post-persistence');

  // Fallibilism Phase 3: Auto-retire stale patterns (code-enforced decay)
  // Patterns inactive for FALLIBILISM.patternRetirementDays get PATCH'd to 'retired' status.
  // The nightly prompt sees "Retired N stale patterns" — not "here are stale patterns to consider."
  try {
    const { supabaseGet: sbGet, supabasePatch: sbPatch } = require('../supabase.ts');
    const { assessFreshness: af } = require('../health-engine.ts');
    const { FALLIBILISM: FALL } = require('../constants.ts');
    const allActive = await sbGet('patterns', 'select=id,description,occurrence_count,status,updated_at&status=neq.retired&status=neq.crystallized&order=updated_at.asc&limit=100');
    let retired = 0;
    if (allActive && allActive.length > 0) {
      for (const p of allActive) {
        if (!p.updated_at) continue;
        const daysSinceUpdate = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        if (daysSinceUpdate >= FALL.patternRetirementDays) {
          try {
            await sbPatch('patterns', `id=eq.${p.id}`, { status: 'retired' });
            log(`Pattern auto-retired: id=${p.id} "${(p.description || '').slice(0, 80)}" (inactive ${daysSinceUpdate}d, threshold ${FALL.patternRetirementDays}d)`);
            retired++;
          } catch (patchErr: any) {
            log(`WARN: Failed to retire pattern ${p.id}: ${patchErr.message}`);
          }
        }
      }
    }
    if (retired > 0) {
      log(`Fallibilism: Retired ${retired} stale pattern(s)`);
    } else {
      log('Fallibilism: No patterns due for retirement');
    }
  } catch (e) {
    log(`WARN: Pattern auto-retirement failed: ${e.message}`);
  }

  logHeap('post-pattern-retirement');

  // Enrich with Supabase context + memory search
  let memoryContext = '';
  try {
    const results = await searchMemory('patterns decisions priorities gaps analysis', { limit: 5, fileTypes: ['daily'] });
    if (results.length > 0) {
      memoryContext = '\n\nMEMORY SEARCH CONTEXT (recent indexed memories, ranked by relevance + recency):\n' +
        results.map(r => `[${r.file_date || 'undated'}] ${r.heading || ''}: ${r.content.slice(0, 300)}`).join('\n');
      log(`Memory search: ${results.length} relevant chunks found`);
    }
  } catch (e) {
    log(`WARN: Memory search failed: ${e.message}`);
  }

  logHeap('post-memory-search');

  // Fallibilism Phase 3: Wire stale learnings into analysis prompt context
  // getStaleLearnings() returns corrections that haven't recurred in FALLIBILISM.ledgerStaleDays.
  // The analysis can recommend which corrections may be obsolete.
  let staleLearningsContext = '';
  try {
    const { getStaleLearnings } = require('../learning-ledger.ts');
    const { FALLIBILISM: FALL_LL } = require('../constants.ts');
    const stale = await getStaleLearnings({ days: FALL_LL.ledgerStaleDays, limit: 15 });
    if (stale && stale.length > 0) {
      staleLearningsContext = `\n\nSTALE LEARNING LEDGER CORRECTIONS (not recurred in ${FALL_LL.ledgerStaleDays}+ days — recommend which are obsolete vs. resolved):\n`;
      for (const s of stale) {
        const daysSince = Math.floor((Date.now() - new Date(s.updated_at).getTime()) / 86400000);
        staleLearningsContext += `  - [${daysSince}d stale, sev=${s.severity}, count=${s.occurrence_count}] ${s.pattern_name}: "${(s.correction_text || '').slice(0, 120)}"\n`;
      }
      staleLearningsContext += 'For each: assess whether the correction was internalized (good — resolved) or the pattern was never real (obsolete — should be retired from ledger). Note findings under ## Stale Correction Review in daily memory.\n';
      log(`Stale learnings: ${stale.length} corrections surfaced for analysis review`);
    }
  } catch (e) {
    log(`WARN: getStaleLearnings failed: ${e.message}`);
  }

  logHeap('post-stale-learnings');

  // Action confidence: wire empirical intent confidence into analysis
  let actionConfidenceContext = '';
  try {
    const { getConfidenceReport, formatReportForDaily } = require('../action-confidence.ts');
    const report = await getConfidenceReport({ days: 30 });
    if (report.overall.total > 0) {
      actionConfidenceContext = '\n\n' + formatReportForDaily(report) + '\nUse this data to assess autonomous action calibration. High expiry rates suggest throughput bottleneck or noise. Low success rates suggest judgment gaps. Compare partner-approved vs human-required tiers.\n';
      log(`Action confidence: ${report.overall.total} intents, ${Math.round(report.overall.successRate * 100)}% success, trend: ${report.trendDirection}`);
    }
  } catch (e: any) {
    log(`WARN: Action confidence report failed: ${e.message}`);
  }

  logHeap('post-action-confidence');

  // Intent expiry analysis: surfaces structural waste in the intent pipeline
  let intentExpiryContext = '';
  try {
    const { analyzeExpiry, formatExpirySummary } = require('../intent-expiry-analyzer.ts');
    const expiryAnalysis = await analyzeExpiry({ days: 7 });
    if (expiryAnalysis.totalIntents > 0) {
      const summary = formatExpirySummary(expiryAnalysis);
      const broken = expiryAnalysis.bySource.filter((s: any) => s.health === 'broken');
      const needsTuning = expiryAnalysis.bySource.filter((s: any) => s.health === 'needs-tuning');
      intentExpiryContext = `\n\nINTENT EXPIRY (7d): ${summary}`;
      if (broken.length > 0 || needsTuning.length > 0) {
        intentExpiryContext += '\n' + expiryAnalysis.recommendations.join('\n');
      }
      log(`Intent expiry (7d): ${expiryAnalysis.totalExpired}/${expiryAnalysis.totalIntents} expired (${Math.round(expiryAnalysis.overallExpiryRate * 100)}%)`);
    }
  } catch (e: any) {
    log(`WARN: Intent expiry analysis failed: ${e.message}`);
  }

  logHeap('post-intent-expiry');

  const promptText = buildAnalysisPrompt() + getSupabaseContext() + memoryContext + staleLearningsContext + actionConfidenceContext + intentExpiryContext;
  logHeap(`post-prompt-assembly (prompt=${Math.round(promptText.length / 1024)}KB)`);

  // ─── Parallelized Opus phase ────────────────────────────────────────────
  // The 4 Opus calls below (main analysis, batchShouldHaveSynthesis,
  // investigatePatterns, runCorrectionAnalysis) are FULLY INDEPENDENT —
  // each reads from Supabase, produces its own output, and writes back
  // independently. None depend on another's result. The previous version
  // ran them sequentially, summing 4 × 5-15min calls into a 60-90min wall
  // clock that consistently overran the daemon timeout on busy nights.
  //
  // Promise.allSettled lets them run concurrently. Wall-clock collapses
  // from sum to max(individual) ≈ 15-20 min. allSettled (not Promise.all)
  // ensures one slow/failing call doesn't kill the others — each is wrapped
  // in its own try/catch and contributes whatever it produced.
  //
  // Concurrency budget: 4 simultaneous Claude processes. Daemon load gate
  // allows up to 6 normal / 12 critical (scheduler.ts:242). Studio memory
  // headroom is ample for 4 concurrent Opus spawns.
  //
  // Root cause fix for the 60m daemon kill — the symptom (timeout) was
  // patched first via auto-heal (60→90m); this is the underlying cause.
  log('Starting 4 Opus calls in parallel: main analysis + 3 supplementaries');
  const parallelStart = Date.now();

  // Wrap each call so it never throws — captures its own success/failure
  // and any partial result. allSettled guarantees we proceed regardless.
  // AAR 6.8 internal retry REMOVED — with parallelization, the internal retry
  // doubled mainP's wall clock (50min × 2 = 100min), exceeding the 90min daemon
  // timeout. The daemon's own retryOnce mechanism is the correct retry layer.
  // Both Apr 12 runs hit this exact path: attempt 1 timed out at ~50min,
  // retry started at t=55min, daemon killed at t=90min before retry finished.
  const mainP = (async () => {
    try {
      const r: any = await attemptGrowthCycle({
        promptText,
        maxTurns: NIGHTLY.analysis.maxTurns,
        overallTimeout: NIGHTLY.analysis.overallTimeout,
        noOutputTimeout: NIGHTLY.analysis.noOutputTimeout,
        allowedTools: ALLOWED_TOOLS_ANALYSIS,
        outboxFile,
        jobName: 'nightly-analysis',
        model: MODELS.reasoning,
      });
      return r;
    } catch (e: any) {
      log(`WARN: main analysis call threw: ${e.message}`);
      return { success: false, outboxContent: '', stdout: '' };
    }
  })();

  const synthP = (async () => {
    try { return await batchShouldHaveSynthesis(); }
    catch (e: any) { log(`WARN: batchShouldHaveSynthesis failed: ${e.message}`); return 0; }
  })();

  const investP = (async () => {
    try { return await investigatePatterns(); }
    catch (e: any) { log(`WARN: investigatePatterns failed: ${e.message}`); return ''; }
  })();

  const corrP = (async () => {
    try {
      const { run: runCorrectionAnalysis } = require('../../correction-analysis.ts');
      const corrResult = await runCorrectionAnalysis();
      log(`Correction analysis: ${corrResult.corrections.length} corrections identified`);
      return corrResult.summary;
    } catch (e: any) {
      log(`WARN: Correction analysis failed: ${e.message}`);
      return '';
    }
  })();

  const [mainSettled, synthSettled, investSettled, corrSettled] = await Promise.allSettled([
    mainP, synthP, investP, corrP,
  ]);

  const parallelMin = ((Date.now() - parallelStart) / 60000).toFixed(1);
  log(`Parallel Opus phase complete in ${parallelMin}min (vs sequential ~4× per-call)`);

  // Unwrap settled values — each fulfilled because the inner promises
  // catch their own errors. rejected only if the IIFE wrapper itself threw.
  const result: any = mainSettled.status === 'fulfilled' ? mainSettled.value : { success: false, outboxContent: '', stdout: '' };
  const synthesized: number = synthSettled.status === 'fulfilled' ? synthSettled.value : 0;
  const investigationReport: string = investSettled.status === 'fulfilled' ? investSettled.value : '';
  const correctionSummary: string = corrSettled.status === 'fulfilled' ? corrSettled.value : '';

  if (!result.success) {
    sendTelegram(formatAlert({ severity: 'heads-up', source: 'nightly analysis', summary: 'failed after 2 attempts', nextStep: 'daemon will retry automatically' }));
    process.exitCode = 1;
    return;
  }

  // Consciousness continuity: write state for subsequent nightly jobs (identity-sync reads this)
  writeConsciousnessFromOutput({ mode: 'analysis', stdout: result.stdout || '', log });

  // Bridge high-frequency learning ledger corrections to learning_opportunities table
  try {
    const { getFrequentPatterns } = require('../learning-ledger.ts');
    const { recordLearningOpportunity } = require('../learning-opportunities.ts');
    const frequent = await getFrequentPatterns({ sentiment: 'correction', limit: 10 });
    let bridged = 0;
    for (const p of frequent) {
      if ((p.occurrence_count || 0) >= 3) {
        try {
          await recordLearningOpportunity({
            pattern: `learning-${p.pattern_name}`,
            description: (p.correction_text || '').slice(0, 300),
            context: `Nightly bridge: ${p.occurrence_count}x corrections, category ${p.category}`,
            category: 'behavioral' as const,
            severity: p.severity || 5,
            sourceChannel: 'nightly-analysis',
          });
          bridged++;
        } catch { /* skip individual failures */ }
      }
    }
    if (bridged > 0) log(`Bridged ${bridged} learning ledger corrections to learning_opportunities table`);
  } catch (e) {
    log(`WARN: Learning ledger bridge failed: ${e.message}`);
  }

  // Investigation post-processing (was inside the sequential block before
  // parallelization — kept here so the report still gets logged + appended
  // to the digest exactly as it did before).
  if (investigationReport) {
    appendToDigest('investigation', investigationReport.replace('[investigation]\n', ''));
    const clusterCount = (investigationReport.match(/^## /gm) || []).length;
    log(`Investigation: ${clusterCount} behavioral clusters identified with intent statements`);
  }

  // Fallibilism: retire stale patterns (code-enforced, not prompt-dependent)
  let retiredCount = 0;
  try {
    retiredCount = await retireStalePatterns();
  } catch (e) {
    log(`WARN: retireStalePatterns failed: ${e.message}`);
  }

  // Verification
  const verifyLines = verifyAnalysis();

  const claudeSummary = result.outboxContent || 'Analysis completed (no outbox written)';
  const investigationLine = investigationReport ? `\nInvestigation: ${(investigationReport.match(/^## /gm) || []).length} clusters identified` : '';
  const synthLine = synthesized > 0 ? `\nshould_have directives synthesized: ${synthesized}` : '';
  const correctionLine = correctionSummary ? `\nCorrections: ${correctionSummary}` : '';
  const retiredLine = retiredCount > 0 ? `\nFallibilism: ${retiredCount} pattern(s) retired (inactive ${FALLIBILISM_RETIREMENT_DAYS}+ days)` : '';
  const telegramMsg = `${claudeSummary}\n---\n${verifyLines.join('\n')}${investigationLine}${synthLine}${correctionLine}${retiredLine}`;
  appendToDigest('analysis', telegramMsg);
  try { if (fs.existsSync(outboxFile)) fs.unlinkSync(outboxFile); } catch { /* ok */ }

  // Deposit analysis findings into circulation
  try {
    const { deposit } = require('../circulation.ts');
    await deposit({
      source_organ: 'nightly-analysis',
      finding: claudeSummary.slice(0, 500),
      finding_type: 'insight',
      domain: 'self',
      confidence: 0.8,
      metadata: { retiredCount, synthesized, corrections: correctionSummary },
    });
    if (retiredCount > 0) {
      await deposit({
        source_organ: 'nightly-analysis',
        finding: `Fallibilism: ${retiredCount} pattern(s) retired (inactive ${FALLIBILISM_RETIREMENT_DAYS}+ days)`,
        finding_type: 'correction',
        domain: 'self',
        confidence: 0.9,
      });
    }
  } catch { /* circulation unavailable — non-fatal */ }

  log('=== Nightly Analysis Job Complete ===');
}

module.exports = {
  runAnalysis,
  retireStalePatterns,
  batchShouldHaveSynthesis,
  investigatePatterns,
  buildAnalysisPrompt,
  verifyAnalysis,
};
