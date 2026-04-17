/**
 * File Touch Tracker — Multi-Terminal Coordination Layer
 *
 * Tracks which terminal last modified which file. Used by conflict-guard.ts
 * (PreToolUse Edit/Write) to warn when two terminals are editing the same file.
 *
 * File: logs/file-touches.json
 * Shape: { [relativePath]: { nodeId, pid, timestamp, operation } }
 *
 * Writers: build-cycle.ts (PostToolUse Edit/Write)
 * Readers: conflict-guard.ts (PreToolUse Edit/Write), mycelium-awareness.ts
 *
 * Design: lightweight, file-locked, self-pruning. Entries older than 30 minutes
 * are pruned on every write. File is small (typically <50 entries).
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const TOUCHES_PATH = path.join(ALIENKIND_DIR, 'logs', 'file-touches.json');
const LOCK_PATH = TOUCHES_PATH + '.lock';
const STALE_MS = 30 * 60 * 1000; // 30 minutes

interface TouchEntry {
  nodeId: string;
  pid: number;
  timestamp: number;
  operation: 'edit' | 'write' | 'read';
}

interface ConflictInfo {
  filePath: string;
  otherNodeId: string;
  otherPid: number;
  operation: string;
  ageMs: number;
}

/**
 * Acquire exclusive lock (same pattern as mycelium.ts).
 */
function acquireLock(maxWaitMs: number = 1000): number | null {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // Check for stale lock
        try {
          const holderPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
          if (holderPid && !isPidAlive(holderPid)) {
            try { fs.unlinkSync(LOCK_PATH); } catch {}
            continue;
          }
        } catch { continue; }
        const end = Date.now() + 5;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseLock(fd: number | null): void {
  try {
    if (fd !== null) fs.closeSync(fd);
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

function readTouches(): Record<string, TouchEntry> {
  try {
    if (!fs.existsSync(TOUCHES_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOUCHES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeTouches(data: Record<string, TouchEntry>): void {
  const logDir = path.dirname(TOUCHES_PATH);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const tmpFile = `${TOUCHES_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, TOUCHES_PATH);
}

/**
 * Record that a terminal touched a file.
 */
function recordTouch(nodeId: string, filePath: string, operation: 'edit' | 'write' | 'read', pid?: number): void {
  const lockFd = acquireLock();
  try {
    const touches = readTouches();
    const now = Date.now();

    // Prune stale entries
    for (const [fp, entry] of Object.entries(touches)) {
      if (now - entry.timestamp > STALE_MS) {
        delete touches[fp];
      }
    }

    // Normalize path to relative
    let relPath = filePath;
    if (filePath.startsWith(ALIENKIND_DIR + '/')) {
      relPath = filePath.slice(ALIENKIND_DIR.length + 1);
    }

    touches[relPath] = {
      nodeId,
      pid: pid || process.pid,
      timestamp: now,
      operation,
    };

    writeTouches(touches);
  } catch {
    // Never block caller
  } finally {
    releaseLock(lockFd);
  }
}

/**
 * Check if another terminal recently touched this file.
 * Returns conflict info if found, null if safe.
 */
function checkConflict(nodeId: string, filePath: string): ConflictInfo | null {
  try {
    const touches = readTouches();
    const now = Date.now();

    // Normalize path
    let relPath = filePath;
    if (filePath.startsWith(ALIENKIND_DIR + '/')) {
      relPath = filePath.slice(ALIENKIND_DIR.length + 1);
    }

    const entry = touches[relPath];
    if (!entry) return null;

    // Same terminal — no conflict
    if (entry.nodeId === nodeId) return null;

    // Stale — no conflict
    const ageMs = now - entry.timestamp;
    if (ageMs > STALE_MS) return null;

    // Check if the other terminal's PID is still alive
    if (!isPidAlive(entry.pid)) return null;

    return {
      filePath: relPath,
      otherNodeId: entry.nodeId,
      otherPid: entry.pid,
      operation: entry.operation,
      ageMs,
    };
  } catch {
    return null;
  }
}

/**
 * Get all active touches for a given terminal (for awareness display).
 */
function getTouchesForNode(nodeId: string): Array<{ file: string; operation: string; ageMs: number }> {
  try {
    const touches = readTouches();
    const now = Date.now();
    const result: Array<{ file: string; operation: string; ageMs: number }> = [];

    for (const [fp, entry] of Object.entries(touches)) {
      if (entry.nodeId !== nodeId) continue;
      const ageMs = now - entry.timestamp;
      if (ageMs > STALE_MS) continue;
      result.push({ file: fp, operation: entry.operation, ageMs });
    }

    return result.sort((a, b) => a.ageMs - b.ageMs);
  } catch {
    return [];
  }
}

module.exports = { recordTouch, checkConflict, getTouchesForNode, readTouches, TOUCHES_PATH };
