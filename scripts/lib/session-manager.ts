/**
 * Session Manager — persistent Claude sessions with daily rotation.
 *
 * Tracks the current day's session ID. First job creates a new session
 * via --session-id. Subsequent jobs continue via --resume.
 *
 * Session state persisted to a configurable JSON file so processes
 * can recover session IDs after restart.
 *
 * Safety valves:
 *   - Daily rotation at midnight (automatic)
 *   - maxJobs rotation: after N jobs, force a new session to prevent context bloat
 *   - forceRotate(): manual rotation for compaction recovery
 *
 * Usage:
 *   const sessions = createSessionManager({ log });
 *   const { sessionId, isResume } = sessions.getSession();
 *   sessions.recordJob();
 *   sessions.rotateDaily();
 *
 * Multi-consumer:
 *   const daemonSessions = createSessionManager({ log, stateFile: 'logs/daemon-sessions.json' });
 *   const telegramSessions = createSessionManager({ log, prefix: 'tg', stateFile: 'logs/telegram-sessions.json' });
 *   const discordSessions = createSessionManager({ log, prefix: 'disc', stateFile: 'logs/discord-sessions.json' });
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEL_DIR = path.resolve(__dirname, '../..');
const DEFAULT_STATE_FILE = path.join(KEEL_DIR, 'logs', 'daemon-sessions.json');
const DEFAULT_MAX_JOBS = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionState {
  currentDate: string | null;
  sessionId: string | null;
  label: string | null;
  jobCount: number;
  createdAt: string | null;
  rotationCount: number;
}

interface SessionResult {
  sessionId: string;
  isResume: boolean;
}

interface SessionHealth {
  sessionId: string | null;
  label: string | null;
  jobCount: number;
  maxJobs: number;
  rotationCount: number;
  currentDate: string | null;
  createdAt: string | null;
  pressure: number;
}

interface SessionManagerOptions {
  log?: (...args: any[]) => void;
  prefix?: string;
  stateFile?: string;
  maxJobs?: number;
}

interface SessionManager {
  getSession(): SessionResult;
  recordJob(): void;
  rotateDaily(): void;
  forceRotate(reason: string): void;
  getHealth(): SessionHealth;
  save(): void;
  readonly sessionId: string | null;
  readonly jobCount: number;
  readonly currentDate: string | null;
}

interface ReadSessionResult {
  sessionId: string;
  currentDate: string;
  jobCount: number;
}

function createSessionManager({ log = console.log, prefix = 'auto', stateFile, maxJobs }: SessionManagerOptions = {}): SessionManager {
  const STATE_FILE = stateFile
    ? (path.isAbsolute(stateFile) ? stateFile : path.join(KEEL_DIR, stateFile))
    : DEFAULT_STATE_FILE;

  const MAX_JOBS = maxJobs || DEFAULT_MAX_JOBS;

  let state: SessionState = {
    currentDate: null,
    sessionId: null,
    label: null,
    jobCount: 0,
    createdAt: null,
    rotationCount: 0,
  };

  function getDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function createNewSession(): string {
    state.sessionId = crypto.randomUUID();
    state.label = `${prefix}-${getDate()}`;
    state.jobCount = 0;
    state.createdAt = new Date().toISOString();
    return state.sessionId;
  }

  function load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const today = getDate();
        if (data.currentDate === today && data.sessionId) {
          // Reject legacy non-UUID session IDs (pre-fix format: prefix-date-hex)
          if (!UUID_RE.test(data.sessionId)) {
            log('INFO', `[sessions] Legacy non-UUID session ${data.sessionId} — creating new UUID session`);
            return;
          }
          state = { ...state, ...data };
          log('INFO', `[sessions] Restored session: ${state.label || state.sessionId} (${state.jobCount} jobs today, rotation #${state.rotationCount || 0})`);
          return;
        }
        log('INFO', `[sessions] Stale session from ${data.currentDate} — will create new`);
      }
    } catch (err: any) {
      log('WARN', `[sessions] Failed to load state: ${err.message}`);
    }
  }

  function save(): void {
    try {
      const tmpFile = STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (err: any) {
      log('WARN', `[sessions] Failed to save state: ${err.message}`);
    }
  }

  function getSession(): SessionResult {
    const today = getDate();
    if (state.currentDate !== today || !state.sessionId) {
      // New day or no session — create fresh
      state.currentDate = today;
      state.rotationCount = 0;
      createNewSession();
      log('INFO', `[sessions] New daily session: ${state.label} (${state.sessionId})`);
      save();
      return { sessionId: state.sessionId!, isResume: false };
    }

    // Safety valve: rotate if too many jobs accumulated
    if (state.jobCount >= MAX_JOBS) {
      state.rotationCount = (state.rotationCount || 0) + 1;
      const oldId = state.sessionId;
      createNewSession();
      log('INFO', `[sessions] Context pressure rotation: ${oldId} → ${state.sessionId} (${MAX_JOBS} jobs hit, rotation #${state.rotationCount})`);
      save();
      return { sessionId: state.sessionId!, isResume: false };
    }

    // Existing session — resume
    return { sessionId: state.sessionId, isResume: state.jobCount > 0 };
  }

  function recordJob(): void {
    state.jobCount++;
    save();
  }

  function forceRotate(reason: string): void {
    state.rotationCount = (state.rotationCount || 0) + 1;
    const oldId = state.sessionId;
    createNewSession();
    log('INFO', `[sessions] Forced rotation: ${oldId} → ${state.sessionId} (reason: ${reason}, rotation #${state.rotationCount})`);
    save();
  }

  function rotateDaily(): void {
    const today = getDate();
    if (state.currentDate !== today) {
      log('INFO', `[sessions] Midnight rotation: ${state.currentDate} → ${today}`);
      state.currentDate = today;
      state.sessionId = null;
      state.jobCount = 0;
      state.rotationCount = 0;
      save();
    }
  }

  function getHealth(): SessionHealth {
    return {
      sessionId: state.sessionId,
      label: state.label,
      jobCount: state.jobCount,
      maxJobs: MAX_JOBS,
      rotationCount: state.rotationCount || 0,
      currentDate: state.currentDate,
      createdAt: state.createdAt,
      pressure: state.jobCount / MAX_JOBS,
    };
  }

  // Load on creation
  load();

  return {
    getSession,
    recordJob,
    rotateDaily,
    forceRotate,
    getHealth,
    save,
    get sessionId() { return state.sessionId; },
    get jobCount() { return state.jobCount; },
    get currentDate() { return state.currentDate; },
  };
}

/**
 * Read session state from any session file (cross-process).
 * Returns { sessionId, currentDate, jobCount } or null if no valid session today.
 */
function readSessionState(stateFilePath: string): ReadSessionResult | null {
  try {
    const absPath = path.isAbsolute(stateFilePath)
      ? stateFilePath
      : path.join(KEEL_DIR, stateFilePath);
    if (fs.existsSync(absPath)) {
      const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (data.currentDate === today && data.sessionId && UUID_RE.test(data.sessionId)) {
        return { sessionId: data.sessionId, currentDate: data.currentDate, jobCount: data.jobCount || 0 };
      }
    }
  } catch { /* ok */ }
  return null;
}

module.exports = { createSessionManager, readSessionState };
