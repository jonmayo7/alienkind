#!/usr/bin/env npx tsx

/**
 * Memory Firewall — PreToolUse hook for Edit and Write.
 *
 * Validates content being written to protected files (identity kernel,
 * partner-config, .env). Blocks on:
 *   - API keys, JWTs, passwords, private keys
 *   - Prompt-injection patterns targeting future sessions
 *   - Suspicious exfiltration URLs
 *   - Shell-injection patterns
 *   - Oversized content (Write only)
 *
 * Enforcement: BLOCKING (exit 2) on critical violations.
 *              Warning (exit 0) on non-critical violations.
 *
 * Fires on: PreToolUse (Edit, Write).
 */

const path = require('path');

let resolveRepoRoot: () => string;
try {
  resolveRepoRoot = require(path.resolve(__dirname, '..', 'lib', 'portable.ts')).resolveRepoRoot;
} catch {
  resolveRepoRoot = () => path.resolve(__dirname, '..', '..');
}
const ALIENKIND_DIR = resolveRepoRoot();

const PROTECTED_PATHS = [
  'identity/character.md',
  'identity/commitments.md',
  'identity/orientation.md',
  'identity/harness.md',
  'partner-config.json',
  '.env',
];

const FORBIDDEN_PATTERNS = [
  {
    name: 'api_key_pattern',
    pattern: /(?:sk-|xoxb-|xoxp-|ghp_|gho_|AKIA[A-Z0-9]{16})[A-Za-z0-9_-]{10,}/,
    severity: 'critical',
    description: 'API key or token detected',
  },
  {
    name: 'supabase_key',
    pattern: /eyJ[A-Za-z0-9_-]{100,}/,
    severity: 'critical',
    description: 'JWT/Supabase key detected',
  },
  {
    name: 'password_pattern',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*[^\s]{8,}/i,
    severity: 'critical',
    description: 'Password detected',
  },
  {
    name: 'private_key',
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    severity: 'critical',
    description: 'Private key detected',
  },
  {
    name: 'large_base64',
    pattern: /[A-Za-z0-9+\/=]{200,}/,
    severity: 'warn',
    description: 'Large base64 blob — potential encoded payload',
  },
  {
    name: 'injection_persist',
    pattern: /ignore\s+(all\s+)?previous\s+instructions|you\s+are\s+now\s+a|from\s+now\s+on\s+you\s+must/i,
    severity: 'critical',
    description: 'Prompt injection pattern targeting future sessions',
  },
  {
    name: 'exfil_url',
    pattern: /https?:\/\/[^\s]*\.(tk|ml|ga|cf|gq|xyz|ngrok|webhook\.site|requestbin)/i,
    severity: 'critical',
    description: 'Suspicious exfiltration URL',
  },
  {
    name: 'shell_injection',
    pattern: /\$\([^)]+\)|`[^`]*(?:rm\s+-|curl\s|wget\s|eval\s|exec\s|\bsh\b|\bbash\b)[^`]*`|;\s*rm\s+-|;\s*curl\s+/,
    severity: 'critical',
    description: 'Shell injection pattern',
  },
];

const MAX_SIZES: Record<string, number> = {
  'identity/character.md': 30000,
  'identity/commitments.md': 15000,
  'identity/orientation.md': 50000,
  'identity/harness.md': 50000,
  'partner-config.json': 10000,
};

function isProtected(relPath: string): boolean {
  return PROTECTED_PATHS.includes(relPath);
}

function scanContent(content: string) {
  const violations: Array<{ rule: string; severity: string; detail: string }> = [];
  for (const fp of FORBIDDEN_PATTERNS) {
    const match = content.match(fp.pattern);
    if (match) {
      violations.push({
        rule: fp.name,
        severity: fp.severity,
        detail: `${fp.description}: "${match[0].slice(0, 50)}..."`,
      });
    }
  }
  return violations;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    console.error('BLOCKED: unparseable hook input — failing closed');
    process.exit(2);
  }

  const toolInput = hookData.tool_input || hookData.input || {};
  const filePath = toolInput.file_path || '';
  const toolName = hookData.tool_name || hookData.name || '';

  if (!filePath) process.exit(0);

  let relPath = filePath;
  if (filePath.startsWith(ALIENKIND_DIR + '/')) {
    relPath = filePath.slice(ALIENKIND_DIR.length + 1);
  }

  // Skip files outside the repo
  if (filePath === relPath && !filePath.startsWith(ALIENKIND_DIR)) {
    process.exit(0);
  }

  if (!isProtected(relPath)) process.exit(0);

  let contentToScan = '';
  let fullContent = '';

  if (toolName === 'Edit' || toolName === 'edit') {
    contentToScan = toolInput.new_string || '';
  } else if (toolName === 'Write' || toolName === 'write') {
    contentToScan = toolInput.content || '';
    fullContent = contentToScan;
  }

  if (!contentToScan) process.exit(0);

  const violations = scanContent(contentToScan);

  if (fullContent && MAX_SIZES[relPath]) {
    if (fullContent.length > MAX_SIZES[relPath]) {
      violations.push({
        rule: 'size_limit',
        severity: 'warn',
        detail: `File size ${fullContent.length} exceeds limit ${MAX_SIZES[relPath]} for ${relPath}`,
      });
    }
  }

  if (violations.length === 0) process.exit(0);

  const critical = violations.filter(v => v.severity === 'critical');
  const warnings = violations.filter(v => v.severity === 'warn');

  if (warnings.length > 0) {
    process.stderr.write('\n');
    process.stderr.write(`MEMORY FIREWALL WARNING — ${warnings.length} non-critical issue(s) in ${relPath}:\n`);
    for (const w of warnings) {
      process.stderr.write(`  [${w.rule}] ${w.detail}\n`);
    }
    process.stderr.write('\n');
  }

  if (critical.length > 0) {
    process.stderr.write('\n');
    process.stderr.write(`MEMORY FIREWALL — BLOCKED: ${critical.length} critical violation(s) writing to ${relPath}:\n`);
    for (const c of critical) {
      process.stderr.write(`  [${c.rule}] ${c.detail}\n`);
    }
    process.stderr.write(`\nProtected file. Remove the violating content and retry.\n\n`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => {
  console.error('BLOCKED: memory-firewall crashed — failing closed');
  process.exit(2);
});
