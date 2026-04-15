#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Circulation Pump — the organism's heart.
 *
 * Reads actionable findings from the circulation table (quorum reached,
 * pending action) and routes them to the appropriate response:
 *
 *   T1 (auto-fix): spawn builder-mode session on preview branch
 *   T2 (fix + inform): execute fix, send Telegram alert to [HUMAN]
 *   T3 (surface): queue for morning brief, send Telegram summary
 *
 * Also handles:
 *   - Reinforcement detection: finds similar recent deposits from different
 *     organs and reinforces existing findings instead of duplicating
 *   - Expired finding cleanup: marks findings past decay threshold as expired
 *   - Circulation stats logging
 *
 * Runs every 5 minutes via daemon. Builder mode (can't send externally
 * for T2/T3 — those queue via Telegram outbox or daily file).
 *
 * Usage:
 *   npx tsx scripts/circulation-pump.ts              # normal run
 *   npx tsx scripts/circulation-pump.ts --stats       # show circulation health
 *   npx tsx scripts/circulation-pump.ts --prune       # clean expired findings
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, createLogger } = require('./lib/shared.ts');
const { logToDaily } = require('./lib/keel-env.ts');

const KEEL_DIR = path.resolve(__dirname, '..');
Object.assign(process.env, loadEnv(path.join(KEEL_DIR, '.env')));

const LOG_DIR = path.join(KEEL_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const DATE = new Date().toISOString().split('T')[0];
const { log } = createLogger(path.join(LOG_DIR, `circulation-pump-${DATE}.log`));

const { withdraw, getActionable, stats, recordAction, reinforce, computeIntensity } = require('./lib/circulation.ts');
const { supabaseGet, supabasePatch, supabaseDelete } = require('./lib/supabase.ts');

// --- Reinforcement Detection ---

/**
 * Scan recent findings for similar deposits from different organs.
 * If two organs deposited similar findings, reinforce instead of duplicate.
 *
 * Similarity: same domain + same finding_type + text overlap > 50%
 */
async function detectAndReinforce(): Promise<number> {
  let reinforced = 0;
  try {
    const recent = await supabaseGet(
      'circulation',
      'select=id,source_organ,finding,finding_type,domain,reinforcement_count,reinforced_by,created_at&action_status=eq.pending&order=created_at.desc&limit=50'
    );

    // Group by domain + finding_type
    const groups = new Map<string, any[]>();
    for (const r of recent) {
      const key = `${r.domain}:${r.finding_type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    // Within each group, check for text similarity
    for (const items of Array.from(groups.values())) {
      if (items.length < 2) continue;

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];

          // Same-organ duplicate detection: if same organ deposited near-identical
          // findings, mark the newer one as expired (dedup, not reinforcement)
          if (a.source_organ === b.source_organ) {
            const aWords = a.finding.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            const bSet = new Set(b.finding.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));
            let dup = 0;
            for (const w of aWords) { if (bSet.has(w)) dup++; }
            const dupRate = dup / Math.max(aWords.length, bSet.size);
            if (dupRate > 0.6) {
              // Near-duplicate from same organ — expire the newer one
              const newer = new Date(a.created_at) > new Date(b.created_at) ? a : b;
              try {
                await supabasePatch('circulation', `id=eq.${newer.id}`, { action_status: 'expired' });
                log('INFO', `Same-organ dedup: expired duplicate from ${newer.source_organ} (${(dupRate * 100).toFixed(0)}% overlap)`);
                reinforced++; // Count as a cleanup action
              } catch {}
            }
            continue; // Same organ — don't reinforce, only dedup
          }

          // Skip if already reinforced by each other
          const aReinforced = JSON.parse(a.reinforced_by || '[]');
          const bReinforced = JSON.parse(b.reinforced_by || '[]');
          if (aReinforced.includes(b.source_organ) || bReinforced.includes(a.source_organ)) continue;

          // Two-pass similarity: word overlap (fast) then local model (semantic)
          const aWordsArr = a.finding.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
          const bWordsSet = new Set(b.finding.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));
          let overlap = 0;
          for (const w of aWordsArr) {
            if (bWordsSet.has(w)) overlap++;
          }
          const wordSimilarity = overlap / Math.max(aWordsArr.length, bWordsSet.size);

          let shouldReinforce = wordSimilarity > 0.4;

          // Pass 2: local model for ambiguous cases (20-40% word overlap)
          if (!shouldReinforce && wordSimilarity > 0.15) {
            try {
              const http = require('http');
              const llmResult = await new Promise<string>((resolve) => {
                const timeout = setTimeout(() => resolve(''), 8000);
                const body = JSON.stringify({
                  model: 'mlx-community/Qwen3.5-27B-4bit',
                  messages: [{ role: 'user', content: `Are these two findings describing the same issue? Answer ONLY "yes" or "no".\n\nFinding A: ${a.finding.slice(0, 200)}\n\nFinding B: ${b.finding.slice(0, 200)}` }],
                  max_tokens: 5, temperature: 0.1,
                });
                const req = http.request({ hostname: '127.0.0.1', port: 8000, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000 }, (res: any) => {
                  let data = '';
                  res.on('data', (c: string) => data += c);
                  res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data).choices?.[0]?.message?.content || ''); } catch { resolve(''); } });
                });
                req.on('error', () => { clearTimeout(timeout); resolve(''); });
                req.write(body); req.end();
              });
              shouldReinforce = llmResult.toLowerCase().trim().startsWith('yes');
              if (shouldReinforce) log('INFO', `Local model confirmed similarity between ${a.source_organ} and ${b.source_organ}`);
            } catch { /* local model unavailable — word overlap is final */ }
          }

          if (shouldReinforce) {
            const older = new Date(a.created_at) < new Date(b.created_at) ? a : b;
            const newer = older === a ? b : a;
            const reinforced_ok = await reinforce(older.id, newer.source_organ);
            if (reinforced_ok) {
              reinforced++;
              log('INFO', `Reinforced: ${older.source_organ}'s finding by ${newer.source_organ} (word: ${(wordSimilarity * 100).toFixed(0)}%)`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    log('WARN', `Reinforcement detection failed: ${err.message}`);
  }
  return reinforced;
}

// --- Cascade Detection (Sliding Window) ---

/**
 * Detect cascading failures via a sliding window over pump cycles.
 *
 * Tracks finding frequency per source×domain across the last 6 pump cycles
 * (30 minutes at 5-minute intervals). Two detection modes:
 *
 *   1. Source flooding: same source deposits CASCADE_SOURCE_THRESHOLD+ findings
 *      in a source×domain pair within the window.
 *   2. Domain clustering: CASCADE_DOMAIN_THRESHOLD+ findings from 2+ different
 *      sources cluster in the same domain within the window.
 *
 * Cascade findings get action_tier 'escalate', bypass normal decay (168h),
 * and route to Telegram alerts immediately.
 *
 * The [CLIENT_NAME] synthesis corruption (2026-04-03) ran 4 hours through 4+
 * pump cycles undetected because each finding was processed individually.
 * This sliding window catches that pattern within 30 minutes.
 *
 * Window state persists in circulation-pump-state.json.
 */

const CASCADE_STATE_FILE = path.join(KEEL_DIR, 'scripts', 'circulation-pump-state.json');
const CASCADE_WINDOW_CYCLES = 6;   // last 6 pump cycles = 30 minutes
const CASCADE_SOURCE_THRESHOLD = 3; // same source deposits N+ findings
const CASCADE_DOMAIN_THRESHOLD = 3; // different sources cluster N+ in same domain
const CASCADE_DECAY_HOURS = 168;    // 7 days — bypass normal decay
const CASCADE_COOLDOWN_MS = 30 * 60 * 1000; // don't re-detect same key within 30min

interface CycleDeposit {
  source: string;
  domain: string;
  finding_id: string;
  finding_preview: string;
}

interface CycleSnapshot {
  timestamp: string;
  deposits: CycleDeposit[];
}

interface DetectedCascade {
  key: string;
  timestamp: string;
  cascade_id: string;
}

interface CascadeState {
  cycles: CycleSnapshot[];
  detected_cascades: DetectedCascade[];
}

function loadCascadeState(): CascadeState {
  try {
    if (fs.existsSync(CASCADE_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CASCADE_STATE_FILE, 'utf-8'));
      return {
        cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
        detected_cascades: Array.isArray(raw.detected_cascades) ? raw.detected_cascades : [],
      };
    }
  } catch {}
  return { cycles: [], detected_cascades: [] };
}

function saveCascadeState(state: CascadeState): void {
  state.cycles = state.cycles.slice(-CASCADE_WINDOW_CYCLES);
  // Expire old cascade detections (older than cooldown window)
  const cutoff = Date.now() - CASCADE_COOLDOWN_MS;
  state.detected_cascades = state.detected_cascades
    .filter(c => new Date(c.timestamp).getTime() > cutoff)
    .slice(-50);
  fs.writeFileSync(CASCADE_STATE_FILE, JSON.stringify(state, null, 2));
}

function isCascadeCoolingDown(state: CascadeState, key: string): boolean {
  const cutoff = Date.now() - CASCADE_COOLDOWN_MS;
  return state.detected_cascades.some(
    c => c.key === key && new Date(c.timestamp).getTime() > cutoff
  );
}

async function detectCascades(): Promise<number> {
  const state = loadCascadeState();
  let cascadesDetected = 0;

  try {
    // Determine what's new since last cycle
    const lastCycleTime = state.cycles.length > 0
      ? state.cycles[state.cycles.length - 1].timestamp
      : new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Query new deposits since last cycle (exclude pump's own cascade findings)
    const newFindings = await supabaseGet(
      'circulation',
      `select=id,source_organ,domain,finding,created_at&created_at=gt.${lastCycleTime}&action_status=eq.pending&source_organ=neq.circulation-pump&order=created_at.desc&limit=100`
    );

    // Record current cycle
    const currentCycle: CycleSnapshot = {
      timestamp: new Date().toISOString(),
      deposits: newFindings.map((f: any) => ({
        source: f.source_organ,
        domain: f.domain,
        finding_id: f.id,
        finding_preview: (f.finding || '').slice(0, 120),
      })),
    };
    state.cycles.push(currentCycle);

    // Trim to window size
    if (state.cycles.length > CASCADE_WINDOW_CYCLES) {
      state.cycles = state.cycles.slice(-CASCADE_WINDOW_CYCLES);
    }

    // Aggregate all deposits across the window
    const windowDeposits = state.cycles.flatMap(c => c.deposits);
    if (windowDeposits.length < CASCADE_SOURCE_THRESHOLD) {
      saveCascadeState(state);
      return 0;
    }

    const windowMinutes = state.cycles.length * 5;

    // --- Mode 1: Source flooding (same source × domain) ---
    const sourceDomainMap = new Map<string, CycleDeposit[]>();
    for (const d of windowDeposits) {
      const key = `${d.source}|${d.domain}`;
      if (!sourceDomainMap.has(key)) sourceDomainMap.set(key, []);
      sourceDomainMap.get(key)!.push(d);
    }

    for (const entry of Array.from(sourceDomainMap.entries())) {
      const key = entry[0];
      const deposits = entry[1];
      if (deposits.length < CASCADE_SOURCE_THRESHOLD) continue;

      const cascadeKey = `src:${key}`;
      if (isCascadeCoolingDown(state, cascadeKey)) continue;

      const [source, domain] = key.split('|');
      const cascadeId = `cascade-src-${source}-${domain}-${Date.now()}`;
      const samples = deposits.slice(0, 2).map((d: CycleDeposit) => `"${d.finding_preview}"`).join(', ');

      const { deposit } = require('./lib/circulation.ts');
      await deposit({
        source_organ: 'circulation-pump',
        finding: `CASCADE (source flooding): ${source} deposited ${deposits.length} findings in ${domain} across ${state.cycles.length} pump cycles (${windowMinutes}min). Samples: ${samples}. Systemic issue — not ${deposits.length} individual incidents.`,
        finding_type: 'anomaly',
        domain: domain,
        confidence: 0.9,
        action_tier: 'escalate',
        decay_hours: CASCADE_DECAY_HOURS,
        metadata: {
          cascade_id: cascadeId,
          cascade_type: 'source_flooding',
          source_organ: source,
          count: deposits.length,
          window_cycles: state.cycles.length,
          window_minutes: windowMinutes,
          constituent_ids: deposits.map((d: CycleDeposit) => d.finding_id),
        },
      });

      // Route to Telegram
      try {
        const outboxFile = path.join(KEEL_DIR, 'logs', 'circulation-telegram-outbox.txt');
        const msg = `[CASCADE] ${source} in ${domain}: ${deposits.length} findings in ${windowMinutes}min. Sample: "${deposits[0].finding_preview}"`;
        fs.appendFileSync(outboxFile, msg + '\n---TELEGRAM_MSG---\n');
      } catch { /* best effort */ }

      // Write to daily file
      logToDaily(`CASCADE: ${source} in ${domain}: ${deposits.length} findings in ${windowMinutes}min. Escalated.`, 'Pump');

      state.detected_cascades.push({ key: cascadeKey, timestamp: new Date().toISOString(), cascade_id: cascadeId });
      cascadesDetected++;
      log('INFO', `CASCADE (source): ${source} in ${domain} — ${deposits.length} findings in ${windowMinutes}min`);
    }

    // --- Mode 2: Domain clustering (different sources, same domain) ---
    const domainMap = new Map<string, Map<string, CycleDeposit[]>>();
    for (const d of windowDeposits) {
      if (!domainMap.has(d.domain)) domainMap.set(d.domain, new Map());
      const sources = domainMap.get(d.domain)!;
      if (!sources.has(d.source)) sources.set(d.source, []);
      sources.get(d.source)!.push(d);
    }

    for (const domEntry of Array.from(domainMap.entries())) {
      const domain = domEntry[0];
      const sources = domEntry[1];
      const uniqueSources = sources.size;
      if (uniqueSources < 2) continue; // need multiple sources for domain clustering

      const totalDeposits = Array.from(sources.values()).reduce((sum: number, arr: CycleDeposit[]) => sum + arr.length, 0);
      if (totalDeposits < CASCADE_DOMAIN_THRESHOLD) continue;

      const cascadeKey = `dom:${domain}`;
      if (isCascadeCoolingDown(state, cascadeKey)) continue;

      const cascadeId = `cascade-dom-${domain}-${Date.now()}`;
      const sourceNames = Array.from(sources.keys());
      const allDeposits: CycleDeposit[] = Array.from(sources.values()).reduce((acc: CycleDeposit[], arr: CycleDeposit[]) => acc.concat(arr), []);

      const { deposit } = require('./lib/circulation.ts');
      await deposit({
        source_organ: 'circulation-pump',
        finding: `CASCADE (domain cluster): ${uniqueSources} sources (${sourceNames.join(', ')}) deposited ${totalDeposits} findings in ${domain} across ${state.cycles.length} pump cycles (${windowMinutes}min). Convergent signal — multiple organs flagging same domain.`,
        finding_type: 'anomaly',
        domain: domain,
        confidence: 0.95,
        action_tier: 'escalate',
        decay_hours: CASCADE_DECAY_HOURS,
        metadata: {
          cascade_id: cascadeId,
          cascade_type: 'domain_cluster',
          sources: sourceNames,
          count: totalDeposits,
          unique_sources: uniqueSources,
          window_cycles: state.cycles.length,
          window_minutes: windowMinutes,
          constituent_ids: allDeposits.map((d: CycleDeposit) => d.finding_id),
        },
      });

      // Route to Telegram
      try {
        const outboxFile = path.join(KEEL_DIR, 'logs', 'circulation-telegram-outbox.txt');
        const msg = `[CASCADE] Domain ${domain}: ${totalDeposits} findings from ${uniqueSources} sources in ${windowMinutes}min. Sources: ${sourceNames.join(', ')}`;
        fs.appendFileSync(outboxFile, msg + '\n---TELEGRAM_MSG---\n');
      } catch { /* best effort */ }

      // Write to daily file
      logToDaily(`CASCADE: Domain ${domain}: ${totalDeposits} findings from ${uniqueSources} sources in ${windowMinutes}min. Escalated.`, 'Pump');

      state.detected_cascades.push({ key: cascadeKey, timestamp: new Date().toISOString(), cascade_id: cascadeId });
      cascadesDetected++;
      log('INFO', `CASCADE (domain): ${domain} — ${totalDeposits} findings from ${uniqueSources} sources in ${windowMinutes}min`);
    }
  } catch (err: any) {
    log('WARN', `Cascade detection failed: ${err.message}`);
  }

  saveCascadeState(state);
  return cascadesDetected;
}

// --- Expired Finding Cleanup ---

async function pruneExpired(): Promise<number> {
  let pruned = 0;
  try {
    const all = await supabaseGet(
      'circulation',
      'select=id,initial_intensity,reinforcement_count,decay_hours,created_at,action_status&action_status=eq.pending&order=created_at.asc&limit=200'
    );
    const now = Date.now();

    for (const row of all) {
      const ageHours = (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
      const intensity = computeIntensity(
        row.initial_intensity || 1.0,
        row.reinforcement_count || 1,
        ageHours,
        row.decay_hours || 24
      );

      if (intensity < 0.01) {
        // Below 1% intensity — effectively expired
        await supabasePatch('circulation', `id=eq.${row.id}`, {
          action_status: 'expired',
          updated_at: new Date().toISOString(),
        });
        pruned++;
      }
    }
  } catch (err: any) {
    log('WARN', `Prune failed: ${err.message}`);
  }
  return pruned;
}

// --- Actionable Finding Router ---

async function routeActionable(): Promise<{ build: number; fix: number; report: number; escalate: number }> {
  const counts = { build: 0, fix: 0, report: 0, escalate: 0 };

  try {
    const actionable = await getActionable();
    if (actionable.length === 0) return counts;

    log('INFO', `${actionable.length} actionable finding(s) to route`);

    for (const finding of actionable) {
      // Map tiers: build (new capability), fix (repair), report (inform)
      // Legacy T1/T2/T3 still accepted for backward compatibility
      const tier = finding.action_tier || 'report';
      const normalizedTier = tier === 'T1' ? 'build' : tier === 'T2' ? 'fix' : tier === 'T3' ? 'report' : tier;

      switch (normalizedTier) {
        case 'build': {
          // BUILD: new capability needed. Queue for keel-research to build on preview branch.
          // This is the autonomous product builder's entry point from circulation.
          try {
            const { supabasePost: sbPost } = require('./lib/supabase.ts');
            await sbPost('capability_requests', {
              source: 'circulation-pump',
              source_prefix: finding.source_organ,
              user_message: finding.finding,
              gap_type: 'tool_needed',
              status: 'detected',
            });
            await recordAction(finding.id, 'queued_for_build', `BUILD: queued for keel-research to build on preview branch`, log);
            log('INFO', `BUILD queued: ${finding.finding.slice(0, 80)}`);
          } catch {
            await recordAction(finding.id, 'acknowledged', `BUILD: queue failed`, log);
            log('WARN', `BUILD queue failed: ${finding.finding.slice(0, 80)}`);
          }
          counts.build++;
          break;
        }

        case 'fix': {
          // FIX: something broken. Queue for intent-audit to repair on preview branch + inform [HUMAN].
          try {
            const { supabasePost: sbPost } = require('./lib/supabase.ts');
            await sbPost('capability_requests', {
              source: 'circulation-pump',
              source_prefix: finding.source_organ,
              user_message: finding.finding,
              gap_type: 'explicit_gap',
              status: 'detected',
            });
          } catch {}
          // Also inform [HUMAN] via Telegram outbox
          try {
            const outboxFile = path.join(KEEL_DIR, 'logs', 'circulation-telegram-outbox.txt');
            const msg = `[FIX] ${finding.source_organ} (${finding.domain}): ${finding.finding.slice(0, 300)}`;
            fs.appendFileSync(outboxFile, msg + '\n---TELEGRAM_MSG---\n');
          } catch {}
          await recordAction(finding.id, 'queued_for_fix', `FIX: queued for intent-audit + Telegram`, log);
          counts.fix++;
          log('INFO', `FIX queued: ${finding.finding.slice(0, 80)}`);
          break;
        }

        case 'escalate': {
          // ESCALATE: cascade/systemic issue. Telegram immediately + capability_requests.
          // Bypasses normal routing — this is urgent.
          try {
            const outboxFile = path.join(KEEL_DIR, 'logs', 'circulation-telegram-outbox.txt');
            const msg = `[ESCALATE] ${finding.source_organ} (${finding.domain}): ${finding.finding.slice(0, 300)}`;
            fs.appendFileSync(outboxFile, msg + '\n---TELEGRAM_MSG---\n');
          } catch {}
          try {
            const { supabasePost: sbPost } = require('./lib/supabase.ts');
            await sbPost('capability_requests', {
              source: 'circulation-pump',
              source_prefix: finding.source_organ,
              user_message: finding.finding,
              gap_type: 'explicit_gap',
              status: 'detected',
            });
          } catch {}
          logToDaily(`ESCALATE: ${finding.source_organ}: ${finding.finding.slice(0, 200)}`, 'Pump');
          await recordAction(finding.id, 'escalated', `ESCALATE: Telegram alert + capability_requests + daily file`, log);
          counts.escalate++;
          log('INFO', `ESCALATE: ${finding.finding.slice(0, 80)}`);
          break;
        }

        case 'report':
        default: {
          // REPORT: observation, pattern, insight. Surface in morning brief.
          // Telegram only if urgent (security critical, time-sensitive).
          logToDaily(`REPORT: ${finding.source_organ}: ${finding.finding.slice(0, 200)}`, 'Pump');
          // Telegram for urgent reports (security anomalies, critical findings)
          if (finding.domain === 'security' && finding.finding_type === 'anomaly') {
            try {
              const outboxFile = path.join(KEEL_DIR, 'logs', 'circulation-telegram-outbox.txt');
              const msg = `[URGENT REPORT] ${finding.source_organ} (${finding.domain}): ${finding.finding.slice(0, 300)}`;
              fs.appendFileSync(outboxFile, msg + '\n---TELEGRAM_MSG---\n');
            } catch {}
          }
          await recordAction(finding.id, 'reported', `REPORT: morning brief + ${finding.domain === 'security' ? 'Telegram' : 'daily file only'}`, log);
          counts.report++;
          log('INFO', `REPORT: ${finding.finding.slice(0, 80)}`);
          break;
        }
      }
    }
  } catch (err: any) {
    log('WARN', `Routing failed: ${err.message}`);
  }

  return counts;
}

// --- Adaptive Quorum Calibration ---

async function calibrateQuorum(): Promise<void> {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const actioned = await supabaseGet(
      'circulation',
      `select=finding_type,action_status&created_at=gte.${weekAgo}&action_status=in.(actioned,dismissed)&limit=200`
    );
    if (actioned.length < 10) return;

    const byType = new Map<string, { actioned: number; dismissed: number }>();
    for (const row of actioned) {
      const t = row.finding_type;
      if (!byType.has(t)) byType.set(t, { actioned: 0, dismissed: 0 });
      const entry = byType.get(t)!;
      if (row.action_status === 'actioned') entry.actioned++;
      else entry.dismissed++;
    }

    const { QUORUM_DEFAULTS } = require('./lib/circulation.ts');
    for (const entry of Array.from(byType.entries())) {
      const type = entry[0];
      const counts = entry[1];
      const total = counts.actioned + counts.dismissed;
      if (total < 5) continue;
      const actionRate = counts.actioned / total;
      const current = QUORUM_DEFAULTS[type] || 1;
      let adjusted = current;
      if (actionRate > 0.8 && current > 1) adjusted = current - 1;
      else if (actionRate < 0.3 && current < 5) adjusted = current + 1;
      if (adjusted !== current) {
        QUORUM_DEFAULTS[type] = adjusted;
        log('INFO', `Quorum calibrated: ${type} ${current} → ${adjusted} (action rate: ${(actionRate * 100).toFixed(0)}%)`);
      }
    }
  } catch (err: any) {
    log('WARN', `Quorum calibration failed: ${err.message}`);
  }
}

// --- Delegated Task Processing ---

/**
 * Process delegated tasks from circulation.
 * When a terminal deposits a task via delegateTask(), the pump picks it up
 * and queues it for execution — either via capability_requests (for code fixes)
 * or via an outbox (for tasks that need a fresh session).
 */
async function processDelegatedTasks(): Promise<number> {
  let processed = 0;
  try {
    // Find delegation findings that haven't been actioned
    const delegations = await supabaseGet(
      'circulation',
      'select=*&action_status=eq.pending&finding=like.TASK DELEGATION*&order=created_at.desc&limit=10'
    );

    for (const row of delegations) {
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      if (!metadata.delegated) continue;

      const task = metadata.task || row.finding;
      const requiredMode = metadata.requiredMode || 'builder';

      // Route to capability_requests for the intent-audit to pick up
      try {
        const { supabasePost: sbPost } = require('./lib/supabase.ts');
        await sbPost('capability_requests', {
          source: 'delegation',
          source_prefix: metadata.fromTerminal || 'unknown',
          user_message: task,
          gap_type: 'explicit_gap',
          status: 'detected',
        });

        await recordAction(row.id, 'delegated_to_intent_audit',
          `Task queued for intent-audit: ${task.slice(0, 100)}`, log);
        log('INFO', `Delegated task queued: ${task.slice(0, 80)}`);
        processed++;
      } catch (err: any) {
        log('WARN', `Failed to process delegation: ${err.message}`);
      }
    }
  } catch (err: any) {
    log('WARN', `Delegation processing failed: ${err.message}`);
  }
  return processed;
}

// --- Cross-Domain Semantic Synthesis ---

/**
 * Find connections across domains using vector similarity.
 * When findings from different domains are semantically similar,
 * deposit a synthesis finding that connects them.
 */
async function crossDomainSynthesis(): Promise<number> {
  let synthesized = 0;
  try {
    // Dedup: load existing synthesis findings to avoid re-depositing same pairs
    const existingSyntheses = await supabaseGet(
      'circulation',
      'select=metadata&source_organ=eq.circulation-pump&finding_type=eq.insight&action_status=neq.expired&limit=200'
    );
    const seenPairs = new Set<string>();
    for (const row of existingSyntheses) {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      if (meta?.domainA && meta?.domainB) {
        seenPairs.add(`${meta.domainA}:${meta.domainB}`);
        seenPairs.add(`${meta.domainB}:${meta.domainA}`);
      }
    }

    // Get recent findings that HAVE embeddings, from different domains
    const withEmbeddings = await supabaseGet(
      'circulation',
      'select=id,source_organ,finding,domain,embedding,created_at&embedding=not.is.null&action_status=eq.pending&order=created_at.desc&limit=30'
    );

    if (withEmbeddings.length < 2) return 0;

    // Group by domain
    const byDomain = new Map<string, any[]>();
    for (const row of withEmbeddings) {
      if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
      byDomain.get(row.domain)!.push(row);
    }

    // Compare findings ACROSS domains using cosine similarity
    const domains = Array.from(byDomain.keys());
    for (let d1 = 0; d1 < domains.length; d1++) {
      for (let d2 = d1 + 1; d2 < domains.length; d2++) {
        const group1 = byDomain.get(domains[d1])!;
        const group2 = byDomain.get(domains[d2])!;

        for (const a of group1) {
          for (const b of group2) {
            if (!a.embedding || !b.embedding) continue;

            // Skip already-synthesized domain pairs
            if (seenPairs.has(`${a.domain}:${b.domain}`)) continue;

            const embA = typeof a.embedding === 'string' ? JSON.parse(a.embedding) : a.embedding;
            const embB = typeof b.embedding === 'string' ? JSON.parse(b.embedding) : b.embedding;

            // Cosine similarity
            if (!Array.isArray(embA) || !Array.isArray(embB) || embA.length !== embB.length) continue;
            let dot = 0, magA = 0, magB = 0;
            for (let i = 0; i < embA.length; i++) {
              dot += embA[i] * embB[i];
              magA += embA[i] * embA[i];
              magB += embB[i] * embB[i];
            }
            const similarity = dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);

            if (similarity > 0.75) {
              // High cross-domain similarity — synthesize
              const { deposit } = require('./lib/circulation.ts');
              await deposit({
                source_organ: 'circulation-pump',
                finding: `Cross-domain connection: [${a.domain}] ${a.source_organ}: "${a.finding.slice(0, 80)}" ↔ [${b.domain}] ${b.source_organ}: "${b.finding.slice(0, 80)}" (similarity: ${(similarity * 100).toFixed(0)}%)`,
                finding_type: 'insight',
                domain: 'self',
                confidence: similarity,
                action_tier: 'T3',
                metadata: { findingA: a.id, findingB: b.id, domainA: a.domain, domainB: b.domain, similarity },
              });
              synthesized++;
              seenPairs.add(`${a.domain}:${b.domain}`);
              seenPairs.add(`${b.domain}:${a.domain}`);
              log('INFO', `Cross-domain synthesis: ${a.domain} ↔ ${b.domain} (${(similarity * 100).toFixed(0)}%)`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    log('WARN', `Cross-domain synthesis failed: ${err.message}`);
  }
  return synthesized;
}

// --- Embedding Generation ---

/**
 * Embed findings that don't have embeddings yet.
 * Uses vLLM-MLX embedding model (same as memory_chunks).
 */
async function embedNewFindings(): Promise<number> {
  let embedded = 0;
  try {
    const unembedded = await supabaseGet(
      'circulation',
      'select=id,finding&embedding=is.null&action_status=eq.pending&limit=10'
    );
    if (unembedded.length === 0) return 0;

    const http = require('http');
    for (const row of unembedded) {
      try {
        const embResult = await new Promise<number[] | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 3000);
          const body = JSON.stringify({ model: 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ', input: row.finding.slice(0, 500) });
          const req = http.request({ hostname: '127.0.0.1', port: 8000, path: '/v1/embeddings', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3000 }, (res: any) => {
            let data = '';
            res.on('data', (c: string) => data += c);
            res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data).data?.[0]?.embedding || null); } catch { resolve(null); } });
          });
          req.on('error', () => { clearTimeout(timeout); resolve(null); });
          req.write(body); req.end();
        });

        if (embResult && embResult.length > 0) {
          const vecStr = `[${embResult.join(',')}]`;
          await supabasePatch('circulation', `id=eq.${row.id}`, { embedding: vecStr });
          embedded++;
        }
      } catch { /* skip this finding */ }
    }
  } catch (err: any) {
    log('WARN', `Embedding failed: ${err.message}`);
  }
  return embedded;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--stats')) {
    const s = await stats();
    console.log('Circulation health:', s);
    return;
  }

  if (args.includes('--prune')) {
    const pruned = await pruneExpired();
    console.log(`Pruned ${pruned} expired findings`);
    return;
  }

  log('INFO', '=== Circulation Pump Starting ===');

  // Step 1: Detect and reinforce similar findings from different organs
  const reinforced = await detectAndReinforce();

  // Step 2: Detect cascading failures (same organ, repeated similar findings)
  const cascades = await detectCascades();

  // Step 3: Route actionable findings (quorum reached)
  const routed = await routeActionable();

  // Step 4: Embed new findings (vector for semantic cross-organ discovery)
  const embedded = await embedNewFindings();

  // Step 5: Process delegated tasks
  const delegated = await processDelegatedTasks();

  // Step 6: Cross-domain semantic synthesis (finds connections across domains)
  const synthesized = await crossDomainSynthesis();

  // Step 7: Prune expired findings
  const pruned = await pruneExpired();

  // Step 8: Adaptive quorum calibration (daily at 1 AM, or on --calibrate flag)
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  if ((hour === 1 && minute < 5) || process.argv.includes('--calibrate')) {
    await calibrateQuorum();
  }

  // Step 9: Trajectory — universal rate-of-change tracking per domain
  // Every domain that has findings gets automatic velocity/acceleration computation.
  // New organs get jerk detection for free by depositing to circulation.
  const { updateTrajectory, getAcceleratingDomains } = require('./lib/circulation.ts');
  const trajectory = await updateTrajectory();
  const accelerating = getAcceleratingDomains();
  if (accelerating.length > 0) {
    for (const { domain, trajectory: t } of accelerating) {
      const msg = `TRAJECTORY: ${domain} accelerating — velocity ${t.velocity} findings/cycle, acceleration ${t.acceleration}/cycle² (${t.counts.slice(-3).join('→')} findings)`;
      log('WARN', msg);
      logToDaily(`TRAJECTORY: ${domain} accelerating — vel=${t.velocity}, accel=${t.acceleration}, counts=[${t.counts.slice(-4).join(',')}]`, 'Pump');
    }
  }

  // Step 10: Stats
  const s = await stats();
  const trajectoryCount = Object.keys(trajectory).length;

  const totalRouted = routed.build + routed.fix + routed.report + routed.escalate;
  const summary = `Pump: ${reinforced} reinforced, ${cascades} cascades, ${totalRouted} routed (build:${routed.build} fix:${routed.fix} escalate:${routed.escalate} report:${routed.report}), ${delegated} delegated, ${synthesized} synthesized, ${embedded} embedded, ${pruned} pruned, ${trajectoryCount} domains tracked, ${accelerating.length} accelerating. Active: ${s.pending}`;
  log('INFO', summary);
  if (reinforced > 0 || cascades > 0 || totalRouted > 0 || delegated > 0 || synthesized > 0 || embedded > 0 || pruned > 0 || accelerating.length > 0) {
    console.log(summary);
  }

  log('INFO', '=== Circulation Pump Complete ===');
}

if (require.main === module) {
  main().catch(err => {
    log('ERROR', `Pump fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  detectAndReinforce, detectCascades, routeActionable, pruneExpired,
  loadCascadeState, saveCascadeState, isCascadeCoolingDown,
  CASCADE_WINDOW_CYCLES, CASCADE_SOURCE_THRESHOLD, CASCADE_DOMAIN_THRESHOLD,
  CASCADE_DECAY_HOURS, CASCADE_COOLDOWN_MS, CASCADE_STATE_FILE,
};
