// @alienkind-core
/**
 * intents.ts — Two-Tier Autonomous Execution Queue.
 *
 * "State intent, not permission." — identity/character.md
 *
 * Two tiers:
 *   1. Partner-approved (approval_required: false) — the partner evaluates,
 *      executes, and notifies the human after the fact. For internal/safe
 *      changes.
 *   2. Human-required (approval_required: true) — the partner proposes, waits
 *      for the human's approval via a messaging channel, then executes. For
 *      external/sensitive actions.
 *
 * Lifecycle:
 *   Partner-approved: created → pending → (auto) approved → executing → completed/failed
 *   Human-required:  created → pending → approved/rejected → executing → completed/failed
 *
 * Storage: Supabase `intents` table. Without Supabase configured, all
 * operations gracefully no-op — creation returns null, queries return
 * empty arrays — and the capability reports itself as unavailable via
 * portable.ts so the partner knows what to invest in next.
 *
 * Writers: the daemon (self-healing job failures create intents),
 *   learning-opportunities (recurring patterns create intents), any
 *   caller that wants to propose a change through the queue.
 * Readers: the daemon (pending queue, stale expiry), messaging layers
 *   (format for human notification), learning-opportunities (approve +
 *   start execution flow).
 */

const path = require('path');
const { supabaseGet, supabasePost, supabasePatch } = require('./supabase.ts');
const { INTENTS } = require('./constants.ts');
const { tryStorage, registerUnavailable } = require('./portable.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

// Parent directory of the repo — used to classify "files outside this repo"
// as human-requiring when the partner proposes cross-repo changes. Forkers
// can override via ALIENKIND_SIBLING_ROOT env var if their layout differs.
const SIBLING_ROOT = process.env.ALIENKIND_SIBLING_ROOT || path.resolve(ALIENKIND_DIR, '..');

// Register the capability surface up front. If Supabase isn't wired, every
// call below falls through tryStorage with a no-op fallback. The partner
// learns its own state by calling getCapabilityStatus() from portable.ts.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  registerUnavailable('intents', {
    reason: 'Supabase credentials not configured (SUPABASE_URL or SUPABASE_SERVICE_KEY missing).',
    enableWith: 'Run `npm run setup` and choose the Supabase path, or set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env. The intent queue requires persistent storage — file-only fallback is not supported.',
    docs: 'HYPOTHESIS.md §10 Stigmergic Circulation; supabase.com/dashboard for the free tier.',
  });
}

type IntentStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'expired' | 'needs_revision';
type IntentPriority = 'urgent' | 'high' | 'medium' | 'low';
type TestsStatus = 'not_run' | 'passing' | 'failing';

interface CreateIntentParams {
  source: string;
  triggerSummary: string;
  diagnosis?: string | null;
  evidence?: any[];
  proposedAction: string;
  proposedDiff?: string | null;
  filesAffected?: string[];
  riskAssessment?: string | null;
  testsStatus?: TestsStatus;
  testsDetail?: string | null;
  priority?: IntentPriority;
  expiresIn?: number | null;
  digestSectionsReferenced?: string[];
}

interface Intent {
  id: number;
  source: string;
  trigger_summary: string;
  diagnosis: string | null;
  evidence: string;
  proposed_action: string;
  proposed_diff: string | null;
  files_affected: string[];
  risk_assessment: string | null;
  tests_status: TestsStatus;
  tests_detail: string | null;
  status: IntentStatus;
  priority: IntentPriority;
  approval_required: boolean;
  expires_at: string;
  human_feedback: string | null;
  approved_at: string | null;
  executed_at: string | null;
  execution_result: string | null;
  created_at: string;
  [key: string]: any;
}

interface FeedbackOptions {
  feedback?: string | null;
}

/**
 * Determine whether an intent requires the human's explicit approval.
 *
 * Returns true (human-required) for:
 *   - Identity kernel changes (identity-critical)
 *   - CLAUDE.md changes
 *   - External-facing actions (social posts, emails, messages to external people)
 *   - Anything touching credentials, env vars, secrets
 *   - Anything modifying a sibling repo (files outside this repo's directory)
 *   - Destructive actions (deleting files, dropping data)
 *
 * Returns false (partner-approved) for:
 *   - Memory/documentation changes (daily files, session-state, logs)
 *   - Internal code fixes (hooks, scripts, configs, tests)
 *   - Infrastructure improvements (monitoring, logging, error handling)
 *   - Learning-ledger updates, pattern tracking
 *   - Non-identity-kernel identity work
 *
 * Forkers: override via a separate policy module if the partner's trust
 * envelope for auto-execution differs from the reference defaults.
 */
function requiresHumanApproval(params: {
  filesAffected?: string[];
  proposedAction: string;
  triggerSummary: string;
}): boolean {
  const { filesAffected = [], proposedAction, triggerSummary } = params;
  const combinedText = `${proposedAction} ${triggerSummary}`.toLowerCase();

  // Identity kernel files and CLAUDE.md are identity-critical
  const protectedPaths = ['identity/', 'CLAUDE.md'];
  for (const f of filesAffected) {
    const normalized = f.startsWith(ALIENKIND_DIR)
      ? path.relative(ALIENKIND_DIR, f)
      : f;
    if (protectedPaths.some(p => normalized.startsWith(p) || normalized === p)) {
      return true;
    }
  }

  // Files outside this repo — absolute paths not rooted at ALIENKIND_DIR,
  // or paths into sibling repos under SIBLING_ROOT (mosi, striveos-io, etc.)
  for (const f of filesAffected) {
    if (f.startsWith('/') && !f.startsWith(ALIENKIND_DIR + '/') && f !== ALIENKIND_DIR) {
      return true;
    }
    // Relative-path form that traverses into a sibling
    if (f.startsWith('../') || f.includes('/../')) {
      return true;
    }
  }

  // Credentials, env vars, secrets
  for (const f of filesAffected) {
    const base = f.split('/').pop() || '';
    if (
      base === '.env' ||
      base.endsWith('.env') ||
      base === 'credentials.json' ||
      base.endsWith('.pem') ||
      base.endsWith('.key')
    ) {
      return true;
    }
  }

  // External-facing actions
  const externalPatterns = [
    'social media', 'tweet', 'post to x', 'post to linkedin', 'linkedin post',
    'send email', 'send message', 'external message', 'telegram message to',
    'publish article', 'send to', 'dm ', 'direct message',
  ];
  if (externalPatterns.some(p => combinedText.includes(p))) {
    return true;
  }

  // Destructive actions
  const destructivePatterns = [
    'delet', 'drop table', 'drop column', 'remove file', 'truncat',
    'destroy', 'wipe', 'purge', 'rm -rf', 'unlink',
  ];
  if (destructivePatterns.some(p => combinedText.includes(p))) {
    return true;
  }

  return false;
}

/**
 * Get partner-approved intents that are pending and ready for auto-execution.
 */
async function getPartnerApprovedPending(): Promise<Intent[]> {
  return tryStorage(
    () => supabaseGet(
      'intents',
      'status=eq.pending&approval_required=eq.false&order=priority.asc,created_at.asc&limit=10',
      { timeout: 5000 },
    ),
    [],
  );
}

/**
 * Get recently partner-executed intents (completed in last 24h, approval_required=false).
 * Used for after-the-fact visibility into what the partner did autonomously.
 */
async function getRecentPartnerExecuted({ hours = 24 }: { hours?: number } = {}): Promise<Intent[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return tryStorage(
    () => supabaseGet(
      'intents',
      `status=in.(completed,failed)&approval_required=eq.false&executed_at=gte.${since}&order=executed_at.desc&limit=10`,
      { timeout: 5000 },
    ),
    [],
  );
}

/**
 * Create a new intent and store it. Automatically classifies approval
 * tier via requiresHumanApproval. Returns null if storage is unavailable
 * or the source has hit its active-intent quota (returns {throttled}).
 */
async function createIntent({
  source,
  triggerSummary,
  diagnosis = null,
  evidence = [],
  proposedAction,
  proposedDiff = null,
  filesAffected = [],
  riskAssessment = null,
  testsStatus = 'not_run',
  testsDetail = null,
  priority = 'medium',
  expiresIn = null,
  digestSectionsReferenced = [],
}: CreateIntentParams): Promise<Intent | { throttled: true; pendingCount: number } | null> {
  if (!source || !triggerSummary || !proposedAction) {
    throw new Error('createIntent requires source, triggerSummary, and proposedAction');
  }

  // Check active (non-terminal) count to prevent runaway creation
  const active = await tryStorage(
    () => supabaseGet(
      'intents',
      `source=eq.${source}&status=in.(pending,approved,executing,needs_revision)&select=id`,
      { timeout: 5000 },
    ),
    [],
  );
  if (active && active.length >= INTENTS.maxPendingPerSource) {
    return { throttled: true, pendingCount: active.length };
  }

  // Calculate expiry
  const expiryMs = expiresIn || (priority === 'urgent' ? INTENTS.urgentExpiry : INTENTS.defaultExpiry);
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();

  // Determine approval tier
  const approvalRequired = requiresHumanApproval({ filesAffected, proposedAction, triggerSummary });

  const row: Record<string, any> = {
    source,
    trigger_summary: triggerSummary,
    diagnosis,
    evidence: JSON.stringify(evidence),
    proposed_action: proposedAction,
    proposed_diff: proposedDiff,
    files_affected: filesAffected,
    risk_assessment: riskAssessment,
    tests_status: testsStatus,
    tests_detail: testsDetail,
    status: 'pending' as IntentStatus,
    priority,
    expires_at: expiresAt,
    approval_required: approvalRequired,
  };

  if (digestSectionsReferenced.length > 0) {
    row.digest_sections_referenced = digestSectionsReferenced;
  }

  // Post + fetch the created row. If storage is unavailable, both return
  // null and the caller sees a null intent — same shape as an unsuccessful
  // fetch, so no special-case handling needed downstream.
  const posted = await tryStorage(
    () => supabasePost('intents', row, { prefer: 'return=representation' }),
    null,
  );
  if (posted === null) return null;

  const created = await tryStorage(
    () => supabaseGet(
      'intents',
      `source=eq.${source}&status=eq.pending&order=created_at.desc&limit=1`,
    ),
    [] as Intent[],
  );

  return created && created.length > 0 ? created[0] : null;
}

/**
 * Get all pending intents, ordered by priority then creation time.
 */
async function getPendingIntents({ limit = 10 }: { limit?: number } = {}): Promise<Intent[]> {
  return tryStorage(
    () => supabaseGet(
      'intents',
      `status=eq.pending&order=priority.asc,created_at.asc&limit=${limit}`,
    ),
    [],
  );
}

/**
 * Get a single intent by ID.
 */
async function getIntent(id: number): Promise<Intent | null> {
  const rows = await tryStorage(
    () => supabaseGet('intents', `id=eq.${id}&limit=1`),
    [] as Intent[],
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Approve a human-required intent (call when the human signals go).
 */
async function approveIntent(id: number, { feedback = null }: FeedbackOptions = {}): Promise<Intent | null> {
  await tryStorage(
    () => supabasePatch('intents', `id=eq.${id}`, {
      status: 'approved',
      human_feedback: feedback,
      approved_at: new Date().toISOString(),
    }),
    null,
  );
  return getIntent(id);
}

/**
 * Mark an intent as executing (in-progress).
 */
async function startExecution(id: number): Promise<void> {
  await tryStorage(
    () => supabasePatch('intents', `id=eq.${id}`, {
      status: 'executing',
      executed_at: new Date().toISOString(),
    }),
    null,
  );
}

/**
 * Expire old pending intents that passed their expires_at. Returns the
 * count of expired intents (0 when storage is unavailable).
 */
async function expireStaleIntents(): Promise<number> {
  const now = new Date().toISOString();
  const stale = await tryStorage(
    () => supabaseGet(
      'intents',
      `status=eq.pending&expires_at=lt.${now}&select=id`,
    ),
    [] as Array<{ id: number }>,
  );
  if (!stale || stale.length === 0) return 0;

  for (const row of stale) {
    await tryStorage(
      () => supabasePatch('intents', `id=eq.${row.id}`, { status: 'expired' }),
      null,
    );
  }
  return stale.length;
}

/**
 * Format an intent for a human-facing messaging channel (Telegram, Discord,
 * etc.). Partner-approved intents show execution result. Human-required
 * intents show approve/reject prompt.
 */
function formatForTelegram(intent: Intent): string {
  const priority = intent.priority === 'urgent' ? 'URGENT' : intent.priority === 'high' ? 'HIGH' : '';
  const header = priority ? `${priority} — Intent #${intent.id}` : `Intent #${intent.id}`;

  const parts: string[] = [header, ''];

  parts.push(`Source: ${intent.source}`);
  parts.push(`What happened: ${intent.trigger_summary}`);

  if (intent.diagnosis) {
    parts.push(`Root cause: ${intent.diagnosis}`);
  }

  parts.push('');
  parts.push(`Intended fix: ${intent.proposed_action}`);

  if (intent.files_affected && intent.files_affected.length > 0) {
    parts.push(`Files: ${intent.files_affected.join(', ')}`);
  }

  if (intent.risk_assessment) {
    parts.push(`Risk: ${intent.risk_assessment}`);
  }

  if (intent.tests_status && intent.tests_status !== 'not_run') {
    parts.push(`Tests: ${intent.tests_status}${intent.tests_detail ? ` — ${intent.tests_detail}` : ''}`);
  }

  parts.push('');

  if (intent.approval_required === false) {
    parts.push('Tier: partner-approved (auto-execute)');
    parts.push(`Reply "require approval on ${intent.id}" to reclaim control.`);
  } else {
    parts.push(`Reply "approve ${intent.id}" or "reject ${intent.id}"`);
  }

  const text = parts.join('\n');
  return text.length > INTENTS.telegramSummaryMaxChars
    ? text.slice(0, INTENTS.telegramSummaryMaxChars - 3) + '...'
    : text;
}

/**
 * Format a partner-executed intent as a post-execution notification.
 */
function formatPartnerExecutedForTelegram(intent: Intent): string {
  const statusEmoji = intent.status === 'completed' ? '✅' : '❌';
  const parts: string[] = [];

  parts.push(`${statusEmoji} Partner-executed #${intent.id}: ${intent.trigger_summary}`);

  if (intent.execution_result) {
    parts.push(`Result: ${intent.execution_result.slice(0, 300)}`);
  }

  if (intent.files_affected && intent.files_affected.length > 0) {
    parts.push(`Files: ${intent.files_affected.join(', ')}`);
  }

  const text = parts.join('\n');
  return text.length > INTENTS.telegramSummaryMaxChars
    ? text.slice(0, INTENTS.telegramSummaryMaxChars - 3) + '...'
    : text;
}

module.exports = {
  requiresHumanApproval,
  createIntent,
  getPendingIntents,
  getPartnerApprovedPending,
  getRecentPartnerExecuted,
  getIntent,
  approveIntent,
  startExecution,
  expireStaleIntents,
  formatForTelegram,
  formatPartnerExecutedForTelegram,
};
