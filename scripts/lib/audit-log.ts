// @alienkind-core
/**
 * audit-log.ts — immutable security audit trail.
 *
 * Logs every external action to a Supabase table that shouldn't be
 * modifiable or deletable — forkers should add BEFORE triggers on the
 * `security_audit_log` table that raise exceptions on UPDATE/DELETE so
 * even service_role can't tamper. Without that trigger, this is an
 * append-only convention; with it, the log is enforcement.
 *
 * Usage:
 *   const { auditLog } = require('./audit-log.ts');
 *   await auditLog({ action: 'kill_switch_change', target: 'level_2',
 *     parameters: { previous: 0, new_level: 2 }, source: 'telegram-bot',
 *     severity: 'warn' });
 *
 * Writers: defense-elements (kill-switch changes), hooks/privacy-gate,
 *   any script mutating external state.
 * Readers: queryAuditLog CLI, security/threat-hunter, nightly audits.
 *
 * Graceful no-op when Supabase is unavailable — never blocks the action
 * being logged.
 */

const crypto = require('crypto');
const { tryStorage, registerUnavailable } = require('./portable.ts');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  registerUnavailable('audit-log', {
    reason: 'Supabase credentials not configured — append-only trail unavailable.',
    enableWith: 'Set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env. Create a security_audit_log table with BEFORE UPDATE/DELETE triggers that raise exceptions, otherwise the "immutable" guarantee is convention-only.',
    docs: 'HYPOTHESIS.md §7 Security Organ.',
  });
}

interface AuditEntry {
  action: string;
  target?: string;
  parameters?: Record<string, any>;
  source: string;
  severity?: 'info' | 'warn' | 'critical';
  outcome?: 'success' | 'failure' | 'blocked';
  sessionId?: string;
}

/**
 * Log an action to the audit trail. Fails silently to stderr — the log
 * call must never break the action it's logging. Fire-and-forget.
 */
async function auditLog(entry: AuditEntry): Promise<void> {
  const contextHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...entry, timestamp: Date.now() }))
    .digest('hex')
    .slice(0, 16);

  await tryStorage(
    async () => {
      const { supabasePost } = require('./supabase.ts');
      return supabasePost('security_audit_log', {
        action_type: entry.action,
        target: entry.target || null,
        parameters: entry.parameters || {},
        source: entry.source,
        severity: entry.severity || 'info',
        outcome: entry.outcome || 'success',
        session_id: entry.sessionId ||
          process.env.ALIENKIND_SESSION_ID ||
          process.env.KEEL_SESSION_ID ||
          null,
        context_hash: contextHash,
      });
    },
    null,
  );
}

/**
 * Log a batch of actions (nightly / periodic dumps).
 */
async function auditLogBatch(entries: AuditEntry[]): Promise<void> {
  for (const entry of entries) {
    await auditLog(entry);
  }
}

/**
 * Query the audit log for anomaly detection and reporting.
 */
async function queryAuditLog(opts: {
  since?: string;
  actionType?: string;
  severity?: string;
  limit?: number;
} = {}): Promise<any[]> {
  return tryStorage(
    async () => {
      const { supabaseGet } = require('./supabase.ts');
      const filters: string[] = ['select=*'];
      if (opts.since) filters.push(`created_at=gte.${opts.since}`);
      if (opts.actionType) filters.push(`action_type=eq.${opts.actionType}`);
      if (opts.severity) filters.push(`severity=eq.${opts.severity}`);
      filters.push('order=created_at.desc');
      filters.push(`limit=${opts.limit || 100}`);
      return supabaseGet('security_audit_log', filters.join('&'));
    },
    [] as any[],
  );
}

module.exports = { auditLog, auditLogBatch, queryAuditLog };
