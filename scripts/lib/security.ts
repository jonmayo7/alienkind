// @alienkind-core
/**
 * Security — minimal helpers used by env loading and other low-level modules.
 *
 * Kept small and dependency-free so env.ts can depend on this without creating
 * circular imports. Heavier security primitives (injection detection, privacy
 * gate, kill switch) live in their own modules.
 */

const fs = require('fs');

/**
 * Normalize secret values read from .env.
 * - Strips surrounding whitespace
 * - Strips line-ending and zero-width characters that sometimes creep in when
 *   secrets are pasted from browsers or clipboards
 * Returns the cleaned value unchanged if it's already clean.
 */
function normalizeSecretInput(value: string): string {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\r\n\u2028\u2029\u00AD\u200B-\u200F\uFEFF]+/g, '')
    .trim();
}

/**
 * Harden file permissions on a sensitive file (best-effort).
 * Sets mode 0600 (owner read/write only). No-op on filesystems that don't
 * support chmod (e.g. some Windows setups). Never throws — permission
 * hardening is advisory here, not a blocking guarantee.
 */
function hardenFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Not all filesystems support chmod; ignore.
  }
}

/**
 * Install a process-wide unhandled rejection handler that logs to stderr
 * instead of letting Node crash silently. Idempotent — safe to call
 * multiple times.
 */
let _rejectionHandlerInstalled = false;
function installRejectionHandler(): void {
  if (_rejectionHandlerInstalled) return;
  _rejectionHandlerInstalled = true;
  process.on('unhandledRejection', (reason: any) => {
    try {
      const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
      process.stderr.write(`[security] unhandled rejection: ${msg}\n`);
    } catch {
      // Never let the handler itself crash the process.
    }
  });
}

module.exports = {
  normalizeSecretInput,
  hardenFilePermissions,
  installRejectionHandler,
};
