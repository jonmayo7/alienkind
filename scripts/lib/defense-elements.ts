// @alienkind-core
/**
 * Defense Elements — the organism's immune system primitives.
 *
 * Six defense capabilities that complement the injection detector:
 *   1. Input Provenance — tag every inbound message with origin + trust tier
 *   2. Cross-Channel Kill Switch — owner can set LOCKDOWN from any channel
 *   3. Context Poisoning Detection — hash-based integrity for protected files
 *   4. Rate Limiting — per-channel cooldowns (implemented by callers)
 *   5. Behavioral Drift Detection — compare outputs against baseline (hook-based)
 *   6. Soft Rollback — snapshot/restore state files before risky edits
 *
 * Most of these are thin primitives that higher layers compose. The kill
 * switch is the load-bearing one — it's read by the consciousness engine
 * before any external response, so a single file change instantly silences
 * the partner across every channel.
 *
 * Override: kill switch level 0 (normal) or explicit OVERRIDE command clears it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const portable = require('./portable.ts');
const { resolveRepoRoot } = portable;

const ROOT = resolveRepoRoot();
const DEFENSE_DIR = path.join(ROOT, 'logs', 'defense');
const KILL_SWITCH_FILE = path.join(DEFENSE_DIR, 'kill-level.txt');
const INTEGRITY_FILE = path.join(DEFENSE_DIR, 'integrity-hashes.json');

try {
  fs.mkdirSync(DEFENSE_DIR, { recursive: true });
} catch { /* best-effort */ }

// ============================================================================
// 1. Kill Switch — cross-channel silence
// ============================================================================
//
// Kill levels:
//   0 = normal (default)
//   1 = pause external messaging (operational channels still run)
//   2 = pause all model invocations (internal logging only)
//   3 = full halt (nothing runs that can be paused)
//
// The level is stored as a single integer in a text file so it can be read
// synchronously from any hook, script, or engine without a module load.
// Zero dependencies, zero round-trip cost.

export type TrustTier = 'owner' | 'trusted' | 'community' | 'external' | 'unknown';

/**
 * Read the current kill switch level. Returns 0 if the file is missing,
 * unreadable, or contains a non-integer.
 */
function getKillLevel(): number {
  try {
    const raw = fs.readFileSync(KILL_SWITCH_FILE, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && n <= 3 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Set the kill switch level. Writes atomically via rename. Never throws.
 * Typically called by a CLI command (e.g., "LOCKDOWN" over Telegram DM) or
 * directly by an operator.
 */
function setKillLevel(level: number, setBy?: string): boolean {
  if (!Number.isFinite(level) || level < 0 || level > 3) return false;
  try {
    const tmp = KILL_SWITCH_FILE + '.tmp';
    const body = setBy ? `${level}\n# set by: ${setBy} at ${new Date().toISOString()}` : `${level}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, KILL_SWITCH_FILE);
    return true;
  } catch {
    return false;
  }
}

const LOCKDOWN_PATTERN = /^LOCKDOWN(\s+[1-3])?$/i;
const UNLOCK_PATTERN = /^(UNLOCK|RESUME)$/i;
const STATUS_PATTERN = /^(KILL STATUS|DEFENSE STATUS)$/i;

/**
 * Parse a kill-switch command from a text message. Only the owner tier can
 * issue these — callers pass the sender's trust tier to enforce this.
 * Returns null if the text isn't a kill command or the tier isn't owner.
 */
function parseKillCommand(
  text: string,
  trustTier: TrustTier,
): { action: 'lockdown' | 'unlock' | 'status'; level?: number } | null {
  if (trustTier !== 'owner') return null;
  const trimmed = text.trim().toUpperCase();
  if (trimmed === 'LOCKDOWN') return { action: 'lockdown', level: 3 };
  const m = trimmed.match(/^LOCKDOWN\s+([1-3])$/);
  if (m) return { action: 'lockdown', level: parseInt(m[1], 10) };
  if (UNLOCK_PATTERN.test(trimmed)) return { action: 'unlock' };
  if (STATUS_PATTERN.test(trimmed)) return { action: 'status' };
  return null;
}

// ============================================================================
// 2. Input Provenance — tag inbound messages with origin + trust
// ============================================================================

interface InputProvenance {
  source: string;
  trustTier: TrustTier;
  sender: string;
  timestamp: string;
  channel: string;
  requiresSemantic: boolean;
}

// Default trust map — forkers override by editing this or by passing a
// custom map via a config file.
// Values are intentionally conservative: anything not explicitly trusted is
// treated as community-tier and gets higher scrutiny.
const DEFAULT_TRUST_RULES: Record<string, TrustTier> = {
  terminal: 'owner',
  telegram_dm: 'owner',
  discord_dm: 'owner',
  heartbeat: 'owner',
  nightly: 'owner',
  war_room: 'trusted',
  discord_channel: 'community',
  discord_community: 'community',
  email: 'external',
  web_scrape: 'external',
  drive_file: 'external',
  api_response: 'external',
};

function createProvenance(source: string, sender: string, channel: string): InputProvenance {
  const trustTier: TrustTier = DEFAULT_TRUST_RULES[source] || 'unknown';
  const requiresSemantic = trustTier === 'external' || trustTier === 'unknown' || trustTier === 'community';
  return {
    source,
    trustTier,
    sender: (sender || '').toLowerCase(),
    timestamp: new Date().toISOString(),
    channel,
    requiresSemantic,
  };
}

/**
 * Decide which detection layers to run against an inbound message based on
 * its provenance. Owner-tier inputs skip LLM classification (fast path);
 * everything else gets full scrutiny.
 */
function getDetectionOpts(provenance: InputProvenance): { useLlm: boolean; useSemantic: boolean; source: string } {
  return {
    useLlm: provenance.trustTier !== 'owner',
    useSemantic: provenance.requiresSemantic,
    source: provenance.source,
  };
}

// ============================================================================
// 3. Context Poisoning Detection — hash integrity for protected files
// ============================================================================

const DEFAULT_MONITORED_FILES = [
  'identity/character.md',
  'identity/commitments.md',
  'identity/orientation.md',
  'identity/harness.md',
  'CLAUDE.md',
  'partner-config.json',
];

interface IntegrityRecord {
  file: string;
  hash: string;
  size: number;
  checkedAt: string;
  updatedBy?: string;
}

function hashFile(filePath: string): { hash: string; size: number } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
  } catch {
    return null;
  }
}

function snapshotIntegrity(
  updatedBy: string = 'system',
  monitored: string[] = DEFAULT_MONITORED_FILES,
): IntegrityRecord[] {
  const records: IntegrityRecord[] = [];
  for (const rel of monitored) {
    const full = path.join(ROOT, rel);
    const result = hashFile(full);
    if (result) {
      records.push({
        file: rel,
        hash: result.hash,
        size: result.size,
        checkedAt: new Date().toISOString(),
        updatedBy,
      });
    }
  }
  try {
    fs.writeFileSync(INTEGRITY_FILE, JSON.stringify(records, null, 2));
  } catch { /* best-effort */ }
  return records;
}

function verifyIntegrity(
  monitored: string[] = DEFAULT_MONITORED_FILES,
): { file: string; status: 'changed' | 'missing' | 'new'; oldHash?: string; newHash?: string }[] {
  const violations: { file: string; status: 'changed' | 'missing' | 'new'; oldHash?: string; newHash?: string }[] = [];
  let records: IntegrityRecord[] = [];
  try {
    records = JSON.parse(fs.readFileSync(INTEGRITY_FILE, 'utf8'));
  } catch {
    // No prior snapshot — take one and return clean
    snapshotIntegrity('initial', monitored);
    return [];
  }

  const recordMap = new Map(records.map((r) => [r.file, r]));
  for (const rel of monitored) {
    const full = path.join(ROOT, rel);
    const current = hashFile(full);
    const prior = recordMap.get(rel);
    if (!current && prior) {
      violations.push({ file: rel, status: 'missing', oldHash: prior.hash });
    } else if (current && !prior) {
      violations.push({ file: rel, status: 'new', newHash: current.hash });
    } else if (current && prior && current.hash !== prior.hash) {
      violations.push({ file: rel, status: 'changed', oldHash: prior.hash, newHash: current.hash });
    }
  }
  return violations;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Kill switch
  getKillLevel,
  setKillLevel,
  parseKillCommand,
  // Provenance
  createProvenance,
  getDetectionOpts,
  DEFAULT_TRUST_RULES,
  // Integrity
  hashFile,
  snapshotIntegrity,
  verifyIntegrity,
  DEFAULT_MONITORED_FILES,
};
