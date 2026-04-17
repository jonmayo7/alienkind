/**
 * Circulation — the organism's bloodstream.
 *
 * Stigmergic blackboard: organs deposit findings, other organs withdraw them.
 * No organ knows about any other organ. They know the schema.
 *
 * Features:
 *   - Exponential decay: effective_intensity = initial * reinforcement * exp(-hours / decay_hours)
 *   - Reinforcement: same finding from multiple organs strengthens the signal
 *   - Quorum sensing: findings cross a threshold before triggering action
 *   - Domain filtering: organs withdraw only what's relevant to them
 *   - Action tiers: T1 (auto-fix), T2 (fix + inform), T3 (surface for the human)
 *
 * Design sources:
 *   organism-architecture.md, Markspace protocol, pressure-field experiment,
 *   stigmergy-MCP decay formula, Insight Swarm cross-organ discovery.
 *
 * Writers: any organ (intent-audit, nightly-analysis, steward engines, scheduled analyzers, etc.)
 * Readers: circulation-pump (daemon), any organ via withdraw()
 *
 * Usage:
 *   const { deposit, withdraw, reinforce } = require('./circulation.ts');
 *   deposit({ source_organ: 'nightly-analysis', finding: '...', domain: 'security', finding_type: 'signal' });
 *   const findings = await withdraw({ domain: 'security', minIntensity: 0.3 });
 */

const path = require('path');

// Lazy-load supabase to avoid circular deps at module load time
function getSb() {
  const { supabaseGet, supabasePost, supabasePatch, supabaseCount } = require('./supabase.ts');
  return { supabaseGet, supabasePost, supabasePatch, supabaseCount };
}

// --- Constants ---

// Default decay hours by finding type
const DECAY_HOURS: Record<string, number> = {
  signal: 4,
  metric: 4,
  anomaly: 12,
  pattern: 48,
  insight: 72,
  gap: 168,       // 7 days
  correction: 336, // 14 days
  observation: 24,
};

// Default quorum thresholds by finding type
const QUORUM_DEFAULTS: Record<string, number> = {
  signal: 1,      // act immediately
  metric: 1,      // informational
  anomaly: 2,     // need confirmation
  pattern: 2,     // need confirmation
  insight: 1,     // act on insight
  gap: 1,         // act on gap
  correction: 1,  // act on correction
  observation: 3, // need multiple observers
};

// --- Core Interface ---

interface DepositOptions {
  source_organ: string;
  finding: string;
  finding_type?: string;
  domain?: string;
  secondary_domains?: string[];
  confidence?: number;
  decay_hours?: number;
  quorum_threshold?: number;
  action_tier?: string;
  related_files?: string[];
  metadata?: Record<string, any>;
  source_terminal?: string;
}

interface WithdrawOptions {
  domain?: string;
  finding_type?: string;
  minIntensity?: number;
  unconsumedOnly?: boolean;
  consumer?: string;       // organ name — marks findings as consumed
  limit?: number;
  includeExpired?: boolean;
}

interface CirculationFinding {
  id: string;
  source_organ: string;
  finding: string;
  finding_type: string;
  domain: string;
  secondary_domains: string[];
  confidence: number;
  effective_intensity: number;  // computed: initial * reinforcement * exp(-hours / decay)
  reinforcement_count: number;
  quorum_reached: boolean;
  action_tier: string | null;
  action_status: string;
  related_files: string[];
  created_at: string;
  age_hours: number;
}

// --- Exponential Decay ---

function computeIntensity(initial: number, reinforcement: number, elapsedHours: number, decayHours: number): number {
  return initial * reinforcement * Math.exp(-elapsedHours / decayHours);
}

// --- Deposit ---

/**
 * Deposit a finding into the circulation table.
 * Checks for existing similar findings and reinforces instead of duplicating.
 */
async function deposit(opts: DepositOptions): Promise<string | null> {
  const { supabaseGet, supabasePost, supabasePatch } = getSb();
  const findingType = opts.finding_type || 'observation';
  const domain = opts.domain || 'infrastructure';
  const decayHours = opts.decay_hours || DECAY_HOURS[findingType] || 24;
  const quorumThreshold = opts.quorum_threshold || QUORUM_DEFAULTS[findingType] || 1;

  try {
    // Check for existing similar finding to reinforce instead of duplicate
    // Same source_organ + same finding_type + overlapping content = reinforce
    const existing = await supabaseGet(
      'circulation',
      `select=id,finding,reinforcement_count,reinforced_by,initial_intensity,quorum_threshold,quorum_reached,action_status&source_organ=eq.${encodeURIComponent(opts.source_organ)}&finding_type=eq.${findingType}&domain=eq.${domain}&order=created_at.desc&limit=10`
    );

    // Dedup: skip if a similar finding was recently rejected or is still pending
    const findingLower = opts.finding.toLowerCase().slice(0, 100);
    const duplicate = existing.find((e: any) => {
      if (!e.finding) return false;
      const existingLower = e.finding.toLowerCase().slice(0, 100);
      // Check text overlap — if first 100 chars share 60%+ words, it's a duplicate
      const newWords = new Set(findingLower.split(/\s+/).filter((w: string) => w.length > 3));
      const existWords = existingLower.split(/\s+/).filter((w: string) => w.length > 3);
      if (newWords.size === 0) return false;
      const overlap = existWords.filter((w: string) => newWords.has(w)).length;
      const similarity = overlap / newWords.size;
      return similarity > 0.6 && (e.action_status === 'rejected' || e.action_status === 'pending');
    });

    if (duplicate) {
      // Skip deposit — finding was already filed and is pending or was rejected
      return duplicate.id;
    }

    // No duplicate — create new finding
    const row: any = {
      source_organ: opts.source_organ,
      source_terminal: opts.source_terminal || null,
      finding: opts.finding,
      finding_type: findingType,
      domain,
      secondary_domains: opts.secondary_domains || [],
      confidence: opts.confidence || 0.5,
      initial_intensity: 1.0,
      reinforcement_count: 1,
      reinforced_by: JSON.stringify([opts.source_organ]),
      decay_hours: decayHours,
      quorum_threshold: quorumThreshold,
      quorum_reached: quorumThreshold <= 1,
      quorum_reached_at: quorumThreshold <= 1 ? new Date().toISOString() : null,
      action_tier: opts.action_tier || null,
      action_status: 'pending',
      related_files: JSON.stringify(opts.related_files || []),
      metadata: JSON.stringify(opts.metadata || {}),
    };

    const result = await supabasePost('circulation', row, { prefer: 'return=representation' });
    return result?.[0]?.id || result?.id || null;
  } catch (err: any) {
    // Never block on deposit failure
    return null;
  }
}

// --- Reinforce ---

/**
 * Reinforce an existing finding. Another organ confirms the same observation.
 * Bumps reinforcement_count, extends effective TTL, checks quorum.
 */
async function reinforce(findingId: string, reinforcer: string): Promise<boolean> {
  const { supabaseGet, supabasePatch } = getSb();
  try {
    const rows = await supabaseGet('circulation', `select=*&id=eq.${findingId}&limit=1`);
    if (rows.length === 0) return false;

    const finding = rows[0];
    const reinforcedBy = JSON.parse(finding.reinforced_by || '[]');
    if (reinforcedBy.includes(reinforcer)) return false; // Already reinforced by this organ

    reinforcedBy.push(reinforcer);
    const newCount = (finding.reinforcement_count || 1) + 1;
    const quorumReached = newCount >= (finding.quorum_threshold || 1);

    const updates: any = {
      reinforcement_count: newCount,
      reinforced_by: JSON.stringify(reinforcedBy),
      updated_at: new Date().toISOString(),
    };

    if (quorumReached && !finding.quorum_reached) {
      updates.quorum_reached = true;
      updates.quorum_reached_at = new Date().toISOString();
    }

    await supabasePatch('circulation', `id=eq.${findingId}`, updates);
    return true;
  } catch { return false; }
}

// --- Withdraw ---

/**
 * Withdraw findings from circulation, filtered by domain/type/intensity.
 * Optionally marks findings as consumed by the requesting organ.
 */
async function withdraw(opts: WithdrawOptions = {}): Promise<CirculationFinding[]> {
  const { supabaseGet, supabasePatch } = getSb();
  const limit = opts.limit || 50;
  const minIntensity = opts.minIntensity || 0.05; // Below 5% = effectively expired

  try {
    let query = `select=*&order=created_at.desc&limit=${limit}`;
    if (opts.domain) query += `&domain=eq.${opts.domain}`;
    if (opts.finding_type) query += `&finding_type=eq.${opts.finding_type}`;

    const rows = await supabaseGet('circulation', query);

    // Cross-domain: also fetch findings where this domain appears in secondary_domains
    if (opts.domain) {
      try {
        let crossQuery = `select=*&order=created_at.desc&limit=${limit}&secondary_domains=cs.${encodeURIComponent(JSON.stringify([opts.domain]))}`;
        if (opts.finding_type) crossQuery += `&finding_type=eq.${opts.finding_type}`;
        const crossRows = await supabaseGet('circulation', crossQuery);
        // Merge, dedup by ID
        const existingIds = new Set(rows.map((r: any) => r.id));
        for (const cr of crossRows) {
          if (!existingIds.has(cr.id)) rows.push(cr);
        }
      } catch { /* cross-domain query failed — continue with primary results */ }
    }
    const now = Date.now();
    const results: CirculationFinding[] = [];

    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      const ageHours = (now - createdAt) / (1000 * 60 * 60);
      const intensity = computeIntensity(
        row.initial_intensity || 1.0,
        row.reinforcement_count || 1,
        ageHours,
        row.decay_hours || 24
      );

      // Filter by minimum intensity (expired findings drop below threshold)
      if (!opts.includeExpired && intensity < minIntensity) continue;

      // Filter by unconsumed (if requested)
      if (opts.unconsumedOnly && opts.consumer) {
        const consumed = (Array.isArray(row.consumed_by) ? row.consumed_by : JSON.parse(row.consumed_by || '[]'));
        if (consumed.some((c: any) => c.organ === opts.consumer)) continue;
      }

      const secondaryDomains = Array.isArray(row.secondary_domains)
        ? row.secondary_domains
        : JSON.parse(row.secondary_domains || '[]');

      results.push({
        id: row.id,
        source_organ: row.source_organ,
        finding: row.finding,
        finding_type: row.finding_type,
        domain: row.domain,
        secondary_domains: secondaryDomains,
        confidence: row.confidence,
        effective_intensity: Math.round(intensity * 1000) / 1000,
        reinforcement_count: row.reinforcement_count,
        quorum_reached: row.quorum_reached,
        action_tier: row.action_tier,
        action_status: row.action_status,
        related_files: (Array.isArray(row.related_files) ? row.related_files : JSON.parse(row.related_files || '[]')),
        created_at: row.created_at,
        age_hours: Math.round(ageHours * 10) / 10,
      });
    }

    // Sort by effective intensity (strongest signal first)
    results.sort((a, b) => b.effective_intensity - a.effective_intensity);

    // Mark as consumed if consumer specified
    if (opts.consumer && results.length > 0) {
      for (const r of results) {
        try {
          const row = rows.find((rr: any) => rr.id === r.id);
          const consumed = (Array.isArray(row.consumed_by) ? row.consumed_by : JSON.parse(row.consumed_by || '[]'));
          consumed.push({ organ: opts.consumer, consumed_at: new Date().toISOString() });
          await supabasePatch('circulation', `id=eq.${r.id}`, {
            consumed_by: JSON.stringify(consumed),
          });
        } catch { /* non-fatal */ }
      }
    }

    return results;
  } catch { return []; }
}

// --- Action Recording ---

/**
 * Record that an action was taken on a finding.
 */
async function recordAction(findingId: string, action: string, result: string, log?: (level: string, msg: string) => void): Promise<void> {
  const { supabaseGet, supabasePatch } = getSb();
  try {
    const rows = await supabaseGet('circulation', `select=actions_taken&id=eq.${findingId}&limit=1`);
    if (rows.length === 0) return;
    const raw = rows[0].actions_taken;
    const actions = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    actions.push({ action, result, taken_at: new Date().toISOString() });
    await supabasePatch('circulation', `id=eq.${findingId}`, {
      actions_taken: JSON.stringify(actions),
      action_status: 'actioned',
      updated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    if (log) log('WARN', `recordAction failed for ${findingId}: ${err.message}`);
  }
}

// --- Quorum Query ---

/**
 * Get findings that have reached quorum and are pending action.
 * These are the highest-priority items for the circulation pump.
 */
async function getActionable(domain?: string): Promise<CirculationFinding[]> {
  const { supabaseGet } = getSb();
  try {
    // Server-side filter: ONLY pending + quorum-reached. Prevents re-routing actioned findings.
    let query = `select=*&action_status=eq.pending&quorum_reached=eq.true&order=created_at.desc&limit=20`;
    if (domain) query += `&domain=eq.${domain}`;
    const rows = await supabaseGet('circulation', query);
    const now = Date.now();
    const results: CirculationFinding[] = [];
    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      const ageHours = (now - createdAt) / (1000 * 60 * 60);
      const intensity = computeIntensity(
        row.initial_intensity || 1.0,
        row.reinforcement_count || 1,
        ageHours,
        row.decay_hours || 24
      );
      if (intensity < 0.1) continue;
      const secondaryDomains = Array.isArray(row.secondary_domains)
        ? row.secondary_domains
        : JSON.parse(row.secondary_domains || '[]');
      results.push({
        id: row.id,
        source_organ: row.source_organ,
        finding: row.finding,
        finding_type: row.finding_type,
        domain: row.domain,
        secondary_domains: secondaryDomains,
        confidence: row.confidence,
        effective_intensity: Math.round(intensity * 1000) / 1000,
        reinforcement_count: row.reinforcement_count,
        quorum_reached: row.quorum_reached,
        action_tier: row.action_tier,
        action_status: row.action_status,
        related_files: (Array.isArray(row.related_files) ? row.related_files : JSON.parse(row.related_files || '[]')),
        created_at: row.created_at,
        age_hours: Math.round(ageHours * 10) / 10,
      });
    }
    return results;
  } catch { return []; }
}

// --- Stats ---

async function stats(): Promise<Record<string, any>> {
  const { supabaseCount } = getSb();
  try {
    const total = await supabaseCount('circulation', '');
    const pending = await supabaseCount('circulation', 'action_status=eq.pending');
    const actioned = await supabaseCount('circulation', 'action_status=eq.actioned');
    const quorumReached = await supabaseCount('circulation', 'quorum_reached=eq.true&action_status=eq.pending');
    return { total, pending, actioned, quorumReached };
  } catch { return { total: 0, pending: 0, actioned: 0, quorumReached: 0 }; }
}

// --- CLI ---

if (require.main === module) {
  const args = process.argv.slice(2);
  const { loadEnv } = require('./shared.ts');
  Object.assign(process.env, loadEnv(path.resolve(__dirname, '..', '..', '.env')));

  (async () => {
    if (args.includes('--stats')) {
      const s = await stats();
      console.log('Circulation stats:', s);
    } else if (args.includes('--withdraw')) {
      const domain = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : undefined;
      const findings = await withdraw({ domain, limit: 10 });
      for (const f of findings) {
        console.log(`[${f.domain}/${f.finding_type}] ${f.effective_intensity.toFixed(2)} | ${f.source_organ}: ${f.finding.slice(0, 100)}`);
      }
      if (findings.length === 0) console.log('No active findings.');
    } else if (args.includes('--actionable')) {
      const findings = await getActionable();
      for (const f of findings) {
        console.log(`[ACTIONABLE] ${f.domain}: ${f.finding.slice(0, 100)} (reinforced ${f.reinforcement_count}x)`);
      }
      if (findings.length === 0) console.log('No actionable findings.');
    } else {
      console.log('Usage: npx tsx scripts/lib/circulation.ts --stats | --withdraw [--domain X] | --actionable');
    }
  })();
}

/**
 * Delegate a task to another terminal via circulation.
 * Used when this terminal can't do something (wrong mode, too much context,
 * missing capability) and another terminal should pick it up.
 */
async function delegateTask(opts: {
  task: string;
  reason: string;
  fromTerminal: string;
  requiredMode?: string;
  priority?: number;
}): Promise<string | null> {
  return deposit({
    source_organ: `delegate-${opts.fromTerminal}`,
    finding: `TASK DELEGATION: ${opts.task} (reason: ${opts.reason})`,
    finding_type: 'signal',
    domain: 'infrastructure',
    confidence: 1.0,
    decay_hours: 4,
    quorum_threshold: 1,
    action_tier: 'T1',
    metadata: {
      delegated: true,
      task: opts.task,
      reason: opts.reason,
      fromTerminal: opts.fromTerminal,
      requiredMode: opts.requiredMode,
      priority: opts.priority || 5,
    },
  });
}

// --- Cross-Domain Classifier ---

/**
 * Lightweight keyword-to-domain classifier for tagging findings with secondary domains.
 * Returns domains (excluding the finding's primary domain) that match keyword patterns.
 * Used by deep-process.ts to auto-tag the three broadest producers.
 */
// Generic domain taxonomy shipped with AlienKind. Forkers extend or replace
// these to match their partner's areas of concern — add domain keys + keywords
// for whatever the partner actually acts on (trading, coaching, a specific
// product line, a specific research area, etc.). Domains shipped here are
// ones any organism-style deployment can defensibly reason about.
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  security: ['regulation', 'compliance', 'breach', 'vulnerability', 'attack', 'exploit', 'threat', 'ransomware', 'phishing', 'zero-day', 'patch', 'audit', 'encryption', 'privacy', 'gdpr', 'soc2', 'pentest', 'firewall', 'malware', 'incident'],
  infrastructure: ['ai infrastructure', 'model', 'gpu', 'compute', 'training', 'inference', 'latency', 'api', 'scaling', 'deployment', 'kubernetes', 'docker', 'cloud', 'aws', 'gcp', 'azure', 'database', 'migration', 'observability', 'monitoring'],
  content: ['content', 'article', 'post', 'publish', 'audience', 'engagement', 'newsletter', 'seo', 'social media', 'linkedin', 'twitter', 'podcast', 'video', 'blog'],
  product: ['product', 'feature', 'user experience', 'onboarding', 'retention', 'churn', 'conversion', 'pricing', 'saas', 'platform'],
  world: ['geopolit', 'policy', 'legislation', 'government', 'regulation', 'sanctions', 'election', 'war', 'climate', 'pandemic', 'supply chain', 'trade war', 'tariff'],
};

function classifySecondaryDomains(text: string, primaryDomain: string): string[] {
  const lower = text.toLowerCase();
  const matched = new Set<string>();

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (domain === primaryDomain) continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(domain);
        break; // One match per domain is enough
      }
    }
  }

  return Array.from(matched);
}

/**
 * LLM-based cross-domain classifier — semantic, not keyword.
 *
 * Uses local vLLM-MLX (local inference hardware) for zero-cost semantic classification.
 * The body metaphor: stomach (local models) does digestion, brain (Keel) gets nutrients.
 *
 * Falls back to keyword classifier if local inference unavailable.
 * Returns domains where the finding has MEANINGFUL relevance, not just keyword matches.
 *
 * Merges LLM output with keyword output — union, not replacement. Keywords catch
 * obvious matches fast; LLM catches semantic matches keywords miss.
 */
async function classifySecondaryDomainsLLM(
  text: string,
  primaryDomain: string,
): Promise<string[]> {
  // Always compute keyword baseline — cheap + reliable fallback
  const keywordMatches = classifySecondaryDomains(text, primaryDomain);

  try {
    const { localChat } = require('./local-inference.ts');
    const domains = Object.keys(DOMAIN_KEYWORDS).filter(d => d !== primaryDomain);

    const system = `You classify findings into relevant domains. You are STRICT. Tag a domain ONLY if this specific finding has DIRECT, ACTIONABLE relevance to that domain's practitioner. Do NOT tag domains where relevance is tangential, theoretical, or possible-but-unlikely. Most findings should tag 0-3 domains, never more than 4. Respond with ONLY a JSON array, no explanation.`;

    const prompt = `Finding (primary domain: ${primaryDomain}):
"${text.slice(0, 2000)}"

Candidate domains: ${JSON.stringify(domains)}

For each candidate, ask: "Would a practitioner in THIS domain act differently because of THIS finding?" If no clear action or decision changes, DO NOT tag it.

Example of tight classification: a finding about "auth provider breached" → tag ["security", "infrastructure"] — NOT "product" or "content" (no direct action change for those).

Example: a finding about "new AI model released" → MAYBE tag ["infrastructure"] if it changes compute choices, ["product"] if it changes product capabilities. Only tag a domain if a practitioner in that domain would actually change a decision.

Return strict JSON array of domain names, 0-3 typical, max 4:`;

    const result = await localChat(prompt, {
      system,
      temperature: 0.2,
      maxTokens: 200,
    });

    // Parse JSON array from LLM output (tolerate whitespace/prefix chatter)
    const output = result.content || result.text || '';
    const match = output.match(/\[.*?\]/s);
    if (!match) return keywordMatches;

    let llmDomains: string[] = [];
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        llmDomains = parsed
          .filter((d: any) => typeof d === 'string')
          .filter((d: string) => domains.includes(d))
          .filter((d: string) => d !== primaryDomain);
      }
    } catch {
      return keywordMatches; // parse fail → keyword fallback
    }

    // Hard cap at 4 tags — reject indiscriminate classification (often a sign the
    // LLM returned "all domains" which is equivalent to tagging nothing useful).
    // If LLM returned 5+, fall back to keyword baseline — the LLM output is noise.
    const MAX_TAGS = 4;
    if (llmDomains.length > MAX_TAGS) {
      return keywordMatches;
    }

    // Union LLM + keyword results, respect cap
    const combined = new Set([...keywordMatches, ...llmDomains]);
    const result_arr = Array.from(combined);
    return result_arr.slice(0, MAX_TAGS);
  } catch {
    // Local LLM unavailable — keyword fallback
    return keywordMatches;
  }
}

// ─── Rate-of-Change (Trajectory) Layer ────────────────────────────
// Universal jerk detection. The SINGLE SOURCE OF TRUTH for all derivative
// computation in the organism. Two entry points:
//
// 1. trackMetric(key, value) — any instrument calls this with its metric.
//    Returns { velocity, acceleration }. Circulation owns the math, the
//    history, the state. Resource guardian calls trackMetric('infra.memory.freePct', 6.3).
//    Discernment calls trackMetric('discernment.blocked.rate', 0.03).
//    New instruments get a speedometer by calling one function.
//
// 2. updateTrajectory() — called by the pump every 5 min. Tracks domain-level
//    finding counts automatically. No instrument involvement needed.
//
// Both write to the same trajectory store. One file. One math. One truth.

const TRAJECTORY_FILE = path.resolve(__dirname, '..', '..', 'scripts', 'circulation-trajectory.json');
const TRAJECTORY_WINDOW = 12; // keep last 12 data points per metric

interface DomainTrajectory {
  counts: number[];       // value history (newest last)
  velocity: number;       // first derivative: change per cycle
  acceleration: number;   // second derivative: jerk (velocity change rate)
  lastUpdated: string;
}

interface TrajectoryStore {
  [domain: string]: DomainTrajectory;
}

function loadTrajectory(): TrajectoryStore {
  try {
    return JSON.parse(require('fs').readFileSync(TRAJECTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTrajectory(store: TrajectoryStore): void {
  const fs = require('fs');
  const tmp = TRAJECTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, TRAJECTORY_FILE);
}

/**
 * Track a metric value and get its derivatives back.
 * THE universal speedometer. Any instrument calls this with a key and a value.
 * Circulation owns the math, the history, the storage.
 *
 * Usage:
 *   const { velocity, acceleration } = trackMetric('infra.memory.freePct', 6.3);
 *   const { velocity, acceleration } = trackMetric('behavior.corrections.rate', 0.12);
 *   const { velocity, acceleration } = trackMetric('discernment.blocked.rate', 0.03);
 *
 * Returns: { velocity, acceleration, history } — the instrument gets its
 * speedometer reading without computing anything itself.
 */
function trackMetric(key: string, value: number): { velocity: number; acceleration: number; history: number[] } {
  const store = loadTrajectory();

  if (!store[key]) {
    store[key] = { counts: [], velocity: 0, acceleration: 0, lastUpdated: '' };
  }

  const t = store[key];
  t.counts.push(value);
  if (t.counts.length > TRAJECTORY_WINDOW) t.counts.shift();
  t.lastUpdated = new Date().toISOString();

  // First derivative
  if (t.counts.length >= 2) {
    t.velocity = t.counts[t.counts.length - 1] - t.counts[t.counts.length - 2];
  } else {
    t.velocity = 0;
  }

  // Second derivative (jerk)
  if (t.counts.length >= 3) {
    const prevVelocity = t.counts[t.counts.length - 2] - t.counts[t.counts.length - 3];
    t.acceleration = t.velocity - prevVelocity;
  } else {
    t.acceleration = 0;
  }

  saveTrajectory(store);
  return { velocity: t.velocity, acceleration: t.acceleration, history: [...t.counts] };
}

/**
 * Update trajectory for all domains based on current circulation state.
 * Called by the pump on every cycle. Computes velocity and acceleration
 * automatically — no per-surface wiring needed.
 */
async function updateTrajectory(): Promise<TrajectoryStore> {
  const { supabaseGet } = getSb();
  const store = loadTrajectory();
  const now = new Date();

  try {
    // Count active findings per domain (not expired, created in last hour)
    const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const recent = await supabaseGet(
      'circulation',
      `select=domain&created_at=gte.${oneHourAgo}&action_status=eq.pending&order=created_at.desc&limit=500`
    );

    // Count per domain
    const domainCounts: Record<string, number> = {};
    for (const r of recent) {
      const d = r.domain || 'unknown';
      domainCounts[d] = (domainCounts[d] || 0) + 1;
    }

    // Also track domains that had findings before but now have zero
    for (const domain of Object.keys(store)) {
      if (!(domain in domainCounts)) domainCounts[domain] = 0;
    }

    // Update each domain's trajectory
    for (const [domain, count] of Object.entries(domainCounts)) {
      if (!store[domain]) {
        store[domain] = { counts: [], velocity: 0, acceleration: 0, lastUpdated: '' };
      }

      const t = store[domain];
      t.counts.push(count);
      if (t.counts.length > TRAJECTORY_WINDOW) t.counts.shift();
      t.lastUpdated = now.toISOString();

      // First derivative: change in finding count per cycle
      if (t.counts.length >= 2) {
        t.velocity = t.counts[t.counts.length - 1] - t.counts[t.counts.length - 2];
      }

      // Second derivative: change in velocity (jerk)
      if (t.counts.length >= 3) {
        const prevVelocity = t.counts[t.counts.length - 2] - t.counts[t.counts.length - 3];
        t.acceleration = t.velocity - prevVelocity;
      }
    }

    saveTrajectory(store);
    return store;
  } catch {
    return store;
  }
}

/**
 * Get trajectory for a specific domain or all domains.
 * Any organ can call this to see if its domain is accelerating.
 */
function getTrajectory(domain?: string): TrajectoryStore | DomainTrajectory | null {
  const store = loadTrajectory();
  if (domain) return store[domain] || null;
  return store;
}

/**
 * Get domains with concerning trajectories (accelerating finding counts).
 * Used by the pump to escalate and by digest surfaces to expose trends.
 */
function getAcceleratingDomains(minVelocity: number = 2, minAcceleration: number = 1): Array<{ domain: string; trajectory: DomainTrajectory }> {
  const store = loadTrajectory();
  return Object.entries(store)
    .filter(([_, t]) => t.velocity >= minVelocity && t.acceleration >= minAcceleration)
    .map(([domain, trajectory]) => ({ domain, trajectory }))
    .sort((a, b) => b.trajectory.acceleration - a.trajectory.acceleration);
}

// --- Response-Time Findings (read-only, lightweight) ---

/**
 * Get relevant circulation findings for response-time injection.
 * Read-only — does NOT mark findings as consumed.
 * Single Supabase query, decay-aware intensity filtering.
 *
 * Designed for buildChannelPrompt: inject organism-wide signals into
 * every response so channels are aware of cross-organ findings.
 *
 * @param domain - Filter to this domain (undefined = all domains)
 * @param limit - Max findings to return (default 5)
 * @param minIntensity - Minimum effective intensity after decay (default 0.5)
 */
async function getRelevantFindings(opts: {
  domain?: string;
  limit?: number;
  minIntensity?: number;
} = {}): Promise<CirculationFinding[]> {
  const { supabaseGet } = getSb();
  const limit = opts.limit || 5;
  const minIntensity = opts.minIntensity || 0.5;

  try {
    // Single query: pending findings, ordered by recency, generous limit for post-filter
    let query = `select=*&action_status=eq.pending&order=created_at.desc&limit=50`;
    if (opts.domain) query += `&or=(domain.eq.${encodeURIComponent(opts.domain)},secondary_domains.cs.${encodeURIComponent(JSON.stringify([opts.domain]))})`;

    const rows = await supabaseGet('circulation', query);
    const now = Date.now();
    const results: CirculationFinding[] = [];

    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      const ageHours = (now - createdAt) / (1000 * 60 * 60);
      const intensity = computeIntensity(
        row.initial_intensity || 1.0,
        row.reinforcement_count || 1,
        ageHours,
        row.decay_hours || 24,
      );

      if (intensity < minIntensity) continue;

      const secondaryDomains = Array.isArray(row.secondary_domains)
        ? row.secondary_domains
        : JSON.parse(row.secondary_domains || '[]');

      results.push({
        id: row.id,
        source_organ: row.source_organ,
        finding: row.finding,
        finding_type: row.finding_type,
        domain: row.domain,
        secondary_domains: secondaryDomains,
        confidence: row.confidence,
        effective_intensity: Math.round(intensity * 1000) / 1000,
        reinforcement_count: row.reinforcement_count,
        quorum_reached: row.quorum_reached,
        action_tier: row.action_tier,
        action_status: row.action_status,
        related_files: (Array.isArray(row.related_files) ? row.related_files : JSON.parse(row.related_files || '[]')),
        created_at: row.created_at,
        age_hours: Math.round(ageHours * 10) / 10,
      });
    }

    // Sort by intensity, take top N
    results.sort((a, b) => b.effective_intensity - a.effective_intensity);
    return results.slice(0, limit);
  } catch {
    return []; // Never block response generation on circulation failure
  }
}

/**
 * Format circulation findings as a compact string for prompt injection.
 * One line per finding: [domain/type] source: finding (intensity)
 */
function formatFindingsForPrompt(findings: CirculationFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map(f => {
    const truncated = f.finding.length > 200 ? f.finding.slice(0, 200) + '...' : f.finding;
    return `- [${f.domain}/${f.finding_type}] ${f.source_organ}: ${truncated} (intensity: ${f.effective_intensity.toFixed(2)}, ${f.age_hours}h ago)`;
  });
  return lines.join('\n');
}

module.exports = { deposit, withdraw, reinforce, recordAction, getActionable, stats, computeIntensity, delegateTask, classifySecondaryDomains, classifySecondaryDomainsLLM, trackMetric, updateTrajectory, getTrajectory, getAcceleratingDomains, getRelevantFindings, formatFindingsForPrompt, DECAY_HOURS, QUORUM_DEFAULTS, DOMAIN_KEYWORDS };
