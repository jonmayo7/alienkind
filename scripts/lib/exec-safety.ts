/**
 * Exec Safety — Shell injection prevention for Keel.
 *
 * Provides validation and escaping for values that flow into shell commands.
 * Three layers:
 *   1. escapeShellArg — single-quote wrapping with inner quote escape
 *   2. validateFilePath — rejects shell metacharacters, command substitution, traversal
 *   3. validateCommand — rejects command substitution in full command strings
 *
 * Usage:
 *   const { escapeShellArg, validateFilePath, validateCommand } = require('./exec-safety.ts');
 *
 *   // Escape a value for shell interpolation
 *   execSync(`ffmpeg -i ${escapeShellArg(filePath)} ...`);
 *
 *   // Validate a file path before shell use
 *   validateFilePath(inputPath); // throws if dangerous
 *
 *   // Check a full command string
 *   validateCommand(cmd); // throws if command substitution detected
 *
 * Inspired by OpenClaw's exec-safety.ts pattern.
 */

// Characters that trigger shell interpretation
const SHELL_META = /[|;&<>`$()\\!{}[\]\n\r\x00]/;

// Command substitution patterns
const CMD_SUBST = /\$\(|\$\{|`/;

// Null bytes (terminate strings in C, dangerous in all contexts)
const NULL_BYTE = /\x00/;

/**
 * Escape a value for safe use inside a shell command string.
 * Wraps in single quotes, escapes inner single quotes.
 */
function escapeShellArg(value: string): string {
  if (typeof value !== 'string') value = String(value);

  // Reject null bytes outright
  if (NULL_BYTE.test(value)) {
    throw new Error('Value contains null bytes');
  }

  // Safe chars don't need quoting
  if (/^[a-zA-Z0-9._\-/:=,+@]+$/.test(value) && value.length > 0) {
    return value;
  }

  // Single-quote wrapping: replace ' with '\''
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate a file path for shell safety.
 * Rejects command substitution, shell metacharacters, and traversal.
 * Does NOT check file existence — caller's responsibility.
 */
function validateFilePath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('File path must be a non-empty string');
  }

  if (NULL_BYTE.test(filePath)) {
    throw new Error('File path contains null bytes');
  }

  if (CMD_SUBST.test(filePath)) {
    throw new Error('File path contains command substitution');
  }

  // Reject shell metacharacters (but allow / - _ . spaces)
  if (/[|;&<>`$()\\!{}[\]\n\r]/.test(filePath)) {
    throw new Error('File path contains shell metacharacters');
  }

  // Reject path traversal via ..
  const segments = filePath.split('/');
  if (segments.some((s: string) => s === '..')) {
    throw new Error('File path contains traversal (..)');
  }

  return filePath;
}

/**
 * Validate a full command string for injection patterns.
 * Use on commands that include interpolated values.
 */
function validateCommand(cmd: string): string {
  if (typeof cmd !== 'string') {
    throw new Error('Command must be a string');
  }

  if (NULL_BYTE.test(cmd)) {
    throw new Error('Command contains null bytes');
  }

  // Reject unquoted command substitution
  // This catches $(...) and backticks outside of single quotes
  if (CMD_SUBST.test(cmd)) {
    // Allow $(...) inside single-quoted strings (they're literal there)
    // Simple heuristic: if the command substitution is inside single quotes, it's safe
    const stripped = cmd.replace(/'[^']*'/g, ''); // remove single-quoted regions
    if (CMD_SUBST.test(stripped)) {
      throw new Error('Command contains unquoted command substitution');
    }
  }

  return cmd;
}

module.exports = {
  escapeShellArg,
  validateFilePath,
  validateCommand,
};
