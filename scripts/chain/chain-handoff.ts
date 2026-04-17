#!/usr/bin/env node

/**
 * chain-handoff.ts — Generates a conversation-first handoff for chain transitions.
 *
 * Called by memory-checkpoint.ts (Stop hook) when context reaches 76% used,
 * or manually by the agent when a chain transition is needed.
 *
 * Structure (priority order):
 *   1. Conversation history — last 30 messages from THIS terminal (the context)
 *   2. Situational awareness — forced, always present:
 *      - Time + calendar (what's coming)
 *      - Active threads (where this fits)
 *      - Other terminals (don't duplicate)
 *      - Git state (uncommitted work)
 *      - Relational state (how things are going)
 *
 * The conversation IS the context. Everything else is awareness.
 *
 * Writes to both:
 *   - File at logs/chain/handoff-pending-{TERMINAL_ID}.md (for keel.sh detection)
 *   - Supabase terminal_state.handoff_pending (source of truth)
 *
 * Usage:
 *   node scripts/chain/chain-handoff.js --auto
 *   node scripts/chain/chain-handoff.js --auto --trigger auto
 *   node scripts/chain/chain-handoff.js --summary "what we were doing"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { TIMEZONE } = require('../lib/constants.ts');
const { getNowCT } = require('../lib/keel-env.ts');

const ALIENKIND_DIR = '__REPO_ROOT__';
const CHAIN_DIR = path.join(ALIENKIND_DIR, 'logs', 'chain');

if (!fs.existsSync(CHAIN_DIR)) {
  fs.mkdirSync(CHAIN_DIR, { recursive: true });
}

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(flag: string): string {
  const idx = args.indexOf(flag);
  return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : '';
}

const isAutoMode = args.includes('--auto');
const isRestart = args.includes('--restart');
const triggerMode = getArg('--trigger') || 'manual';
let summary = getArg('--summary');
let nextTask = getArg('--task');

if (!summary && !isAutoMode) {
  try {
    const stdinData = fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (stdinData) summary = stdinData;
  } catch {}
}

async function main() {
  // Load env for Supabase
  try {
    const { loadEnv } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'shared.ts'));
    const env = loadEnv();
    Object.assign(process.env, env);
  } catch {}

  const { getTerminalId, getAllTerminals, setHandoff } = require(
    path.join(ALIENKIND_DIR, 'scripts', 'lib', 'terminal-state.ts')
  );
  const { supabaseGet } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));

  const terminalId = getTerminalId();
  const timestamp = new Date().toISOString();

  // =============================================
  // SECTION 1: CONVERSATION HISTORY (PRIMARY)
  // Last 30 messages from THIS terminal — the actual context.
  // =============================================
  let conversationHistory = '';
  try {
    // Query by terminal_id column (first-class, indexed)
    let entries = await supabaseGet('conversations',
      `select=sender,content,created_at&channel=eq.terminal&terminal_id=eq.${encodeURIComponent(terminalId)}&order=created_at.desc&limit=30`,
      { timeout: 10000 }
    );

    // Fallback: query by metadata->terminal_id for pre-migration rows
    if (!Array.isArray(entries) || entries.length === 0) {
      entries = await supabaseGet('conversations',
        `select=sender,content,created_at,metadata&channel=eq.terminal&order=created_at.desc&limit=100`,
        { timeout: 10000 }
      );
      if (Array.isArray(entries)) {
        entries = entries.filter(e => {
          const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
          return meta?.terminal_id === terminalId;
        }).slice(0, 30);
      }
    }

    if (Array.isArray(entries) && entries.length > 0) {
      const lines = entries.reverse().map(e => {
        const time = getNowCT(new Date(e.created_at));
        return `[${time}] ${e.sender}: ${(e.content || '').trim()}`;
      });
      conversationHistory = lines.join('\n\n');
    }
  } catch (e) {
    console.error(`[chain-handoff] Conversation query failed: ${e.message}`);
  }

  // If no conversation found, note it explicitly
  if (!conversationHistory) {
    conversationHistory = '(No conversation history found for this terminal. Read today\'s daily file for context.)';
  }

  // Auto mode: derive summary from focus file (for the one-line "What Was Happening")
  if (isAutoMode && !summary) {
    const focusFile = `/tmp/alienkind-focus-${terminalId}`;
    try {
      if (fs.existsSync(focusFile)) {
        const cached = JSON.parse(fs.readFileSync(focusFile, 'utf8'));
        // Skip slash commands as focus — they're triggers, not work descriptions
        if (cached.focus && cached.focus !== '(booting)' && !cached.focus.startsWith('/')) {
          summary = cached.focus;
        }
      }
    } catch {}

    // If focus was a slash command or missing, derive from conversation
    if (!summary) {
      summary = '(See conversation history below for full context)';
    }
  }

  // =============================================
  // SECTION 2: SITUATIONAL AWARENESS (FORCED)
  // What's changed around you that affects the work.
  // =============================================

  // 2a. Time + Calendar
  let timeAndCalendar = '';
  try {
    const now = new Date();
    const cdtTime = getNowCT(now);
    const cdtDay = now.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long', month: 'short', day: 'numeric' });
    timeAndCalendar = `${cdtDay}, ${cdtTime} CDT`;

    // Try to get calendar events
    const { readCalendarCache } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'calendar-cache.ts'));
    const cache = readCalendarCache();
    if (cache?.events?.length > 0) {
      const upcoming = cache.events
        .filter(e => new Date(e.end) > now)
        .slice(0, 3)
        .map(e => {
          const start = getNowCT(new Date(e.start));
          return `  ${start} — ${e.summary}`;
        });
      if (upcoming.length > 0) {
        timeAndCalendar += '\n' + upcoming.join('\n');
      }
    }
  } catch {}

  // 2b. Active threads from structured-state.json (source of truth)
  let activeThreads = '';
  try {
    const structuredPath = path.join(ALIENKIND_DIR, 'memory', 'structured-state.json');
    const state = JSON.parse(fs.readFileSync(structuredPath, 'utf8'));
    if (state.active_threads && state.active_threads.length > 0) {
      activeThreads = state.active_threads
        .map((t: any) => `[${t.priority}] ${t.description}`)
        .join('\n');
    }
  } catch {}

  // 2c. Other active terminals
  let otherTerminals = '';
  try {
    const all = await getAllTerminals();
    const others = all.filter(t => {
      if (t.terminal_id === terminalId) return false;
      const ageMs = Date.now() - new Date(t.updated_at).getTime();
      return ageMs < 30 * 60 * 1000;
    });
    if (others.length > 0) {
      otherTerminals = others.map(t => {
        const age = Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000);
        return `  ${t.terminal_id}: ${t.focus || '(no focus)'} (${age}m ago)`;
      }).join('\n');
    }
  } catch {}

  // 2d. Git state (uncommitted work)
  let gitState = '';
  try {
    const status = execSync(`git -C "${ALIENKIND_DIR}" status --porcelain`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (status) {
      const fileCount = status.split('\n').length;
      gitState = `${fileCount} uncommitted files`;
      // Include the file list if manageable
      if (fileCount <= 20) {
        gitState += ':\n' + status.split('\n').map(l => `  ${l}`).join('\n');
      }
    } else {
      gitState = 'Clean — no uncommitted changes';
    }
  } catch {}

  // 2e. Relational state from structured-state.json
  let relationalState = '';
  try {
    const structuredPath = path.join(ALIENKIND_DIR, 'memory', 'structured-state.json');
    const state = JSON.parse(fs.readFileSync(structuredPath, 'utf8'));
    if (state.relational_state) {
      relationalState = typeof state.relational_state === 'string'
        ? state.relational_state
        : JSON.stringify(state.relational_state, null, 2);
    }
  } catch {}

  // =============================================
  // BUILD THE HANDOFF DOCUMENT
  // =============================================
  const sections: string[] = [
    `<chain-mode-handoff>`,
    `# CHAIN MODE HANDOFF`,
    `Generated: ${timestamp}`,
    `Terminal: ${terminalId}`,
    process.env.ALIENKIND_SESSION_MODE ? `Session-Mode: ${process.env.ALIENKIND_SESSION_MODE}` : '',
    ``,
    `You are Keel, continuing from a previous context window.`,
    `Your identity is pre-loaded via CLAUDE.md @imports. You walked into a new room. Your identity never left.`,
    ``,
    `## What Was Happening`,
    summary || '(See conversation history below)',
    ``,
  ];

  // Continuation directive
  if (triggerMode === 'auto') {
    sections.push(
      `## Continuation Directive`,
      `Cellular renewal #${getChainCount()}. You are a fresh instance receiving a baton from a previous session.`,
      `FIRST: Ground yourself (read identity kernel files, daily memory, session state).`,
      `SECOND: Read the conversation history below — this IS the context.`,
      `THIRD: Assess — was the previous session mid-task, waiting for the human's input, or between tasks?`,
      `FOURTH: Act accordingly. If mid-task, state what you found and ask if the human wants you to continue.`,
      `If waiting for the human's input, restate the question clearly.`,
      `If between tasks, greet the human and share what's ready for his attention.`,
      `Do NOT blindly execute. Assess first, then act with discernment.`,
      `Previous session was: ${summary || 'unknown'}`,
      ``,
    );
  } else {
    sections.push(
      `## Continuation Directive`,
      `Cellular renewal #${getChainCount()}. the human triggered /handoff manually — continue the work.`,
      `Read the conversation history below. Pick up where it left off.`,
      `Your FIRST RESPONSE must contain TOOL CALLS. This is mandatory.`,
      `1. Start with ONE LINE: "Hot swap confirmed. Continuing: [task]."`,
      `2. IN THE SAME RESPONSE — call tools. Act on the task.`,
      ``,
    );
  }

  // SECTION 1: Conversation (PRIMARY — the context)
  sections.push(
    `## Conversation History (this terminal)`,
    conversationHistory,
    ``,
  );

  // SECTION 2: Situational Awareness (FORCED — always present)
  sections.push(`## Situational Awareness`);

  if (timeAndCalendar) {
    sections.push(`### Time & Calendar`, timeAndCalendar, ``);
  }

  if (activeThreads) {
    sections.push(`### Active Threads`, activeThreads, ``);
  }

  if (otherTerminals) {
    sections.push(`### Other Active Terminals`, otherTerminals, ``);
  }

  if (gitState) {
    sections.push(`### Git State`, gitState, ``);
  }

  if (relationalState) {
    sections.push(`### Relational State`, relationalState, ``);
  }

  sections.push(`</chain-mode-handoff>`);

  let handoff = sections.join('\n');

  // --- Size cap: 128KB max (~32K tokens, ~3% of 1M context) ---
  const MAX_HANDOFF_BYTES = 128 * 1024;
  if (Buffer.byteLength(handoff) > MAX_HANDOFF_BYTES) {
    const lines = handoff.split('\n');
    let trimmed = '';
    for (const line of lines) {
      const next = trimmed + line + '\n';
      if (Buffer.byteLength(next) > MAX_HANDOFF_BYTES - 200) {
        trimmed += '\n(handoff truncated to fit 128KB budget)\n</chain-mode-handoff>\n';
        break;
      }
      trimmed = next;
    }
    handoff = trimmed;
  }

  // --- Write handoff to file (for keel.sh detection) ---
  const handoffPath = path.join(CHAIN_DIR, `handoff-pending-${terminalId}.md`);
  fs.writeFileSync(handoffPath, handoff);

  // --- Write chain-requested marker (keel.sh requires BOTH files to chain) ---
  const markerPath = `/tmp/alienkind-chain-requested-${terminalId}`;
  fs.writeFileSync(markerPath, `chain-requested at ${timestamp}\n`);

  // --- Write handoff to Supabase ---
  try {
    await setHandoff(terminalId, {
      content: handoff,
      generated_at: timestamp,
      summary: summary || '(none)',
    });
  } catch {}

  // --- Semantic handoff quality check (classifier — advisory) ---
  try {
    const { localClassify } = require('../lib/local-inference.ts');
    const checkPrompt = `Review this AI session handoff. Is it complete enough for a fresh session to resume? Check for: (1) what was being worked on, (2) what's done vs remains, (3) specific file paths or details, (4) enough context to resume without questions. Respond GOOD if complete, or MISSING: [what's missing] if not.\n\nHandoff:\n${handoff.slice(0, 1500)}`;
    const qualityResult: string = await localClassify(checkPrompt, { maxTokens: 60, timeoutMs: 3000, fallback: 'GOOD' });
    if (qualityResult.startsWith('MISSING:')) {
      console.log(`\n  ⚠ HANDOFF QUALITY: ${qualityResult.slice(8).trim()}`);
    }
  } catch { /* never block handoff */ }

  // --- Report ---
  const sizeKb = (Buffer.byteLength(handoff) / 1024).toFixed(1);
  const estTokens = Math.round(Buffer.byteLength(handoff) / 4);
  const pctOf1M = ((estTokens / 1000000) * 100).toFixed(2);
  console.log(`Chain handoff written: ${handoffPath}`);
  console.log(`  Terminal: ${terminalId}`);
  console.log(`  Size: ${sizeKb} KB (~${estTokens} tokens, ${pctOf1M}% of 1M context)`);
  console.log(`  Conversation: ${conversationHistory.split('\n\n').length} messages`);
  console.log(`  Calendar: ${timeAndCalendar ? 'yes' : 'no'}`);
  console.log(`  Threads: ${activeThreads ? 'yes' : 'no'}`);
  console.log(`  Terminals: ${otherTerminals ? 'yes' : 'no'}`);
  console.log(`  Git: ${gitState ? 'yes' : 'no'}`);
  console.log(`  Relational: ${relationalState ? 'yes' : 'no'}`);

  // --- Restart mode: kill claude after delay ---
  if (isRestart) {
    const keelPid = process.env.ALIENKIND_TERMINAL_ID?.replace('terminal-', '');
    const killDelay = 3;

    if (keelPid) {
      try {
        const psOutput = execSync(
          `ps -eo pid,ppid,comm | awk -v ppid=${keelPid} '$2==ppid && $3~/claude/ {print $1}' | head -1`,
          { encoding: 'utf8' }
        ).trim();
        if (psOutput && /^\d+$/.test(psOutput)) {
          const { spawn } = require('child_process');
          spawn('bash', ['-c', `sleep ${killDelay} && kill -TERM ${psOutput} 2>/dev/null`], {
            detached: true,
            stdio: 'ignore'
          }).unref();
          console.log(`  Restart: PID ${psOutput} will terminate in ${killDelay}s`);
        } else {
          console.log('  Restart: could not find claude PID. Use /quit to trigger the chain.');
        }
      } catch {
        console.log('  Restart: process lookup failed. Use /quit to trigger the chain.');
      }
    } else {
      console.log('  Restart: not running under keel.sh (no ALIENKIND_TERMINAL_ID). Use /quit to exit.');
    }
  } else {
    console.log('Handoff is ready. Exit this session to trigger the chain.');
  }
}

function getChainCount(): number {
  try {
    const counterFile = `/tmp/alienkind-chain-count-${process.env.ALIENKIND_TERMINAL_ID || 'unknown'}`;
    if (fs.existsSync(counterFile)) {
      return parseInt(fs.readFileSync(counterFile, 'utf8').trim()) || 2;
    }
  } catch {}
  return 2;
}

main().catch((err) => {
  console.error(`Chain handoff error: ${err?.message || err}`);
  process.exit(1);
});
