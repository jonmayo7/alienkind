#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Steward Improvement Working Group — autonomous gap analysis pipeline
 *
 * Architecture (two-phase separation):
 *   Phase 1 (this script — local substrates, zero primary-model cost):
 *     scan capability_requests → identify organ → buildOrganMap +
 *     surveyOrgan → load 4 role prompts → consult() debate on local
 *     substrates → scoreFinding → deposit mission_packet.
 *
 *   Phase 2 (operator cycle, separate script):
 *     Pick up mission_packet → primary model evaluates with full context
 *     → ship via build discipline or reject with reason.
 *
 * The separation matters: Phase 1 does discovery + debate on local models
 * (zero primary-model cost). Phase 2 hands the primary model a
 * fully-contextualized packet for the ship/reject decision.
 *
 * Signal source: capability_requests.status='detected' (gaps surfaced
 * by steward pipelines — your deployed stewards feed this table).
 *
 * Runs via daemon-jobs.ts. Cadence ladder (configure per your needs):
 *   - Days 1-3: nightly only
 *   - Days 4+: every 6h (after 3 clean days)
 *   - Later: evaluate further increase
 * Cadence changes are separate commits, each requiring human decision.
 */

import * as fs from 'fs';
import * as path from 'path';

const ALIENKIND_DIR = path.resolve(__dirname, '..');

const { loadEnv, createLogger, checkAuth } = require('./lib/shared.ts');
const { logToDaily, getNowCT } = require('./lib/keel-env.ts');
const { supabaseGet, supabasePost, supabasePatch } = require('./lib/supabase.ts');
const { getBudget, isOverBudget } = require('./lib/resource-budgets.ts');
const { buildOrganMap, surveyOrgan, ORGANS } = require('./tools/organ-map.ts');
const { consult } = require('./lib/consult.ts');
const { processMessage } = require('./lib/consciousness-engine.ts');
const { scoreFinding, checkScopeLock } = require('./lib/triage-aire.ts');
const { verify: crossVerify } = require('./lib/cross-verify.ts');
const { CHANNELS } = require('./lib/consciousness-engine.ts');

Object.assign(process.env, loadEnv(path.join(ALIENKIND_DIR, '.env')));

const LOG_DIR = path.join(ALIENKIND_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const DATE = new Date().toISOString().split('T')[0];
const { log } = createLogger(path.join(LOG_DIR, `working-group-steward-${DATE}.log`));

const BUDGET = getBudget('steward-improvement');
const START_TIME = Date.now();

// How many top gaps to analyze per run. Start conservative — 1 gap per run
// = 1 mission packet per cycle. Bump when cadence increases and you want
// higher throughput.
const MAX_GAPS_PER_RUN = 1;

// ─── Steward Registry ───────────────────────────────────────────────────────
// Configure your deployed stewards in the STEWARD_REGISTRY.
// Each entry maps a steward's source_prefix (used in capability_requests)
// to the organ it belongs to. Organ keys must match the ORGANS map in
// scripts/tools/organ-map.ts.
//
// Example stewards:
//   'example-steward-alpha': 'consciousness-engine',  // core subsystem steward
//   'example-steward-beta': 'communication-layer',    // communication steward
//
// Load from config file if it exists, otherwise use empty defaults.
function loadStewardRegistry(): Record<string, string> {
  // Try loading from config/steward-registry.json
  try {
    const configPath = path.join(ALIENKIND_DIR, 'config', 'steward-registry.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config && typeof config === 'object') {
        log('INFO', `Loaded steward registry from config: ${Object.keys(config).length} steward(s)`);
        return config;
      }
    }
  } catch (e: any) {
    log('WARN', `Failed to load steward-registry.json: ${e.message}`);
  }

  // Default: empty registry. Add your steward-to-organ mappings here
  // or create config/steward-registry.json.
  return {};
}

const STEWARD_TO_ORGAN: Record<string, string> = loadStewardRegistry();

// Default organ when a steward's source_prefix isn't in the registry.
// Set this to whichever organ is the most common target for gaps.
const DEFAULT_ORGAN = 'consciousness-engine';

// The four role prompts (loaded once per run from config/roles/).
// Roles: foreman (build discipline), devils-advocate (red team),
// historian (fence principle), visionary (3-move rule).
function loadRolePrompts(): Record<string, string> {
  const roleDir = path.join(ALIENKIND_DIR, 'config', 'roles');
  const roles: Record<string, string> = {};
  for (const file of ['foreman.md', 'devils-advocate.md', 'historian.md', 'visionary.md']) {
    try {
      roles[file.replace('.md', '')] = fs.readFileSync(path.join(roleDir, file), 'utf8');
    } catch (e: any) {
      log('WARN', `Failed to load ${file}: ${e.message}`);
    }
  }
  return roles;
}

async function findTopGaps(limit: number): Promise<any[]> {
  log('INFO', `Scanning capability_requests for top ${limit} detected gap(s)...`);
  try {
    const rows = await supabaseGet('capability_requests', {
      select: 'id,source_prefix,user_message,gap_type,classification,frequency,status',
      status: 'eq.detected',
      order: 'frequency.desc,created_at.desc',
      limit: String(limit * 4), // overfetch so we can filter
    });

    // Deduplicate near-identical gaps by classification + first 50 chars.
    // If you have stewards you want prioritized, add them to PRIORITY_STEWARDS.
    const PRIORITY_STEWARDS = Object.keys(STEWARD_TO_ORGAN);
    const seen = new Set<string>();
    const filtered: any[] = [];
    const prioritized = rows.sort((a: any, b: any) => {
      const aPriority = PRIORITY_STEWARDS.includes(a.source_prefix) ? 1 : 0;
      const bPriority = PRIORITY_STEWARDS.includes(b.source_prefix) ? 1 : 0;
      return bPriority - aPriority;
    });
    for (const r of prioritized) {
      const dedupKey = `${r.source_prefix}:${r.gap_type}:${(r.user_message || '').slice(0, 50)}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      filtered.push(r);
      if (filtered.length >= limit) break;
    }
    log('INFO', `Found ${filtered.length} unique actionable gap(s)`);
    return filtered;
  } catch (e: any) {
    log('ERROR', `capability_requests query failed: ${e.message}`);
    return [];
  }
}

/**
 * Debate a gap across the 4 roles using local substrates.
 * Returns the synthesized finding + debate metadata.
 */
async function debateGap(
  gap: any,
  organ: string,
  organMap: any,
  survey: any,
  roles: Record<string, string>,
): Promise<{
  synthesis: string;
  debateRounds: number;
  substrates: string[];
  confidence: number;
} | null> {
  const organSummary = `
ORGAN: ${organMap.name}
FILES (${organMap.files.length}): ${organMap.files.slice(0, 8).map((f: any) => f.path).join(', ')}${organMap.files.length > 8 ? '...' : ''}
EXPORTS: ${(organMap.exports || []).slice(0, 10).join(', ')}
EXTERNAL CONSUMERS: ${(organMap.externalConsumers || []).slice(0, 5).join(', ')}
SUPABASE TABLES: ${(organMap.supabaseTables || []).join(', ') || 'none'}
SURVEY: ${survey.passed ? 'PASSED' : `FAILED — ${(survey.issues || []).join('; ')}`}
`.trim();

  const taskPrompt = `You are a hit team of 4 roles analyzing a gap in the ${gap.source_prefix} steward.

## The Gap
Type: ${gap.gap_type}
Classification: ${gap.classification || 'unclassified'}
Frequency: ${gap.frequency || 1}
What the user said: "${(gap.user_message || '').slice(0, 500)}"

## The Organ Map (ground truth from organ-map + surveyor)
${organSummary}

## Your Role
You will play ALL FOUR roles in sequence. For each role, answer in 2-3 sentences.

### ROLE 1 — FOREMAN (build discipline)
${roles.foreman || ''}
Question: What is the concrete, minimal code change needed to close this gap? Name specific files from the organ map above.

### ROLE 2 — DEVIL'S ADVOCATE (red team)
${roles['devils-advocate'] || ''}
Question: What is the strongest argument against the Foreman's proposed fix? What could break? What edge cases are ignored?

### ROLE 3 — HISTORIAN (fence principle)
${roles.historian || ''}
Question: Why does the current code exist as-is? What winter haven't we seen? Is there a reason this gap exists that we might be missing?

### ROLE 4 — VISIONARY (3-move rule)
${roles.visionary || ''}
Question: If we ship this fix, what does move 2 look like? Move 3? Does this create new seams or close existing ones?

## Synthesis (required)
After the 4 role responses, produce a final synthesis in this EXACT format:

FINDING_TYPE: one of [gap, dead-code, wiring, assumption, design-smell]
RISK_LEVEL: one of [critical, high, medium, low]
RING: one of [inner, middle, outer]
CONFIDENCE: 0.0 to 1.0
PROPOSED_FIX: 1-3 sentences describing the minimal change
FIX_FILES: comma-separated list of files that would be modified
FIX_REASONING: 2-3 sentences on why this fix vs alternatives
SHIP_OR_DEFER: one of [auto-ship, primary-review, human-required]
  - auto-ship: small, reversible, no identity/client/money concerns
  - primary-review: touches exports, configs, or cross-organ connections
  - human-required: touches identity, clients, money, or cross-organ architecture

Be concise. Your output goes directly into a mission packet for primary model evaluation.`;

  try {
    // Single-substrate mode: one local model carries all 4 roles in one
    // pass. The consult() multi-substrate debate pattern is the target
    // architecture — switch to it when compute budget allows.
    // The prompt structure already plays all 4 roles in one pass, so output
    // quality is preserved — you just lose cross-substrate diversity until
    // compute budget allows multi-model debate.
    const substrate = 'studio2-daily';
    const start = Date.now();
    const daemonSessionId = process.env.ALIENKIND_DAEMON_SESSION_ID;
    const daemonSessionResume = process.env.ALIENKIND_DAEMON_SESSION_RESUME === 'true';
    const result = await processMessage(taskPrompt, {
      channelConfig: CHANNELS.research,
      log: (level: string, msg: string) => log(level, `[single] ${msg}`),
      sender: 'working-group-steward',
      senderDisplayName: 'Steward Working Group',
      substrate: substrate as any,
      skipLogging: true,
      skipDiscernment: true,
      recentMessageCount: 3,
      maxTokens: 1500,
      ...(daemonSessionId && daemonSessionResume ? { resumeSessionId: daemonSessionId } : {}),
      ...(daemonSessionId && !daemonSessionResume ? { sessionId: daemonSessionId } : {}),
    });
    const elapsed = Date.now() - start;
    log('INFO', `Single-substrate debate complete: ${substrate}, ${elapsed}ms, ${(result.text || '').length} chars`);

    const synthesis = result.text || '';
    const confMatch = synthesis.match(/CONFIDENCE:\s*([\d.]+)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

    return {
      synthesis,
      debateRounds: 1,
      substrates: [substrate],
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  } catch (e: any) {
    log('ERROR', `Debate failed: ${e.message}`);
    return null;
  }
}

/**
 * Generate an AI-voice recommendation for the packet.
 *
 * After the 4-role debate has produced the finding + fix + ramifications,
 * make ONE additional short substrate call to produce a recommendation
 * (approve / deny / defer) plus 2-4 sentences of reasoning.
 *
 * Why here instead of at dashboard render time: the working group just
 * finished a full debate and has all the context in-session. One more
 * short call (~15-30s) while the context is hot is cheaper than a
 * dashboard-time LLM call on every page load, and the recommendation
 * reasoning is grounded in the same debate that produced the finding.
 *
 * Returns { recommendation, reasoning } or null on failure. Failure is
 * non-blocking — the packet still ships without a recommendation.
 */
async function generateRecommendation(
  gap: any,
  organ: string,
  parsed: ReturnType<typeof parseDebateSynthesis>,
  confidence: number,
  triageScore: number,
  scopeViolations: string[],
): Promise<{ recommendation: string; reasoning: string } | null> {
  const scopeNote =
    scopeViolations.length > 0
      ? `\nSCOPE LOCK: fix proposes files OUTSIDE the ${organ} organ: ${scopeViolations.join(", ")}. This is why the packet was auto-escalated to human-required.`
      : "";

  const prompt = `Output ONLY the two lines below. NO thinking process. NO analysis preamble. NO explanation before or after. Start your response with the literal text "RECOMMENDATION:" and nothing else.

RECOMMENDATION: [approve | deny | defer]
REASONING: [2-4 sentences — direct voice, no hedging, reference the finding and fix, call out scope-lock if it fired, honest about low confidence]

## Context to reason over

Gap: ${(gap.user_message || "").slice(0, 300)}
Organ: ${organ}
Finding type: ${parsed.finding_type}  |  Risk: ${parsed.risk_level}  |  Ring: ${parsed.ring}
Triage score: ${triageScore}  |  Confidence: ${confidence}

Proposed fix: ${parsed.proposed_fix.slice(0, 500)}
Files: ${parsed.fix_files.join(", ") || "(none)"}
Reasoning: ${parsed.fix_reasoning.slice(0, 400)}${scopeNote}

## Critical

Your output goes directly to the human partner's review queue as a recommendation panel. It must start with "RECOMMENDATION:" on the first line. Do not write anything before it.`;

  try {
    const substrate = "studio2-daily";
    const start = Date.now();
    const result = await processMessage(prompt, {
      channelConfig: CHANNELS.research,
      log: (level: string, msg: string) => log(level, `[recommend] ${msg}`),
      sender: "working-group-steward",
      senderDisplayName: "Steward Working Group",
      substrate: substrate as any,
      skipLogging: true,
      skipDiscernment: true,
      recentMessageCount: 3,
      maxTokens: 800,
    });
    const elapsed = Date.now() - start;
    log("INFO", `Recommendation complete: ${substrate}, ${elapsed}ms, ${(result.text || "").length} chars`);

    const text = result.text || "";

    // Permissive parsing — accept multiple format variants since local
    // models sometimes emit markdown, prose, or different capitalization.
    let recommendation: string | null = null;
    let reasoning = "";

    // Strict format: "RECOMMENDATION: approve"
    const strictMatch = text.match(/RECOMMENDATION:\s*\*?\*?(approve|deny|defer)\*?\*?/i);
    if (strictMatch) {
      recommendation = strictMatch[1].toLowerCase();
    }

    // Markdown bold: "**Recommendation:** approve"
    if (!recommendation) {
      const boldMatch = text.match(/\*\*\s*recommendation\s*\*\*:?\s*\*?\*?(approve|deny|defer)/i);
      if (boldMatch) recommendation = boldMatch[1].toLowerCase();
    }

    // Loose: "I recommend approve" or "My recommendation is deny"
    if (!recommendation) {
      const looseMatch = text.match(/(?:i recommend|my recommendation(?: is)?|verdict is)\s*:?\s*\*?\*?(approve|deny|defer)/i);
      if (looseMatch) recommendation = looseMatch[1].toLowerCase();
    }

    // Last resort: verdict word as a standalone line
    if (!recommendation) {
      const fallbackMatch = text.match(/(?:^|\n)\s*\*?\*?(approve|deny|defer)\*?\*?\s*(?:\n|$|[:,.])/i);
      if (fallbackMatch) recommendation = fallbackMatch[1].toLowerCase();
    }

    // Reasoning extraction — similarly permissive
    const reasonStrict = text.match(/REASONING:\s*([\s\S]+?)(?:\n\n|$)/i);
    if (reasonStrict) {
      reasoning = reasonStrict[1].trim();
    } else {
      const reasonBold = text.match(/\*\*\s*reasoning\s*\*\*:?\s*([\s\S]+?)(?:\n\n|$)/i);
      if (reasonBold) {
        reasoning = reasonBold[1].trim();
      } else if (recommendation) {
        const afterVerdict = text
          .split(new RegExp(`\\b${recommendation}\\b`, "i"))
          .slice(1)
          .join(recommendation);
        if (afterVerdict) {
          reasoning = afterVerdict.trim().slice(0, 1500);
        }
      }
    }
    reasoning = reasoning.replace(/^[:.,\s]+/, "").trim().slice(0, 1500);

    if (!recommendation) {
      log("WARN", `Recommendation parse failed. Falling back to rules-based. Raw first 300: ${text.slice(0, 300).replace(/\n/g, " ")}`);
    } else {
      return { recommendation, reasoning };
    }
  } catch (e: any) {
    log("WARN", `Recommendation LLM call failed: ${e.message}. Using rules-based fallback.`);
  }

  // --- Rules-based fallback ---
  // When the LLM either fails or emits an unparseable format, produce a
  // deterministic recommendation based on the packet's structured fields.
  return buildRulesBasedRecommendation(parsed, triageScore, confidence, scopeViolations);
}

/**
 * Deterministic recommendation based on packet fields. Always returns
 * a valid recommendation. Used as fallback when the LLM can't be parsed,
 * and as the baseline that the LLM path overrides.
 */
function buildRulesBasedRecommendation(
  parsed: ReturnType<typeof parseDebateSynthesis>,
  triageScore: number,
  confidence: number,
  scopeViolations: string[],
): { recommendation: string; reasoning: string } {
  // Doc-file scope violations are safe to approve — README.md, *.md,
  // docs/, CHANGELOG are cross-organ by nature.
  const isDocOnlyViolation =
    scopeViolations.length > 0 &&
    scopeViolations.every((f) =>
      /\.md$|^docs?\//i.test(f) || /README|CHANGELOG/i.test(f)
    );

  // Critical risk always defers — wants more eyes on it
  if (parsed.risk_level === "critical") {
    return {
      recommendation: "defer",
      reasoning: `Risk level is critical. Rules-based recommendation defers by default for critical-risk packets so the decision gets more careful thought. Re-evaluate after reading the full fix reasoning.`,
    };
  }

  // Doc-only scope violations: approve
  if (isDocOnlyViolation) {
    return {
      recommendation: "approve",
      reasoning: `Scope-lock flagged ${scopeViolations.join(", ")} as outside the ${parsed.finding_type} organ, but these are documentation files — safe to edit without cross-organ risk. The proposed fix is a doc update, which is reversible and low-stakes.`,
    };
  }

  // High triage + high confidence: approve
  if (triageScore >= 7 && confidence >= 0.7) {
    return {
      recommendation: "approve",
      reasoning: `Triage score ${triageScore.toFixed(1)} and confidence ${confidence.toFixed(2)} are both high. The working group's debate produced a well-reasoned fix with strong agreement. Approving lets the operator build via full build discipline on the next cycle.`,
    };
  }

  // Code file scope violations with medium or higher risk: defer
  if (scopeViolations.length > 0 && parsed.risk_level !== "low") {
    return {
      recommendation: "defer",
      reasoning: `Scope-lock fired on code files outside the target organ: ${scopeViolations.join(", ")}. With risk level ${parsed.risk_level}, this crosses organ boundaries in a way that deserves more thought. Defer and re-evaluate after reviewing the proposed fix files directly.`,
    };
  }

  // Low confidence: defer
  if (confidence < 0.4) {
    return {
      recommendation: "defer",
      reasoning: `Confidence ${confidence.toFixed(2)} is low. The working group isn't sure about this finding. Defer to give the trajectory more data — if the pattern reappears with higher confidence, re-evaluate.`,
    };
  }

  // Low triage: defer (noise, not priority)
  if (triageScore < 4) {
    return {
      recommendation: "defer",
      reasoning: `Triage score ${triageScore.toFixed(1)} is below the priority threshold. This might be a real finding but it's not worth attention right now. Defer so the queue stays focused on higher-value work.`,
    };
  }

  // Default: medium triage, medium confidence, no scope issues → approve
  return {
    recommendation: "approve",
    reasoning: `Triage ${triageScore.toFixed(1)}, confidence ${confidence.toFixed(2)}, risk ${parsed.risk_level}. The working group's debate produced a reasonable fix and scope-lock did not fire. Approve to ship via the operator on the next cycle.`,
  };
}

/**
 * Parse the debate synthesis into structured mission_packet fields.
 */
function parseDebateSynthesis(synthesis: string): {
  finding_type: string;
  risk_level: string;
  ring: string;
  proposed_fix: string;
  fix_files: string[];
  fix_reasoning: string;
  ship_or_defer: string;
} {
  const field = (name: string, fallback: string): string => {
    const m = synthesis.match(new RegExp(`${name}:\\s*(.+?)(?:\\n|$)`, 'i'));
    return m ? m[1].trim() : fallback;
  };

  const raw_files = field('FIX_FILES', '');
  const fix_files = raw_files
    ? raw_files.split(',').map((f: string) => f.trim()).filter((f: string) => f.length > 0)
    : [];

  // Pull a longer PROPOSED_FIX / FIX_REASONING — they can span lines
  const longField = (name: string, fallback: string): string => {
    const m = synthesis.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?:\\n[A-Z_]+:|$)`, 'i'));
    return m ? m[1].trim() : fallback;
  };

  return {
    finding_type: field('FINDING_TYPE', 'gap').toLowerCase(),
    risk_level: field('RISK_LEVEL', 'medium').toLowerCase(),
    ring: field('RING', 'middle').toLowerCase(),
    proposed_fix: longField('PROPOSED_FIX', ''),
    fix_files,
    fix_reasoning: longField('FIX_REASONING', ''),
    ship_or_defer: field('SHIP_OR_DEFER', 'primary-review').toLowerCase(),
  };
}

/**
 * Deposit a mission packet to Supabase. Returns the packet id or null.
 */
async function depositMissionPacket(packet: any): Promise<string | null> {
  try {
    const result = await supabasePost('mission_packets', packet, { prefer: 'return=representation' });
    if (Array.isArray(result) && result.length > 0) {
      return result[0].id;
    }
    if (result && result.id) return result.id;
    log('WARN', `mission_packet deposit returned unexpected shape: ${JSON.stringify(result).slice(0, 200)}`);
    return null;
  } catch (e: any) {
    log('ERROR', `mission_packet deposit failed: ${e.message}`);
    return null;
  }
}

async function run() {
  log('INFO', '=== Steward Improvement Working Group — starting ===');
  log('INFO', `Budget: ${BUDGET?.maxRuntimeMinutes || 'unlimited'} min`);

  const authResult = checkAuth(log);
  if (!authResult.ok) {
    log('ERROR', `Auth failed: ${authResult.reason}`);
    process.exit(1);
  }

  const roles = loadRolePrompts();
  if (Object.keys(roles).length < 4) {
    log('WARN', `Only ${Object.keys(roles).length}/4 roles loaded — continuing with partial role set`);
  }

  const gaps = await findTopGaps(MAX_GAPS_PER_RUN);
  if (gaps.length === 0) {
    log('INFO', 'No actionable gaps found. Exiting clean.');
    return;
  }

  let depositedCount = 0;
  let rejectedCount = 0;

  for (const gap of gaps) {
    if (isOverBudget('steward-improvement', Date.now() - START_TIME)) {
      log('WARN', `Over budget (${BUDGET?.maxRuntimeMinutes}min). Stopping.`);
      break;
    }

    log('INFO', `Processing gap: [${gap.source_prefix}] ${gap.gap_type} (freq ${gap.frequency})`);

    const organ = STEWARD_TO_ORGAN[gap.source_prefix] || DEFAULT_ORGAN;
    log('INFO', `Organ: ${organ}`);

    // Build the organ map + survey
    let organMap: any;
    let survey: any;
    try {
      organMap = buildOrganMap(organ);
      survey = surveyOrgan(organMap);
      log('INFO', `Organ map: ${organMap.files.length} files, survey ${survey.passed ? 'PASSED' : 'FAILED'}`);
      if (!survey.passed) {
        log('WARN', `Survey issues: ${(survey.issues || []).join('; ')}`);
        // Fail-closed: if the map is stale, don't build packets on bad data
        log('WARN', 'Skipping this gap — organ map survey failed');
        rejectedCount++;
        continue;
      }
    } catch (e: any) {
      log('ERROR', `Organ map failed for ${organ}: ${e.message}`);
      rejectedCount++;
      continue;
    }

    // Debate the gap across 4 roles
    const debate = await debateGap(gap, organ, organMap, survey, roles);
    if (!debate) {
      log('WARN', 'Debate returned null — skipping this gap');
      rejectedCount++;
      continue;
    }

    // Parse the synthesis into mission packet fields
    const parsed = parseDebateSynthesis(debate.synthesis);

    // Scope lock: verify proposed files are within the organ
    const scopeCheck = checkScopeLock(organ, parsed.fix_files);
    if (!scopeCheck.passed) {
      log('WARN', `Scope lock violation: ${scopeCheck.violations.join(', ')}`);
      // Still deposit the packet but mark it for human review — the
      // proposed fix crossed organ boundaries, which needs human judgment.
      parsed.ship_or_defer = 'human-required';
    }

    // Build the mission packet
    const packet: any = {
      organ,
      finding: `[${gap.source_prefix} steward] ${gap.gap_type}: ${(gap.user_message || '').slice(0, 300)}`,
      evidence: `capability_requests id=${gap.id}, frequency=${gap.frequency}, classification=${gap.classification || 'unclassified'}. Organ map: ${organMap.files.length} files, survey ${survey.passed ? 'passed' : 'failed'}.`,
      finding_type: parsed.finding_type,
      created_by: 'working-group-steward',
      models_used: debate.substrates,
      debate_rounds: debate.debateRounds,
      proposed_fix: parsed.proposed_fix.slice(0, 4000),
      fix_reasoning: parsed.fix_reasoning.slice(0, 2000),
      fix_files: parsed.fix_files,
      confidence: debate.confidence,
      status: parsed.ship_or_defer === 'auto-ship' ? 'pending' : parsed.ship_or_defer === 'human-required' ? 'escalated' : 'pending',
      risk_level: parsed.risk_level,
      ring: parsed.ring,
    };

    // Score it
    const triageScore = scoreFinding(packet as any);
    packet.triage_score = triageScore;

    log('INFO', `Triage score: ${triageScore} (finding=${parsed.finding_type}, risk=${parsed.risk_level}, ring=${parsed.ring})`);

    // Generate AI-voice recommendation for the human's review queue
    const recommendation = await generateRecommendation(
      gap,
      organ,
      parsed,
      debate.confidence,
      triageScore,
      scopeCheck.violations,
    );
    if (recommendation) {
      packet.keel_recommendation = recommendation.recommendation;
      packet.keel_reasoning = recommendation.reasoning;
      log('INFO', `Recommends: ${recommendation.recommendation}`);
    } else {
      log('WARN', 'No recommendation generated (non-blocking)');
    }

    // Deposit
    const packetId = await depositMissionPacket(packet);
    if (packetId) {
      log('INFO', `Mission packet deposited: ${packetId}`);
      depositedCount++;

      // Mark the capability_request as acknowledged (processed into a
      // mission packet — primary model evaluates next cycle).
      await supabasePatch('capability_requests', `id=eq.${gap.id}`, {
        status: 'acknowledged',
        notes: `working-group-steward deposited mission packet ${packetId} (triage_score=${triageScore})`,
      }).catch((e: any) => log('WARN', `capability_requests patch failed: ${e.message}`));
    } else {
      log('ERROR', 'Mission packet deposit returned no id — not counted as deposited');
      rejectedCount++;
    }
  }

  // Log summary to daily file
  const time = getNowCT();
  const summary = `### Steward Improvement Working Group (${time} CDT)\n` +
    `Gaps scanned: ${gaps.length}\n` +
    `Mission packets deposited: ${depositedCount}\n` +
    `Rejected/skipped: ${rejectedCount}\n` +
    `Runtime: ${Math.round((Date.now() - START_TIME) / 1000)}s`;
  logToDaily(summary, undefined, false);

  log('INFO', `=== Complete: ${depositedCount} deposited, ${rejectedCount} rejected, ${Math.round((Date.now() - START_TIME) / 1000)}s ===`);
}

run().catch(err => {
  log('ERROR', `Fatal: ${err.message}`);
  process.exit(1);
});
