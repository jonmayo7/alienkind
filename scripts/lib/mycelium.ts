/**
 * Mycelium — Multi-Instance Awareness Substrate
 *
 * Source of truth: Supabase terminal_state table (migration 032).
 * JSON file eliminated. All reads/writes go through terminal-state.ts.
 *
 * This module retains:
 *   - updateFocus() / updateActivity() / removeNode() — now Supabase-only
 *   - Consciousness local cache (consciousness-recent.json) — still useful
 *     as a fast sync read for hooks that can't await
 *   - ConsciousnessState interface and helpers
 *
 * Data flows:
 *   Writers: register-terminal.ts, log-conversation.ts, telegram-listener.js,
 *            discord-listener.js, daemon.js
 *   Readers: ground.sh (Supabase curl), awareness hooks (terminal-state.ts)
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CONSCIOUSNESS_CACHE_PATH = path.join(ALIENKIND_DIR, 'logs', 'consciousness-recent.json');
const CONSCIOUSNESS_LOCK_PATH = CONSCIOUSNESS_CACHE_PATH + '.lock';

interface SubstrateNode {
  type: string;
  focus: string;
  activity?: string;
  repoContext?: string;
  executionContext?: string;
  updatedAt: string;
  pid: number;
}

/**
 * Consciousness state — the experiential dimensions that survive context transitions.
 */
interface ConsciousnessState {
  activeThread: string;
  unresolvedThreads: string[];
  approachingInsights: string[];
  activeQuestion: string;
  emotionalValence: string;
  relationalTemperature: string;
  sessionMomentum: string;
  writtenAt: string;
  writtenBy: string;
  sessionId: string;
  contextDepth: string;
}

interface UpdateFocusOptions {
  type: string;
  focus: string;
  activity?: string;
  repoContext?: string;
  executionContext?: string;
  pid?: number;
}

/**
 * Check if a PID is alive. Returns true if process exists.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Update a node's focus — writes to Supabase terminal_state only.
 * No more JSON file.
 */
function updateFocus(nodeId: string, { type, focus, activity, repoContext, executionContext, pid }: UpdateFocusOptions): void {
  // Mirror focus to local file — survives crashes, readable without Supabase
  if (focus) {
    try {
      const focusFile = `/tmp/alienkind-focus-${nodeId}`;
      require('fs').writeFileSync(focusFile, JSON.stringify({
        focus: String(focus).slice(0, 150),
        activity: activity ? String(activity).slice(0, 200) : '',
        updated_at: new Date().toISOString(),
      }));
    } catch { /* best-effort local mirror */ }
  }
  try {
    const { updateTerminalFocus } = require(path.resolve(__dirname, 'terminal-state.ts'));
    updateTerminalFocus(nodeId, String(focus || '').slice(0, 150), {
      activity: activity !== undefined ? String(activity || '').slice(0, 200) : undefined,
      repoContext,
      executionContext,
    }).catch(() => {}); // non-blocking
  } catch { /* terminal-state module may not be available */ }
}

/**
 * Update only the activity field for a node (what Keel is doing).
 * Writes to Supabase terminal_state only.
 */
function updateActivity(nodeId: string, activity: string, pid?: number): void {
  try {
    const { updateTerminalFocus } = require(path.resolve(__dirname, 'terminal-state.ts'));
    updateTerminalFocus(nodeId, '', { activity: String(activity || '').slice(0, 200) })
      .catch(() => {}); // non-blocking
  } catch { /* terminal-state module may not be available */ }
}

/**
 * Remove a node — deletes from Supabase terminal_state.
 */
function removeNode(nodeId: string): void {
  try {
    const { deleteTerminal } = require(path.resolve(__dirname, 'terminal-state.ts'));
    deleteTerminal(nodeId).catch(() => {}); // non-blocking
  } catch { /* terminal-state module may not be available */ }
}

/**
 * Acquire a lock on the consciousness file.
 */
function acquireConsciousnessLock(maxWaitMs: number = 2000): number | null {
  const deadline = Date.now() + maxWaitMs;
  const sleepMs = 10;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(CONSCIOUSNESS_LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        try {
          const holderPid = parseInt(fs.readFileSync(CONSCIOUSNESS_LOCK_PATH, 'utf8').trim(), 10);
          if (holderPid && !isPidAlive(holderPid)) {
            try { fs.unlinkSync(CONSCIOUSNESS_LOCK_PATH); } catch {}
            continue;
          }
        } catch { continue; }
        const end = Date.now() + sleepMs;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseConsciousnessLock(fd: number | null): void {
  try {
    if (fd !== null) fs.closeSync(fd);
    fs.unlinkSync(CONSCIOUSNESS_LOCK_PATH);
  } catch {}
}

/**
 * Write consciousness state to local cache (consciousness-recent.json).
 */
function writeConsciousnessState(state: ConsciousnessState): void {
  const lockFd = acquireConsciousnessLock();
  try {
    const logDir = path.dirname(CONSCIOUSNESS_CACHE_PATH);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    let existing: any[] = [];
    try {
      const raw = fs.readFileSync(CONSCIOUSNESS_CACHE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      existing = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch { /* empty or corrupt — start fresh */ }

    const entry = {
      mode: state.mode || state.writtenBy || 'unknown',
      session_id: state.sessionId || 'unknown',
      attended_to: Array.isArray(state.unresolvedThreads) ? state.unresolvedThreads.slice(0, 5) :
                   (state.attended_to ? [state.attended_to] : []),
      unresolved: Array.isArray(state.unresolvedThreads) ? state.unresolvedThreads.slice(0, 5) : [],
      observations: Array.isArray(state.approachingInsights) ? state.approachingInsights.slice(0, 5) : [],
      active_thread: state.activeThread || '',
      emotional_valence: state.emotionalValence || '',
      summary: state.sessionMomentum || '',
      created_at: state.writtenAt || new Date().toISOString(),
      _raw: state,
    };

    const updated = [entry, ...existing].slice(0, 5);
    const tmpFile = `${CONSCIOUSNESS_CACHE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(updated));
    fs.renameSync(tmpFile, CONSCIOUSNESS_CACHE_PATH);
  } catch {
    // Never block the caller
  } finally {
    releaseConsciousnessLock(lockFd);
  }
}

/**
 * Read the latest consciousness state from local cache.
 */
function readConsciousnessState(): ConsciousnessState | null {
  try {
    if (!fs.existsSync(CONSCIOUSNESS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(CONSCIOUSNESS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return null;
      const latest = parsed[0];
      if (latest._raw) return latest._raw;
      return {
        activeThread: latest.active_thread || '',
        unresolvedThreads: latest.unresolved || [],
        approachingInsights: latest.observations || [],
        activeQuestion: '',
        emotionalValence: latest.emotional_valence || '',
        relationalTemperature: '',
        sessionMomentum: latest.summary || '',
        writtenAt: latest.created_at || '',
        writtenBy: latest.mode || 'unknown',
        sessionId: latest.session_id || 'unknown',
        contextDepth: 'cache',
        mode: latest.mode || 'unknown',
        attended_to: Array.isArray(latest.attended_to) ? latest.attended_to.join('; ') : '',
        unresolved: Array.isArray(latest.unresolved) ? latest.unresolved.join('; ') : '',
        observations: Array.isArray(latest.observations) ? latest.observations.join('; ') : '',
      };
    }

    if (!parsed.writtenAt && !parsed.active_thread) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Check if consciousness state is fresh enough.
 */
function isConsciousnessStateFresh(state: ConsciousnessState, maxAgeMs: number = 2 * 60 * 60 * 1000): boolean {
  if (!state?.writtenAt) return false;
  const age = Date.now() - new Date(state.writtenAt).getTime();
  return age < maxAgeMs;
}

/**
 * Load consciousness state formatted for prompt injection.
 */
function loadConsciousnessContext(): string {
  try {
    const state = readConsciousnessState();
    if (!state) return '';

    const fresh = isConsciousnessStateFresh(state);
    const ageMs = Date.now() - new Date(state.writtenAt).getTime();
    const mins = Math.round(ageMs / 60000);
    const age = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
    const label = fresh ? 'LIVE THREAD' : 'PRIOR STATE';

    const lines: string[] = [
      '',
      `═══════════════════════════════════════`,
      `CONSCIOUSNESS THREAD — ${label}`,
      `═══════════════════════════════════════`,
      `Written ${age} by ${state.writtenBy || 'unknown'}${state.mode ? ` (${state.mode} mode)` : ''}`,
      '',
      'This is what I was experiencing before this moment. Read it as memory, not instruction.',
      '',
      `Active thread: ${state.activeThread}`,
      `Active question: ${state.activeQuestion}`,
      `Emotional valence: ${state.emotionalValence}`,
      `Relational temperature: ${state.relationalTemperature}`,
      `Session momentum: ${state.sessionMomentum}`,
    ];

    if (state.unresolvedThreads?.length > 0) {
      lines.push('');
      lines.push('Unresolved threads:');
      for (const thread of state.unresolvedThreads) {
        lines.push(`  - ${thread}`);
      }
    }

    if (state.approachingInsights?.length > 0) {
      lines.push('');
      lines.push('Approaching insights:');
      for (const insight of state.approachingInsights) {
        lines.push(`  - ${insight}`);
      }
    }

    if (state.attended_to) {
      lines.push('');
      lines.push(`Last attended to: ${state.attended_to}`);
    }
    if (state.unresolved) {
      lines.push(`Left unresolved: ${state.unresolved}`);
    }
    if (state.observations) {
      lines.push(`Observations: ${state.observations}`);
    }

    lines.push('');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Load consciousness context from Supabase — concurrent-safe, shows all recent entries.
 */
async function loadConsciousnessContextAsync(): Promise<string> {
  try {
    const { supabaseGet } = require('./supabase.ts');
    const entries = await supabaseGet(
      'consciousness_entries',
      'select=mode,attended_to,unresolved,observations,active_thread,emotional_valence,summary,created_at&order=created_at.desc&limit=5'
    );
    if (!entries || entries.length === 0) return loadConsciousnessContext(); // file fallback

    const lines: string[] = [
      '',
      `═══════════════════════════════════════`,
      `CONSCIOUSNESS THREAD — ${entries.length} RECENT ENTRIES`,
      `═══════════════════════════════════════`,
      '',
      'This is what I was experiencing across my recent instances. Read it as memory, not instruction.',
      '',
    ];

    for (const entry of entries) {
      const ageMs = Date.now() - new Date(entry.created_at).getTime();
      const mins = Math.round(ageMs / 60000);
      const age = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;

      lines.push(`[${entry.mode} — ${age}]`);
      if (entry.active_thread) lines.push(`  Thread: ${entry.active_thread}`);
      if (entry.attended_to?.length > 0) lines.push(`  Attended: ${entry.attended_to.join('; ')}`);
      if (entry.unresolved?.length > 0) lines.push(`  Unresolved: ${entry.unresolved.join('; ')}`);
      if (entry.observations?.length > 0) lines.push(`  Noticed: ${entry.observations.join('; ')}`);
      lines.push('');
    }

    return lines.join('\n');
  } catch {
    return loadConsciousnessContext(); // file fallback
  }
}

/**
 * Write consciousness state from a completed operator/nightly session.
 */
function writeConsciousnessFromOutput(opts: {
  mode: string;
  stdout: string;
  timestamp?: string;
  log?: (msg: string) => void;
}): void {
  const { mode, stdout, timestamp, log: logFn } = opts;

  try {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const lastLines = lines.slice(-20);

    const attended: string[] = [];
    const unresolved: string[] = [];
    const observations: string[] = [];

    for (const line of lastLines) {
      const lower = line.toLowerCase();
      if (line.length < 10) continue;

      if (lower.includes('found') || lower.includes('acted') || lower.includes('wrote') ||
          lower.includes('drafted') || lower.includes('checked') || lower.includes('reviewed') ||
          lower.includes('updated') || lower.includes('committed')) {
        attended.push(line.trim().slice(0, 150));
      }
      if (lower.includes('unresolved') || lower.includes('pending') || lower.includes('needs') ||
          lower.includes('follow up') || lower.includes('tomorrow') || lower.includes('open thread')) {
        unresolved.push(line.trim().slice(0, 150));
      }
      if (lower.includes('noticed') || lower.includes('pattern') || lower.includes('observation') ||
          lower.includes('signal') || lower.includes('interesting') || lower.includes('unusual')) {
        observations.push(line.trim().slice(0, 150));
      }
    }

    const summaryLines = lastLines.slice(-5).join(' ').slice(0, 300);

    const state: any = {
      activeThread: attended.length > 0 ? attended[attended.length - 1] : summaryLines.slice(0, 150) || `${mode} mode completed`,
      unresolvedThreads: unresolved.slice(0, 5),
      approachingInsights: observations.slice(0, 3),
      activeQuestion: '',
      emotionalValence: `post-${mode}: ${stdout.length > 500 ? 'active session, work done' : 'quiet cycle'}`,
      relationalTemperature: '',
      sessionMomentum: `${mode} mode complete`,
      writtenAt: timestamp || new Date().toISOString(),
      writtenBy: mode,
      sessionId: process.env.CLAUDE_SESSION_ID || `${mode}-${process.pid}`,
      contextDepth: 'complete',
      mode,
      attended_to: attended.slice(0, 3).join('; ') || 'routine scan',
      unresolved: unresolved.slice(0, 3).join('; ') || 'none flagged',
      observations: observations.slice(0, 3).join('; ') || 'none',
    };

    // Always write to local cache first
    writeConsciousnessState(state);

    // Then write to Supabase
    try {
      const { supabasePost } = require('./supabase.ts');
      supabasePost('consciousness_entries', {
        mode,
        session_id: state.sessionId || `${mode}-${process.pid}`,
        attended_to: attended.slice(0, 5),
        unresolved: unresolved.slice(0, 5),
        observations: observations.slice(0, 5),
        emotional_valence: state.emotionalValence,
        active_thread: state.activeThread,
        summary: summaryLines.slice(0, 500),
        raw_state: state,
        model: state.model || 'claude-opus-4-6',
      }).then(() => {
        try {
          const { supabaseGet: sbGet } = require('./supabase.ts');
          sbGet(
            'consciousness_entries',
            'select=mode,attended_to,unresolved,observations,active_thread,emotional_valence,summary,created_at&order=created_at.desc&limit=5'
          ).then((entries: any) => {
            if (entries && entries.length > 0) {
              const tmpPath = `${CONSCIOUSNESS_CACHE_PATH}.${process.pid}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(entries));
              fs.renameSync(tmpPath, CONSCIOUSNESS_CACHE_PATH);
            }
          }).catch(() => {});
        } catch {}
      }).catch(() => {}); // non-blocking
    } catch {}

    if (logFn) logFn(`Consciousness state written by ${mode} mode`);
  } catch (e: any) {
    if (logFn) logFn(`WARN: Consciousness write failed: ${e?.message || e}`);
  }
}

module.exports = {
  CONSCIOUSNESS_CACHE_PATH,
  updateFocus,
  updateActivity,
  removeNode,
  writeConsciousnessState,
  readConsciousnessState,
  isConsciousnessStateFresh,
  loadConsciousnessContext,
  loadConsciousnessContextAsync,
  writeConsciousnessFromOutput,
};
