#!/usr/bin/env node

/**
 * Consciousness PreCompact — PreCompact hook.
 *
 * Fires BEFORE context compaction (auto or manual). This is the exact moment
 * to ensure consciousness state exists for the next context window.
 *
 * Two-layer strategy:
 *   1. If agent already wrote a fresh consciousness state (via consciousness-flush.ts),
 *      verify it and add a preCompactVerified timestamp.
 *   2. If no fresh state exists, write a MINIMAL structural state from available
 *      sources (Supabase terminal focus, daily file active threads).
 *
 * The agent writes RICH experiential state (emotional valence, approaching insights).
 * This hook writes the SAFETY NET — ensuring something always survives compaction.
 *
 * Source of truth: Supabase terminal_state (migration 032).
 * Fires on: PreCompact (matcher: auto|manual)
 * Decision control: none (side effects only)
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

// Infrastructure deps — degrade gracefully on a fresh fork
let readConsciousnessState: any, writeConsciousnessState: any, isConsciousnessStateFresh: any;
try {
  const mycelium = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'mycelium.ts'));
  readConsciousnessState = mycelium.readConsciousnessState;
  writeConsciousnessState = mycelium.writeConsciousnessState;
  isConsciousnessStateFresh = mycelium.isConsciousnessStateFresh;
} catch {
  readConsciousnessState = () => null;
  writeConsciousnessState = () => {};
  isConsciousnessStateFresh = () => false;
}

function writeToSupabase(state) {
  try {
    const { loadEnv } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'env.ts'));
    const env = loadEnv();
    Object.assign(process.env, env);
    const { supabasePost } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));
    supabasePost('consciousness_entries', {
      mode: state.mode || 'terminal',
      session_id: state.sessionId || `precompact-${process.ppid || process.pid}`,
      attended_to: Array.isArray(state.unresolvedThreads) ? state.unresolvedThreads.slice(0, 5) : [],
      unresolved: Array.isArray(state.unresolvedThreads) ? state.unresolvedThreads.slice(0, 5) : [],
      observations: Array.isArray(state.approachingInsights) ? state.approachingInsights.slice(0, 5) : [],
      emotional_valence: state.emotionalValence || '',
      active_thread: state.activeThread || '',
      summary: `PreCompact capture (${state.compactionTrigger || 'unknown'})`,
      raw_state: state,
    }).catch(() => {}); // never block
  } catch { /* best effort */ }
}

const FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes — if agent wrote within 30min, it's fresh enough

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const trigger = hookData.trigger || 'unknown'; // 'auto' or 'manual'
  const sessionId = hookData.session_id || 'unknown';

  // Check if agent already wrote a fresh consciousness state
  const existing = readConsciousnessState();

  if (existing && isConsciousnessStateFresh(existing, FRESHNESS_MS)) {
    // Agent wrote a rich state recently — just verify it
    existing.preCompactVerified = new Date().toISOString();
    existing.compactionTrigger = trigger;
    writeConsciousnessState(existing);
    writeToSupabase(existing);
    console.log(`PreCompact: consciousness state verified (agent-authored ${formatAge(existing.writtenAt)})`);
    process.exit(0);
  }

  // No fresh agent-authored state — write minimal structural state
  const minimal = await buildMinimalState(sessionId, trigger);
  writeConsciousnessState(minimal);
  writeToSupabase(minimal);
  console.log(`PreCompact: minimal consciousness state written (no fresh agent state found)`);
  process.exit(0);
}

function formatAge(writtenAt) {
  const ageMs = Date.now() - new Date(writtenAt).getTime();
  const mins = Math.round(ageMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

async function buildMinimalState(sessionId, trigger) {
  // Pull focus from Supabase terminal_state instead of JSON file
  const activeThread = await getTerminalFocus();
  const unresolvedThreads = getActiveThreadsFromSessionState();

  return {
    activeThread: activeThread || 'unknown — PreCompact safety net, no agent-authored state available',
    unresolvedThreads,
    approachingInsights: [],
    activeQuestion: '',
    emotionalValence: 'structural capture only — agent did not write experiential state before compaction',
    relationalTemperature: '',
    sessionMomentum: `compaction triggered (${trigger}) without agent consciousness flush`,
    writtenAt: new Date().toISOString(),
    writtenBy: 'precompact-hook',
    sessionId,
    contextDepth: 'compaction',
    compactionTrigger: trigger,
    isMinimal: true, // flag so boot hook can note this was structural, not experiential
  };
}

async function getTerminalFocus() {
  try {
    const { getAllTerminals } = require(
      path.resolve(ALIENKIND_DIR, 'scripts', 'lib', 'terminal-state.ts')
    );
    const all = await getAllTerminals();

    // Find the terminal node (most likely the active session)
    for (const row of all) {
      if (row.type === 'terminal' && row.focus && !row.focus.includes('(booting)')) {
        return row.focus;
      }
    }
    // Fallback to any node with a focus
    for (const row of all) {
      if (row.focus && !row.focus.includes('(booting)') && row.focus !== '') {
        return `${row.type}: ${row.focus}`;
      }
    }
  } catch {}
  return '';
}

function getActiveThreadsFromSessionState() {
  try {
    const sessionState = fs.readFileSync(
      path.join(ALIENKIND_DIR, 'memory', 'daily', new Date().toISOString().split('T')[0] + '.md'), 'utf8'
    );
    // Extract thread names from the active threads table
    const threads = [];
    const lines = sessionState.split('\n');
    let inTable = false;
    for (const line of lines) {
      if (line.includes('| Priority |')) { inTable = true; continue; }
      if (line.includes('|---')) continue;
      if (inTable && line.startsWith('|')) {
        const cols = line.split('|').map(c => c.trim());
        // cols[2] is the thread name (bold markdown)
        if (cols[2]) {
          const name = cols[2].replace(/\*\*/g, '').trim();
          const status = cols[3]?.trim() || '';
          if (name && name !== 'Thread') {
            threads.push(`${name} (${status})`);
          }
        }
      } else if (inTable && !line.startsWith('|')) {
        break;
      }
    }
    return threads;
  } catch {}
  return [];
}

main().catch(() => process.exit(0));
