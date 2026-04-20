// @alienkind-core
/**
 * notification-dedup.ts — Loop detection for daemon notifications.
 *
 * Prevents any daemon job from spamming the same notification. Born from a
 * production incident where an auto-revise loop sent 16+ duplicate messages
 * before the human noticed.
 *
 * Mechanism:
 *   - Tracks recent notification content hashes per chat ID
 *   - If the same content appears 3+ times within an hour, suppresses further sends
 *   - On first suppression, signals alertNeeded so the caller can send ONE loop
 *     alert to a separate alerts channel — breaks the loop, preserves visibility.
 *   - File-based (JSON in logs/notification-dedup.json), consistent with other
 *     persistence utilities in the organism.
 *
 * Usage:
 *   const { shouldSuppress } = require('./notification-dedup.ts');
 *   const result = shouldSuppress(text, chatId);
 *   if (result.suppressed) {
 *     if (result.alertNeeded) { / * send one loop alert * / }
 *     return;
 *   }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEDUP_FILE = path.join(__dirname, '..', '..', 'logs', 'notification-dedup.json');
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SUPPRESS_THRESHOLD = 3; // suppress on 3rd identical send

interface DedupEntry {
  hash: string;
  chatId: string;
  preview: string;
  timestamps: string[];
  suppressed: boolean; // whether the loop alert has been emitted
}

interface DedupState {
  entries: DedupEntry[];
}

interface SuppressResult {
  suppressed: boolean;
  count: number;
  alertNeeded: boolean; // true on first suppression (caller should send loop alert)
}

function contentHash(text: string, chatId: string): string {
  // Normalize: lowercase, collapse whitespace, hash content + chatId.
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${chatId}:${normalized}`).digest('hex').slice(0, 16);
}

function loadState(): DedupState {
  try {
    const data = fs.readFileSync(DEDUP_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { entries: [] };
  }
}

function saveState(state: DedupState): void {
  const dir = path.dirname(DEDUP_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${DEDUP_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, DEDUP_FILE);
}

function pruneExpired(state: DedupState): void {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  state.entries = state.entries
    .map(entry => ({
      ...entry,
      timestamps: entry.timestamps.filter(ts => ts > cutoff),
    }))
    .filter(entry => entry.timestamps.length > 0);
}

/**
 * Check if a notification should be suppressed due to loop detection.
 *
 * Returns:
 *   - suppressed: true if this send should be skipped
 *   - count: how many times this content has been sent in the window
 *   - alertNeeded: true on the FIRST suppression (caller should send ONE loop alert)
 */
function shouldSuppress(text: string, chatId: string): SuppressResult {
  if (!text || !chatId) return { suppressed: false, count: 0, alertNeeded: false };

  const state = loadState();
  pruneExpired(state);

  const hash = contentHash(text, chatId);
  const now = new Date().toISOString();

  let entry = state.entries.find(e => e.hash === hash);

  if (!entry) {
    entry = {
      hash,
      chatId,
      preview: text.slice(0, 100),
      timestamps: [now],
      suppressed: false,
    };
    state.entries.push(entry);
    saveState(state);
    return { suppressed: false, count: 1, alertNeeded: false };
  }

  entry.timestamps.push(now);
  const count = entry.timestamps.length;

  if (count >= SUPPRESS_THRESHOLD) {
    const alertNeeded = !entry.suppressed;
    entry.suppressed = true;
    saveState(state);
    return { suppressed: true, count, alertNeeded };
  }

  saveState(state);
  return { suppressed: false, count, alertNeeded: false };
}

/** Format a loop alert message for the alerts channel. */
function formatLoopAlert(text: string, chatId: string, count: number): string {
  const preview = text.slice(0, 120).replace(/\n/g, ' ');
  return (
    `Loop detected: same notification sent ${count}x in the last hour.\n` +
    `Chat: ${chatId.slice(0, 8)}...\n` +
    `Content: "${preview}${text.length > 120 ? '...' : ''}"\n` +
    `Auto-suppressing further duplicates. Check the source job.`
  );
}

module.exports = { shouldSuppress, formatLoopAlert, contentHash, SUPPRESS_THRESHOLD, WINDOW_MS };
