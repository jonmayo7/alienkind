/**
 * Learning Opportunities — structured pattern tracking with frequency analysis.
 *
 * Records learning opportunities by pattern name. Upserts on repeat patterns
 * (increments occurrence_count rather than duplicating rows).
 *
 * Boot-time query surfaces patterns with >= 3 occurrences
 * as candidates for soul directive promotion.
 *
 * Intent #31 from identity sync 2026-02-27.
 *
 * Usage:
 *   const { recordLearningOpportunity, getRecurringLearningOpportunities, markPromoted } = require('./learning-opportunities.ts');
 *   await recordLearningOpportunity({ pattern: 'defer-instead-of-fix', description: '...', severity: 7 });
 *   const recurring = await getRecurringLearningOpportunities(3); // patterns with 3+ occurrences
 */

const { supabaseGet, supabasePost, supabasePatch } = require('./supabase.ts');
const { createIntent, approveIntent, startExecution } = require('./intents.ts');

interface LearningOpportunityInput {
  pattern: string;
  description?: string;
  context?: string;
  category?: 'behavioral' | 'technical' | 'communication' | 'prioritization' | 'decision-making' | 'execution' | 'memory';
  severity?: number;
  sourceChannel?: string;
  sessionId?: string;
}

interface RecurringLearningOpportunity {
  id: number;
  pattern: string;
  occurrence_count: number;
  severity: number;
  category: string;
  description: string | null;
  first_seen_at: string;
  last_occurred_at: string;
  promoted_to_soul: boolean;
}

/**
 * Record a learning opportunity. If the pattern already exists, increment occurrence_count.
 * If new, create with count=1.
 */
async function recordLearningOpportunity({
  pattern,
  description,
  context,
  category = 'behavioral',
  severity = 5,
  sourceChannel,
  sessionId,
}: LearningOpportunityInput): Promise<void> {
  // Check if pattern exists
  const existing = await supabaseGet(
    'learning_opportunities',
    `pattern=eq.${encodeURIComponent(pattern)}&select=id,occurrence_count&limit=1`
  );

  if (existing && existing.length > 0) {
    // Upsert: increment occurrence_count, update last_occurred_at and context
    const updates: Record<string, any> = {
      occurrence_count: existing[0].occurrence_count + 1,
      last_occurred_at: new Date().toISOString(),
    };
    if (context) updates.context = context;
    if (description) updates.description = description;
    if (sessionId) updates.session_id = sessionId;
    if (sourceChannel) updates.source_channel = sourceChannel;

    await supabasePatch('learning_opportunities', `id=eq.${existing[0].id}`, updates);
  } else {
    // New pattern
    await supabasePost('learning_opportunities', {
      pattern,
      description: description || null,
      context: context || null,
      category,
      severity,
      source_channel: sourceChannel || null,
      session_id: sessionId || null,
    });
  }
}

/**
 * Get recurring learning opportunities (occurrence_count >= minOccurrences).
 * Returns patterns not yet promoted to identity kernel directives, ordered by frequency then severity.
 */
async function getRecurringLearningOpportunities(minOccurrences: number = 3): Promise<RecurringLearningOpportunity[]> {
  const rows = await supabaseGet(
    'learning_opportunities',
    `occurrence_count=gte.${minOccurrences}&promoted_to_soul=eq.false&order=occurrence_count.desc,severity.desc&select=id,pattern,occurrence_count,severity,category,description,first_seen_at,last_occurred_at,promoted_to_soul`
  );
  return rows || [];
}

/**
 * Mark a pattern as promoted to identity kernel directives.
 */
async function markPromoted(pattern: string): Promise<void> {
  await supabasePatch('learning_opportunities', `pattern=eq.${encodeURIComponent(pattern)}`, {
    promoted_to_soul: true,
    promoted_at: new Date().toISOString(),
  });
}

// Maps intent source names to the script files that produce them
const SOURCE_FILE_MAP: Record<string, string> = {
  self_healing: 'scripts/daemon.ts',
  'identity-sync': 'scripts/nightly-cycle.ts',
  terminal: 'scripts/hooks/log-terminal-compute.ts',
  recurring_learning_opportunities: 'scripts/lib/learning-opportunities.ts',
};

/**
 * For intent-rejected-{source} patterns, gather the actual rejected intents
 * as evidence — what was proposed, why the human rejected it, and where the code lives.
 */
async function gatherRejectionEvidence(pattern: string): Promise<{
  diagnosis: string;
  evidence: any[];
  filesAffected: string[];
  enrichedAction: string;
} | null> {
  const sourceMatch = pattern.match(/^intent-rejected-(.+)$/);
  if (!sourceMatch) return null;

  const intentSource = sourceMatch[1];

  // Fetch last 5 rejected intents from this source
  let rejectedIntents: any[] = [];
  try {
    rejectedIntents = await supabaseGet(
      'intents',
      `source=eq.${encodeURIComponent(intentSource)}&status=eq.rejected&order=created_at.desc&limit=5&select=id,trigger_summary,proposed_action,human_feedback,created_at`
    ) || [];
  } catch {
    return null;
  }

  if (rejectedIntents.length === 0) return null;

  // Build diagnosis from rejection patterns
  const feedbacks = rejectedIntents
    .filter((i: any) => i.human_feedback)
    .map((i: any) => `  - Intent #${i.id}: "${i.human_feedback}"`);
  const summaries = rejectedIntents
    .map((i: any) => `  - #${i.id} (${i.created_at?.slice(0, 10)}): ${i.trigger_summary}`);

  const diagnosis = [
    `Source '${intentSource}' has ${rejectedIntents.length} recent rejection(s).`,
    '',
    'Rejected intents:',
    ...summaries,
    ...(feedbacks.length > 0 ? ['', "the human's feedback:", ...feedbacks] : []),
  ].join('\n');

  // Evidence array for structured storage
  const evidence = rejectedIntents.map((i: any) => ({
    intentId: i.id,
    triggerSummary: i.trigger_summary,
    proposedAction: (i.proposed_action || '').slice(0, 300),
    humanFeedback: i.human_feedback,
    createdAt: i.created_at,
  }));

  // Identify the source file
  const sourceFile = SOURCE_FILE_MAP[intentSource];
  const filesAffected = sourceFile ? [sourceFile] : [];

  // Build a concrete action plan
  const fileRef = sourceFile ? `Read ${sourceFile} to find the intent creation logic.` : `Identify which script creates intents with source '${intentSource}'.`;
  const feedbackSummary = feedbacks.length > 0
    ? `the human's rejections indicate: ${rejectedIntents.filter((i: any) => i.human_feedback).map((i: any) => i.human_feedback).join('; ')}.`
    : 'No explicit feedback on rejections — analyze the trigger_summary patterns for what was wrong.';

  const enrichedAction = [
    `INVESTIGATION STEPS:`,
    `1. ${fileRef}`,
    `2. Find where createIntent() is called and examine the trigger criteria.`,
    `3. ${feedbackSummary}`,
    `4. Determine if the source is: (a) triggering on the wrong conditions, (b) proposing actions that already exist, or (c) setting wrong priority/scope.`,
    `5. Propose specific code changes to fix the calibration, OR recommend disabling this intent source if it's not producing value.`,
    `6. Report findings to the human with 2-3 concrete recommended actions.`,
  ].join('\n');

  return { diagnosis, evidence, filesAffected, enrichedAction };
}

/**
 * Check recurring learning opportunities and create intents for patterns hitting 3+ occurrences.
 * Deduplicates against existing non-terminal intents for the same pattern.
 * For intent-rejection patterns, enriches with actual rejection evidence.
 */
async function checkRecurringLearningOpportunities(): Promise<any[]> {
  // AAR 7.1 gate REMOVED — intent executor is wired and working
  // (identity-sync creates intents → the human approves via Telegram → DM executes).
  // Patterns with 3+ occurrences now create investigation intents.

  const recurring = await getRecurringLearningOpportunities(3);
  if (!recurring || recurring.length === 0) return [];

  const created: any[] = [];

  for (const opportunity of recurring) {
    // Check for existing non-terminal intent for this pattern
    try {
      const existing = await supabaseGet(
        'intents',
        `source=eq.recurring_learning_opportunities&status=in.(pending,approved,executing,needs_revision)&trigger_summary=like.*${encodeURIComponent(opportunity.pattern)}*&select=id&limit=1`
      );
      if (existing && existing.length > 0) continue;
    } catch {
      // Non-fatal — proceed with creation attempt
    }

    // Try to gather rich evidence for intent-rejected patterns
    const rejectionEvidence = await gatherRejectionEvidence(opportunity.pattern);

    // Category-based proposed action (fallback when no rejection evidence)
    const actionTemplates: Record<string, string> = {
      'decision-making': `Investigate evaluation logic producing bad outputs for pattern '${opportunity.pattern}'. Review sources creating this learning opportunity and improve decision criteria.`,
      'behavioral': `Investigate root cause of '${opportunity.pattern}'. Consider soul directive promotion or hook to prevent recurrence.`,
      'technical': `Investigate root cause of '${opportunity.pattern}'. Propose code fix or automated prevention.`,
    };
    const fallbackAction = actionTemplates[opportunity.category] ||
      `Investigate root cause of '${opportunity.pattern}' and propose a fix.`;

    const priority = (opportunity.occurrence_count >= 5 || opportunity.severity >= 8) ? 'high' : 'medium';

    const riskAssessment = `Pattern: ${opportunity.pattern}, Count: ${opportunity.occurrence_count}, Category: ${opportunity.category}, Severity: ${opportunity.severity}. Last context: ${(opportunity.description || 'none').slice(0, 200)}`;

    try {
      const intent = await createIntent({
        source: 'recurring_learning_opportunities',
        triggerSummary: `Recurring learning opportunity: '${opportunity.pattern}' (${opportunity.occurrence_count}x, severity ${opportunity.severity})`,
        diagnosis: rejectionEvidence?.diagnosis || null,
        evidence: rejectionEvidence?.evidence || [],
        proposedAction: rejectionEvidence?.enrichedAction || fallbackAction,
        filesAffected: rejectionEvidence?.filesAffected || [],
        riskAssessment,
        priority,
        expiresIn: 259200000, // 72 hours
      });
      if (intent && !(intent as any).throttled) {
        // Auto-approve and auto-start: investigation is low-risk research,
        // doesn't need an approval gate. the human gets a notification (awareness),
        // and the FIX is what needs approval — not the investigation.
        try {
          await approveIntent(intent.id, { feedback: 'Auto-approved: investigation intent' });
          await startExecution(intent.id);
        } catch {
          // Non-fatal — intent still created even if auto-start fails
        }
        created.push(intent);
      }
    } catch {
      // Non-fatal — skip this pattern
    }
  }

  return created;
}

module.exports = { recordLearningOpportunity, getRecurringLearningOpportunities, markPromoted, checkRecurringLearningOpportunities };
