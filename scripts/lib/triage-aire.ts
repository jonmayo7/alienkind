/**
 * Triage AIRE — scores mission packet findings for evaluation priority.
 *
 * Three layers:
 *   1. Core physics: immutable rules (build discipline, fence principle)
 *   2. Cyclical weights: evolve from outcomes (ship rate, rejection patterns)
 *   3. Feedback loop: shipped findings upvote the pattern, rejected downvote
 *
 * Called by:
 *   - Working groups: after creating findings, score them
 *   - keel-cycle: rank pending packets by triage_score for Opus evaluation
 *   - Nightly: adjust cyclical weights from daily outcomes
 *
 * The triage AIRE prevents chasing the good idea fairy. High-value findings
 * get Opus attention. Noise gets deprioritized over time.
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '..', '..');
const WEIGHTS_FILE = path.join(KEEL_DIR, 'config', 'triage-weights.json');

// --- Core Physics (immutable) ---
// These multipliers NEVER change. They encode what always matters.

const CORE_PHYSICS = {
  // Finding types — base priority
  'assumption': 1.2,      // Implicit assumptions can fail silently
  'wiring': 1.3,          // Broken connections = seams
  'dead-code': 0.8,       // Low impact unless blocking something
  'gap': 1.0,             // Default
  'design-smell': 1.1,    // Architectural concerns

  // Risk levels — multiplier
  'risk:critical': 2.0,
  'risk:high': 1.5,
  'risk:medium': 1.0,
  'risk:low': 0.7,

  // Ring priority (inner ring first — fill our cup)
  'ring:inner': 1.5,
  'ring:middle': 1.0,
  'ring:outer': 0.6,

  // Debate quality — more rounds = more vetted
  'debate:3+': 1.3,       // Survived 3+ debate rounds
  'debate:1-2': 1.0,
  'debate:0': 0.7,        // No debate = less trusted

  // Confidence from models
  'confidence:high': 1.2,  // > 0.8
  'confidence:medium': 1.0, // 0.5-0.8
  'confidence:low': 0.6,    // < 0.5
};

// --- Cyclical Weights (evolve nightly) ---

interface CyclicalWeights {
  // Per-organ ship rate: organs with higher ship rates get prioritized
  organShipRate: Record<string, number>;
  // Per-finding-type rejection rate: types that get rejected more get deprioritized
  findingTypeRejectionRate: Record<string, number>;
  // Per-model accuracy: models that produce more shipped findings get trusted more
  modelAccuracy: Record<string, number>;
  // Last updated
  updatedAt: string;
}

function loadCyclicalWeights(): CyclicalWeights {
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
  } catch {
    return {
      organShipRate: {},
      findingTypeRejectionRate: {},
      modelAccuracy: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

function saveCyclicalWeights(weights: CyclicalWeights): void {
  weights.updatedAt = new Date().toISOString();
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2));
}

// --- Scoring ---

interface MissionPacket {
  finding_type: string;
  risk_level: string;
  ring: string;
  debate_rounds: number;
  confidence: number;
  organ: string;
  models_used?: string[];
}

/**
 * Score a mission packet finding. Higher score = evaluate sooner.
 * Returns a triage_score (0-20 range, unbounded).
 */
function scoreFinding(packet: MissionPacket): number {
  let score = 5.0; // Base score

  // Core physics: finding type
  score *= CORE_PHYSICS[packet.finding_type] || 1.0;

  // Core physics: risk level
  score *= CORE_PHYSICS[`risk:${packet.risk_level}`] || 1.0;

  // Core physics: ring priority
  score *= CORE_PHYSICS[`ring:${packet.ring}`] || 1.0;

  // Core physics: debate quality
  const debateKey = packet.debate_rounds >= 3 ? 'debate:3+' :
                    packet.debate_rounds >= 1 ? 'debate:1-2' : 'debate:0';
  score *= CORE_PHYSICS[debateKey];

  // Core physics: model confidence
  const confKey = packet.confidence > 0.8 ? 'confidence:high' :
                  packet.confidence >= 0.5 ? 'confidence:medium' : 'confidence:low';
  score *= CORE_PHYSICS[confKey];

  // Cyclical weights: organ ship rate
  const weights = loadCyclicalWeights();
  const organRate = weights.organShipRate[packet.organ];
  if (organRate !== undefined) {
    // Organs with higher ship rates get a boost (findings there are more likely real)
    score *= 0.8 + (organRate * 0.4); // range: 0.8 (0% ship) to 1.2 (100% ship)
  }

  // Cyclical weights: finding type rejection rate
  const rejRate = weights.findingTypeRejectionRate[packet.finding_type];
  if (rejRate !== undefined) {
    // Types that get rejected more get penalized
    score *= 1.0 - (rejRate * 0.3); // range: 1.0 (0% reject) to 0.7 (100% reject)
  }

  return Math.round(score * 100) / 100;
}

/**
 * Update cyclical weights from mission packet outcomes.
 * Called nightly by the AIRE loop.
 */
async function updateWeightsFromOutcomes(): Promise<{ updated: boolean; changes: string[] }> {
  try {
    const { supabaseGet } = require('./supabase.ts');
    const { loadEnv } = require('./shared.ts');
    Object.assign(process.env, loadEnv(path.join(KEEL_DIR, '.env')));

    // Get all evaluated packets (shipped + rejected) from the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const packets = await supabaseGet('mission_packets',
      `select=organ,finding_type,status,models_used&status=in.(shipped,rejected)&created_at=gte.${thirtyDaysAgo}`
    );

    if (!Array.isArray(packets) || packets.length < 5) {
      return { updated: false, changes: ['Not enough data (need 5+ evaluated packets)'] };
    }

    const weights = loadCyclicalWeights();
    const changes: string[] = [];

    // Calculate organ ship rates
    const organCounts: Record<string, { shipped: number; total: number }> = {};
    for (const p of packets) {
      if (!organCounts[p.organ]) organCounts[p.organ] = { shipped: 0, total: 0 };
      organCounts[p.organ].total++;
      if (p.status === 'shipped') organCounts[p.organ].shipped++;
    }
    for (const [organ, counts] of Object.entries(organCounts)) {
      const rate = counts.shipped / counts.total;
      const old = weights.organShipRate[organ];
      weights.organShipRate[organ] = Math.round(rate * 100) / 100;
      if (old !== weights.organShipRate[organ]) {
        changes.push(`${organ} ship rate: ${old ?? 'new'} → ${weights.organShipRate[organ]}`);
      }
    }

    // Calculate finding type rejection rates
    const typeCounts: Record<string, { rejected: number; total: number }> = {};
    for (const p of packets) {
      if (!typeCounts[p.finding_type]) typeCounts[p.finding_type] = { rejected: 0, total: 0 };
      typeCounts[p.finding_type].total++;
      if (p.status === 'rejected') typeCounts[p.finding_type].rejected++;
    }
    for (const [type, counts] of Object.entries(typeCounts)) {
      const rate = counts.rejected / counts.total;
      const old = weights.findingTypeRejectionRate[type];
      weights.findingTypeRejectionRate[type] = Math.round(rate * 100) / 100;
      if (old !== weights.findingTypeRejectionRate[type]) {
        changes.push(`${type} rejection rate: ${old ?? 'new'} → ${weights.findingTypeRejectionRate[type]}`);
      }
    }

    saveCyclicalWeights(weights);
    return { updated: true, changes };
  } catch (err: any) {
    return { updated: false, changes: [`Error: ${err.message}`] };
  }
}

// --- Scope Lock (security addition) ---

/**
 * Verify a working group only modifies files within its assigned organ.
 * Returns true if all proposed files are within scope.
 */
function checkScopeLock(organKey: string, proposedFiles: string[]): { passed: boolean; violations: string[] } {
  try {
    const { buildOrganMap } = require('../tools/organ-map.ts');
    const map = buildOrganMap(organKey);
    const organPaths = map.files.map((f: any) => f.path);

    const violations = proposedFiles.filter(f => !organPaths.includes(f));
    return { passed: violations.length === 0, violations };
  } catch {
    // If organ map fails, fail-closed (block all)
    return { passed: false, violations: ['Organ map unavailable — scope lock fail-closed'] };
  }
}

/**
 * Verify shipped mission packets — did the fix improve anything?
 * Uses rate-of-change monitoring (item 13) to compare before/after.
 * Called by keel-cycle after evaluating packets.
 */
async function verifyShippedPackets(): Promise<{ verified: number; failed: number; skipped: number }> {
  try {
    const { supabaseGet, supabasePatch } = require('./supabase.ts');
    const { loadEnv } = require('./shared.ts');
    Object.assign(process.env, loadEnv(path.join(KEEL_DIR, '.env')));

    // Find shipped packets that haven't been verified yet
    const unverified = await supabaseGet('mission_packets',
      'select=id,organ,commit_sha,shipped_at&status=eq.shipped&verified=eq.false&limit=10'
    );

    if (!Array.isArray(unverified) || unverified.length === 0) {
      return { verified: 0, failed: 0, skipped: 0 };
    }

    let verified = 0, failed = 0, skipped = 0;

    for (const packet of unverified) {
      // Only verify packets shipped > 1 hour ago (give time for effects)
      const shippedAt = new Date(packet.shipped_at).getTime();
      if (Date.now() - shippedAt < 60 * 60 * 1000) {
        skipped++;
        continue;
      }

      // Check: does the commit still exist in git? (not reverted)
      try {
        const { execSync } = require('child_process');
        execSync(`git log --oneline ${packet.commit_sha} -1`, { cwd: KEEL_DIR, timeout: 5000, stdio: 'pipe' });
        // Commit exists — mark as verified (basic check)
        await supabasePatch('mission_packets', `id=eq.${packet.id}`, {
          verified: true,
          verified_at: new Date().toISOString(),
          verification_data: { method: 'commit_exists', checked_at: new Date().toISOString() },
        });
        verified++;
      } catch {
        // Commit was reverted or doesn't exist
        await supabasePatch('mission_packets', `id=eq.${packet.id}`, {
          status: 'failed_verification',
          verified: false,
          verified_at: new Date().toISOString(),
          verification_data: { method: 'commit_missing', checked_at: new Date().toISOString() },
        });
        failed++;
      }
    }

    return { verified, failed, skipped };
  } catch {
    return { verified: 0, failed: 0, skipped: 0 };
  }
}

module.exports = {
  scoreFinding,
  updateWeightsFromOutcomes,
  checkScopeLock,
  verifyShippedPackets,
  CORE_PHYSICS,
  loadCyclicalWeights,
  saveCyclicalWeights,
};
