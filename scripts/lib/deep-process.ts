// @alienkind-core
/**
 * deep-process.ts — Shared writer for deep-process outputs with deduplication.
 *
 * All Layer-1 deep processes (security scans, world intelligence, domain
 * analysis, self-assessment) write findings through this module instead of
 * raw supabasePost('deep_process_outputs', ...). Two-layer dedup prevents
 * a long-lived issue from spawning repeat findings:
 *
 *   1. Unincorporated match: if the same (process_name, summary) is already
 *      queued for review, skip regardless of age. Stops cascading findings
 *      for issues that persist across multiple scan cycles.
 *   2. Time-window match: if the same (process_name, summary) was written
 *      within DEDUP_WINDOW_MS (2h), skip. Prevents re-filing immediately
 *      after incorporation clears the queue.
 *
 * Successful inserts also auto-deposit into circulation so the finding
 * enters the organism's bloodstream where other organs pick it up.
 *
 * Usage:
 *   const { writeDeepProcessOutput } = require('./deep-process.ts');
 *   const result = await writeDeepProcessOutput({
 *     domain: 'security', process_name: 'red-team',
 *     findings, summary, priority,
 *   });
 *   // result.written: boolean, result.reason: 'inserted' | 'deduplicated'
 */

const { supabaseGet, supabasePost } = require('./supabase.ts');

interface DeepProcessData {
  domain: string;
  process_name: string;
  findings: any;
  summary: string;
  priority: number;
  [key: string]: any;
}

interface WriteResult {
  written: boolean;
  reason: 'inserted' | 'deduplicated';
  existingId?: number;
}

// Default: skip if identical summary from same process within 2 hours
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

// Processes whose findings regularly cross domains (world analysis that
// surfaces coaching signals, security scans that touch infrastructure, etc.)
// get an LLM secondary-domain classification pass so the finding reaches
// readers of those other domains too. Empty in the reference — forkers
// extend with their partner's cross-domain processes.
const CROSS_DOMAIN_PRODUCERS: string[] = [];

async function writeDeepProcessOutput(
  data: DeepProcessData,
  log?: (level: string, msg: string) => void,
): Promise<WriteResult> {
  const _log = log || (() => {});

  try {
    // Dedup layer 1: unincorporated match (age-independent)
    const unincorporated = await supabaseGet(
      'deep_process_outputs',
      `select=id,summary,created_at&process_name=eq.${encodeURIComponent(data.process_name)}&summary=eq.${encodeURIComponent(data.summary)}&incorporated=eq.false&order=created_at.desc&limit=1`,
    );

    if (unincorporated && unincorporated.length > 0) {
      const existing = unincorporated[0];
      _log('INFO', `Dedup: skipping — unincorporated finding #${existing.id} already queued for ${data.process_name}`);
      return { written: false, reason: 'deduplicated', existingId: existing.id };
    }

    // Dedup layer 2: time-window match
    const recent = await supabaseGet(
      'deep_process_outputs',
      `select=id,summary,created_at&process_name=eq.${encodeURIComponent(data.process_name)}&summary=eq.${encodeURIComponent(data.summary)}&order=created_at.desc&limit=1`,
    );

    if (recent && recent.length > 0) {
      const existing = recent[0];
      const age = Date.now() - new Date(existing.created_at).getTime();
      if (age < DEDUP_WINDOW_MS) {
        _log('INFO', `Dedup: skipping duplicate finding for ${data.process_name} (matches #${existing.id}, ${Math.round(age / 60000)}min old)`);
        return { written: false, reason: 'deduplicated', existingId: existing.id };
      }
    }

    // No duplicate — insert
    await supabasePost('deep_process_outputs', data);
    _log('INFO', `Wrote finding to deep_process_outputs: ${data.domain}/${data.process_name} (p${data.priority})`);

    // Auto-deposit into circulation
    try {
      const { deposit, classifySecondaryDomainsLLM } = require('./circulation.ts');

      let secondary_domains: string[] | undefined;
      if (CROSS_DOMAIN_PRODUCERS.includes(data.process_name)) {
        try {
          secondary_domains = await classifySecondaryDomainsLLM(data.summary, data.domain);
          if (secondary_domains && secondary_domains.length > 0) {
            _log('INFO', `Cross-domain tags for ${data.process_name}: [${secondary_domains.join(', ')}]`);
          }
        } catch {
          // classifier unavailable — non-fatal
        }
      }

      await deposit({
        source_organ: data.process_name,
        finding: data.summary.slice(0, 500),
        finding_type: data.priority >= 8 ? 'anomaly' : data.priority >= 5 ? 'pattern' : 'observation',
        domain: data.domain,
        secondary_domains,
        confidence: Math.min(data.priority / 10, 1.0),
        action_tier: data.priority >= 9 ? 'T2' : data.priority >= 6 ? 'T3' : undefined,
        metadata: { process_name: data.process_name, priority: data.priority },
      });
    } catch {
      // circulation unavailable — non-fatal
    }

    return { written: true, reason: 'inserted' };
  } catch (err: any) {
    // Dedup check failed — fall through to raw insert. The cost of a
    // duplicate is lower than the cost of a dropped finding.
    _log('WARN', `Dedup check failed (${err.message}), inserting anyway`);
    try {
      await supabasePost('deep_process_outputs', data);
    } catch (insertErr: any) {
      _log('WARN', `deep_process_outputs insert failed: ${insertErr.message}`);
    }
    return { written: true, reason: 'inserted' };
  }
}

module.exports = { writeDeepProcessOutput, DEDUP_WINDOW_MS, CROSS_DOMAIN_PRODUCERS };
