// @alienkind-core
/**
 * substrate.ts — Local JSON cache layer for zero-compute data sharing.
 *
 * Extends the mycelium pattern: nightly/daemon write JSON files,
 * heartbeat/listeners read them as fallback or replacement for Supabase queries.
 *
 * Not to be confused with substrate-policy.ts (which routes model selection).
 * This file is persistent on-disk cache; that file is runtime routing logic.
 *
 * Writers: nightly jobs (calibration, patterns, social, skill metrics, content),
 *          daemon (health), content pipeline (pipeline status)
 * Readers: heartbeat (Supabase fallback), listeners (calibration awareness),
 *          lib/awareness-context (calendar already handled upstream)
 *
 * All writes are atomic (.tmp → rename). All reads are non-fatal (return null
 * on failure). Staleness thresholds prevent stale data from silently replacing
 * live queries.
 */

const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const SUBSTRATE_DIR = path.join(ALIENKIND_DIR, 'logs', 'substrate');

try {
  fs.mkdirSync(SUBSTRATE_DIR, { recursive: true });
} catch {
  // best effort — directory may already exist or permissions may not allow
}

type SubstrateName =
  | 'calibration'
  | 'patterns'
  | 'socialGrowth'
  | 'skillMetrics'
  | 'contentPerformance'
  | 'pipelineStatus'
  | 'memories';

const PATHS: Record<SubstrateName, string> = {
  calibration: path.join(SUBSTRATE_DIR, 'calibration.json'),
  patterns: path.join(SUBSTRATE_DIR, 'patterns.json'),
  socialGrowth: path.join(SUBSTRATE_DIR, 'social-growth.json'),
  skillMetrics: path.join(SUBSTRATE_DIR, 'skill-metrics.json'),
  contentPerformance: path.join(SUBSTRATE_DIR, 'content-performance.json'),
  pipelineStatus: path.join(SUBSTRATE_DIR, 'pipeline-status.json'),
  memories: path.join(SUBSTRATE_DIR, 'memories.json'),
};

// Staleness thresholds (ms) — reads return null past these windows.
const STALENESS: Record<SubstrateName, number> = {
  calibration: 25 * 60 * 60 * 1000,        // 25h (nightly writes daily)
  patterns: 25 * 60 * 60 * 1000,            // 25h
  socialGrowth: 8 * 24 * 60 * 60 * 1000,    // 8d (weekly cadence)
  skillMetrics: 25 * 60 * 60 * 1000,        // 25h
  contentPerformance: 25 * 60 * 60 * 1000,  // 25h
  pipelineStatus: 2 * 60 * 60 * 1000,       // 2h (pipeline runs daily)
  memories: 25 * 60 * 60 * 1000,            // 25h
};

interface SubstratePayload {
  updatedAt: string;
  [key: string]: any;
}

/** Atomic write to substrate file. */
function writeSubstrate(name: SubstrateName, data: Record<string, any>): void {
  const filePath = PATHS[name];
  if (!filePath) return;
  const payload: SubstratePayload = { ...data, updatedAt: new Date().toISOString() };
  const tmpFile = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpFile, filePath);
  } catch {
    // best effort — never block the writer
  }
}

/** Read from substrate file. Returns null if missing, stale, or corrupt. */
function readSubstrate(name: SubstrateName): SubstratePayload | null {
  const filePath = PATHS[name];
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const maxAge = STALENESS[name];
    if (maxAge && data.updatedAt) {
      const age = Date.now() - new Date(data.updatedAt).getTime();
      if (age > maxAge) return null;
    }
    return data;
  } catch {
    return null;
  }
}

// --- Specific write helpers (called by nightly/daemon/pipeline) ---

function writeCalibration({ outcomes, experiences }: { outcomes?: any[]; experiences?: any[] }): void {
  writeSubstrate('calibration', { outcomes: outcomes || [], experiences: experiences || [] });
}

function writePatterns(patterns: any[]): void {
  writeSubstrate('patterns', { patterns: patterns || [] });
}

function writeSocialGrowth(social: any[]): void {
  writeSubstrate('socialGrowth', { social: social || [] });
}

function writeSkillMetrics(metrics: any[]): void {
  writeSubstrate('skillMetrics', { metrics: metrics || [] });
}

function writeContentPerformance(content: any[]): void {
  writeSubstrate('contentPerformance', { content: content || [] });
}

function writeMemories(memories: any[]): void {
  writeSubstrate('memories', { memories: memories || [] });
}

function writePipelineStatus(status: Record<string, any>): void {
  writeSubstrate('pipelineStatus', status);
}

// --- Specific read helpers (called by heartbeat/listeners) ---

function readCalibration(): SubstratePayload | null { return readSubstrate('calibration'); }
function readPatterns(): SubstratePayload | null { return readSubstrate('patterns'); }
function readSocialGrowth(): SubstratePayload | null { return readSubstrate('socialGrowth'); }
function readSkillMetrics(): SubstratePayload | null { return readSubstrate('skillMetrics'); }
function readContentPerformance(): SubstratePayload | null { return readSubstrate('contentPerformance'); }
function readPipelineStatus(): SubstratePayload | null { return readSubstrate('pipelineStatus'); }
function readMemories(): SubstratePayload | null { return readSubstrate('memories'); }

/**
 * Read daemon health (already written by daemon to logs/daemon-health.json).
 * This is a reader, not a writer — the daemon writes the file itself.
 */
function readDaemonHealth(): Record<string, any> | null {
  try {
    const filePath = path.join(ALIENKIND_DIR, 'logs', 'daemon-health.json');
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age > 5 * 60 * 1000) return null; // 5 min staleness
    return data;
  } catch {
    return null;
  }
}

module.exports = {
  writeSubstrate, readSubstrate,
  writeCalibration, readCalibration,
  writePatterns, readPatterns,
  writeSocialGrowth, readSocialGrowth,
  writeSkillMetrics, readSkillMetrics,
  writeContentPerformance, readContentPerformance,
  writePipelineStatus, readPipelineStatus,
  writeMemories, readMemories,
  readDaemonHealth,
  PATHS, STALENESS, SUBSTRATE_DIR,
};
