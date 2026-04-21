// @alienkind-core
/**
 * intelligence-engine-keel.ts — partner-self intelligence engine.
 *
 * Thin wrapper around packages/steward-core via the credential-injecting
 * adapter. Exposes the full engine surface (conversation logging, session
 * tracking, discernment writer, capability-gap detection, knowledge
 * retrieval, verified-metric enforcement) scoped to the partner's own
 * table prefix.
 *
 * Filename note: "keel" is preserved because Keel was the first partner
 * to use this surface. Forkers can rename the file and its exports —
 * the module name carries no behavior.
 *
 * Partner-specific enhancements layer on top by overriding engine methods
 * AFTER createEngine returns. Typical enhancements:
 *   - Codebase false-positive verification on detectCapabilityGap
 *     (skip gap log if the capability already exists in scripts/)
 *   - Cross-process file-based dedup (supplements in-memory dedup for
 *     scenarios where multiple processes write to the same gap table)
 *   - Custom CAPABILITY_MAP tuned to the fork's tool surface
 *
 * Prefix comes from partner-config.json (key: name), lowercased and
 * alphanumeric-only. Defaults to "partner" if the config is unset.
 *
 * Readers: scripts/hooks/log-conversation.ts (updateDiscernmentDirect,
 *          detectCapabilityGap, updateSession),
 *          scripts/hooks/agent-output-audit.ts.
 * Writers: Supabase tables scoped to the partner's prefix —
 *          <prefix>_steward_conversations, <prefix>_steward_discernment,
 *          <prefix>_steward_sessions, <prefix>_steward_knowledge.
 */

const { createEngine } = require('./steward-core.ts');
const { resolveConfig } = require('./portable.ts');

const partnerName: string = resolveConfig('name', 'Partner');
const prefix: string = partnerName.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'partner';

const engine = createEngine(prefix);

module.exports = engine;
