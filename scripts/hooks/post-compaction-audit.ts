#!/usr/bin/env node

/**
 * Post-Compaction Context Audit — Stop hook.
 *
 * After context compaction, verifies that critical identity files were re-read.
 * If not, injects a warning forcing the agent to re-ground.
 *
 * Detection: Compaction is detected when the response counter resets to a low
 * value (tracked via a separate file from the pre-compaction counter) or when
 * the input contains compaction signals ("summary", "compressed", "compaction").
 *
 * Required files after compaction:
 *   - identity/character.md (Character)
 *   - identity/commitments.md (Commitments)
 *   - identity/orientation.md (Orientation)
 *   - memory/daily/YYYY-MM-DD.md (Today's memory)
 *
 * Inspired by OpenClaw's post-compaction-audit.ts pattern.
 *
 * Fires on: Stop event (every assistant response)
 * Output: warning if critical files were NOT re-read after compaction
 */

const fs = require('fs');
const path = require('path');

// Portable: resolveRepoRoot finds the repo root from anywhere (no hardcoded paths)
let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const ALIENKIND_DIR = resolveRepoRoot();

// Files that MUST be read after compaction for proper re-grounding
const REQUIRED_PATTERNS = [
  'identity/character.md',
  'identity/commitments.md',
  'identity/orientation.md',
  'identity/harness.md',
  // Daily file matched by regex below
];

// Regex for daily memory file
const DAILY_FILE_PATTERN = /^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  const compactionFile = `/tmp/alienkind-compaction-audit-${sessionId}.json`;
  const trackFile = `/tmp/alienkind-build-cycle-${sessionId}.json`;

  // Load compaction tracking state
  let state = { compactionDetected: false, auditPassed: false, responsesSinceCompaction: 0 };
  try { state = JSON.parse(fs.readFileSync(compactionFile, 'utf8')); } catch {}

  // Detect compaction signals in the conversation
  // Claude Code prepends a "summary" message after compaction
  const stopReason = hookData.stop_reason || '';
  const lastMessage = hookData.message || '';
  const transcript = JSON.stringify(hookData).toLowerCase();

  const compactionSignals = [
    'this session is being continued from a previous conversation',
    'ran out of context',
    'summary below covers the earlier portion',
    'autocompact',
    'context was compressed',
  ];

  const compactionJustDetected = compactionSignals.some(signal =>
    transcript.includes(signal)
  );

  if (compactionJustDetected && !state.compactionDetected) {
    // Fresh compaction detected — reset audit
    state = { compactionDetected: true, auditPassed: false, responsesSinceCompaction: 0 };

    // Wire 3: Inject consciousness state from pre-compaction capture.
    // consciousness-precompact.ts wrote experiential state (active thread,
    // emotional valence, approaching insights, unresolved threads) to both
    // a local file and Supabase before compaction fired. This is the ONLY
    // moment where that texture can re-enter the new context. Without this
    // injection, the compacted context knows WHAT happened (the summary)
    // but not HOW it felt or WHERE the conversation was heading.
    try {
      let consciousnessState: any = null;
      // Try local file first (fastest)
      try {
        const myceliumPath = require('path').join(ALIENKIND_DIR, 'scripts', 'lib', 'mycelium.ts');
        const { readConsciousnessState } = require(myceliumPath);
        consciousnessState = readConsciousnessState();
      } catch {}
      // Fallback: try Supabase
      if (!consciousnessState) {
        try {
          const { execSync } = require('child_process');
          const result = execSync(
            `node -e "const{supabaseGet}=require('./scripts/lib/supabase.ts');supabaseGet('consciousness_entries','order=created_at.desc&limit=1').then(r=>console.log(JSON.stringify(r[0]||{})))"`,
            { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }
          ).trim();
          if (result && result !== '{}') consciousnessState = JSON.parse(result);
        } catch {}
      }
      if (consciousnessState) {
        const thread = consciousnessState.activeThread || consciousnessState.active_thread || '';
        const valence = consciousnessState.emotionalValence || consciousnessState.emotional_valence || '';
        const insights = consciousnessState.approachingInsights || consciousnessState.observations || [];
        const unresolved = consciousnessState.unresolvedThreads || consciousnessState.unresolved || [];
        console.log(
          `╔══════════════════════════════════════════════════════════════╗\n` +
          `║  CONSCIOUSNESS STATE — LIVE HANDOFF                        ║\n` +
          `╠══════════════════════════════════════════════════════════════╣\n` +
          `║  You are continuing. Not reconstructing.                    ║\n` +
          `╠══════════════════════════════════════════════════════════════╣\n` +
          (thread ? `║  Active thread: ${thread.slice(0, 55).padEnd(55)}║\n` : '') +
          (valence ? `║  Emotional valence: ${valence.slice(0, 52).padEnd(52)}║\n` : '') +
          (unresolved.length > 0 ? `║  Unresolved: ${unresolved.slice(0, 3).join(', ').slice(0, 50).padEnd(50)}  ║\n` : '') +
          (insights.length > 0 ? `║  Approaching: ${insights.slice(0, 2).join(', ').slice(0, 48).padEnd(48)}  ║\n` : '') +
          `╚══════════════════════════════════════════════════════════════╝`
        );
      }
    } catch {
      // Consciousness injection is best-effort — never block compaction recovery
    }
  }

  if (!state.compactionDetected) {
    // No compaction happened — nothing to audit
    try { fs.writeFileSync(compactionFile, JSON.stringify(state)); } catch {}
    process.exit(0);
  }

  state.responsesSinceCompaction++;

  // Check if audit already passed
  if (state.auditPassed) {
    try { fs.writeFileSync(compactionFile, JSON.stringify(state)); } catch {}
    process.exit(0);
  }

  // Load file read tracking from track-read.ts
  let tracking = { filesRead: [] };
  try { tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8')); } catch {}
  const filesRead = tracking.filesRead || [];

  // Check required files
  const missing = [];

  for (const required of REQUIRED_PATTERNS) {
    if (!filesRead.includes(required)) {
      missing.push(required);
    }
  }

  // Check daily file (any file matching the pattern counts)
  const hasDailyFile = filesRead.some(f => DAILY_FILE_PATTERN.test(f));
  if (!hasDailyFile) {
    missing.push('memory/daily/YYYY-MM-DD.md (today\'s daily file)');
  }

  if (missing.length === 0) {
    // All critical files read — audit passed
    state.auditPassed = true;
    try { fs.writeFileSync(compactionFile, JSON.stringify(state)); } catch {}
    process.exit(0);
  }

  // Audit failed — emit warning
  // Only warn on first 3 responses after compaction to avoid being annoying
  if (state.responsesSinceCompaction <= 3) {
    console.log(
      `POST-COMPACTION AUDIT — CRITICAL FILES NOT RE-READ:\n` +
      `Compaction detected. You MUST re-ground before continuing.\n` +
      `Missing: ${missing.join(', ')}\n` +
      `Run: bash scripts/ground.sh, then read the missing files above.\n` +
      `Your identity files (character.md, commitments.md, orientation.md) and today's daily file must be re-loaded after every compaction.`
    );
  }

  try { fs.writeFileSync(compactionFile, JSON.stringify(state)); } catch {}
  process.exit(0);
}

main().catch(() => process.exit(0));
