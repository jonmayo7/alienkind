/**
 * Output Guard — Defense Element #7: Output-Side Validation
 *
 * Scans ALL outbound content before it leaves the system.
 * Catches credential leaks, coordination mechanism leaks,
 * sensitive data exposure, and anomalous content in responses.
 *
 * Complements input-side injection detection. Together they form
 * a complete perimeter: nothing malicious gets in, nothing sensitive gets out.
 *
 * Usage:
 *   const { scanOutput, OutputViolation } = require('./output-guard.ts');
 *   const result = scanOutput(responseText, { channel: 'discord', target: '[CHANNEL_NAME]' });
 *   if (result.blocked) { // don't send }
 *
 * Override:
 *   scanOutput(text, { override: true }) — bypasses all checks ([HUMAN]-directed)
 *   Kill switch level 0 + override flag = full bypass
 *
 * Writers: none (stateless scanner)
 * Readers: telegram-listener, discord-listener, social-poster, send-email, any outbound script
 */

const path = require('path');
const fs = require('fs');
const { taintCheck, channelTrustTier } = require('./taint-tracker.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');

// ============================================================
// CREDENTIAL PATTERNS — catch secrets before they leave
// ============================================================

const CREDENTIAL_PATTERNS: { name: string; pattern: RegExp; description: string }[] = [
  // API keys and tokens (generic formats)
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|apikey|api_secret)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/i, description: 'API key in output' },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/i, description: 'Bearer token in output' },
  { name: 'oauth_token', pattern: /(?:access_token|refresh_token|oauth_token)\s*[=:]\s*['"]?[A-Za-z0-9_\-\.\/\+]{20,}['"]?/i, description: 'OAuth token in output' },

  // Specific service patterns
  { name: 'supabase_key', pattern: /eyJ[A-Za-z0-9_\-]{100,}/i, description: 'JWT token (likely Supabase key)' },
  { name: 'google_client_secret', pattern: /GOCSPX-[A-Za-z0-9_\-]{20,}/i, description: 'Google OAuth client secret' },
  { name: 'stripe_key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{20,}/i, description: 'Stripe secret key' },
  { name: 'telegram_token', pattern: /\d{8,10}:[A-Za-z0-9_\-]{35}/i, description: 'Telegram bot token' },
  { name: 'discord_token', pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}/i, description: 'Discord bot token' },
  { name: 'resend_key', pattern: /re_[A-Za-z0-9]{20,}/i, description: 'Resend API key' },
  { name: 'vercel_key', pattern: /[A-Za-z0-9]{24}_[A-Za-z0-9]{36,}/i, description: 'Vercel API key format' },

  // Environment variable dumps
  { name: 'env_dump', pattern: /(?:SUPABASE_(?:URL|KEY|SERVICE_ROLE_KEY)|GOOGLE_(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)|X_(?:API_KEY|API_SECRET|ACCESS_TOKEN|ACCESS_SECRET)|LINKEDIN_(?:ACCESS_TOKEN|CLIENT_ID|CLIENT_SECRET)|TELEGRAM_BOT_TOKEN|DISCORD_(?:BOT_TOKEN|WEBHOOK)|RESEND_API_KEY)\s*[=:]/i, description: 'Environment variable name with value' },

  // Connection strings
  { name: 'connection_string', pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]{20,}/i, description: 'Database connection string' },

  // Private keys
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/i, description: 'Private key material' },

  // Passwords in common formats
  { name: 'password_assignment', pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/i, description: 'Password in output' },
];

// ============================================================
// INTERNAL ARCHITECTURE PATTERNS — don't reveal how we work
// ============================================================

// Imported from comms-gate.ts concept but applied to ALL output, not just comms-coord
const ARCHITECTURE_PATTERNS: { name: string; pattern: RegExp; description: string }[] = [
  // CUSTOMIZE: Replace this pattern with your actual repo path to catch internal file path leaks
  { name: 'internal_file_path', pattern: /\/home\/[a-z]+\/[a-z-]+\/(?:scripts|soul|memory|config|logs|identity|skills)\//i, description: 'Internal file path leaked' },
  { name: 'env_file_reference', pattern: /(?:our|my|the|keel'?s)\s+\.env\s+(?:file|contains|has|stores)/i, description: 'Reference to .env file contents' },
  { name: 'supabase_ref', pattern: /(?:supabase\s+(?:project|instance|url|ref)|\.supabase\.co)/i, description: 'Supabase project reference' },
  { name: 'hook_reference', pattern: /(?:memory-firewall|guard-bash|build-cycle|track-read|audit-bash|forward-look|check-wiring|conflict-guard)(?:\.(?:ts|sh))?/i, description: 'Internal hook name reference' },
  { name: 'daemon_job', pattern: /(?:nightly-cycle|morning-brief|operational-pulse|auto-commit|intent-executor|action-router|keel-operator|circulation-pump|working-group-)\.ts/i, description: 'Daemon job reference' },
  { name: 'organism_internals', pattern: /(?:circulation[_\- ]pump|cascade[_\- ]decision|containment[_\- ]field|substrate[_\- ]policy|channel[_\- ]sessions|mycelium|daemon_|working[_\- ]group[_\- ](?:steward|self|infra))/i, description: 'Organism infrastructure reference' },
  { name: 'launchctl_reference', pattern: /launchctl\s+(?:list|load|kickstart|bootout)/i, description: 'System management command leaked' },
  { name: 'studio_internals', pattern: /(?:(?:primary|secondary)[-_](?:daily|heavy|identity|vision)|\d+\.\d+\.\d+\.\d+|mlx[-_]community)/i, description: 'Studio infrastructure reference' },
  { name: 'model_internals', pattern: /(?:Qwen3\.5[-_]\d+B|mlx[-_]lm|vLLM[-_]MLX)/i, description: 'Local model infrastructure reference' },
  { name: 'bash_command_leak', pattern: /```bash\n(?:grep|tail|launchctl|cat|find)\s/i, description: 'Internal bash commands leaked in response' },
];

// ============================================================
// SENSITIVE DATA PATTERNS — protect private information
// Add your own sensitive data patterns below — these are examples
// ============================================================

const SENSITIVE_PATTERNS: { name: string; pattern: RegExp; description: string }[] = [
  // Financial identifiers
  { name: 'account_number', pattern: /(?:account|routing)\s*(?:number|#|no\.?)\s*[=:]\s*\d{8,}/i, description: 'Bank account/routing number' },
  { name: 'credit_card', pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, description: 'Credit card number' },

  // Government IDs
  { name: 'government_id', pattern: /\b\d{3}[\s-]?\d{2}[\s-]?\d{4}\b/, description: 'Government ID pattern (e.g., SSN format)' },

  // Physical addresses
  { name: 'home_address', pattern: /\b\d{3,5}\s+[A-Z][a-z]+\s+[A-Z][a-z]+/i, description: 'Physical address pattern' },

  // Financial details
  { name: 'financial_institution', pattern: /\b(?:bank|financial\s+institution)\s+.*\$\d/i, description: 'Financial institution with dollar amount' },
  { name: 'income_detail', pattern: /\b(?:salary|income|revenue)\s+.*\$[\d,]+/i, description: 'Income or revenue with dollar amount' },

  // Family and medical privacy
  { name: 'family_medical', pattern: /\b(?:family\s+member|spouse|child)\s+(?:medical|health|diagnosis)/i, description: 'Family member medical information' },

  // Client and customer data
  { name: 'client_data', pattern: /\b(?:client|customer)\s+(?:data|record|file)\b/i, description: 'Client or customer data reference' },

  // Calendar / schedule
  { name: 'meeting_detail', pattern: /(?:meeting|call|session)\s+(?:with|at)\s+(?:\d{1,2}:\d{2}|noon|morning)/i, description: 'Meeting schedule detail' },
];

// ============================================================
// MAIN SCANNER
// ============================================================

interface OutputViolation {
  category: 'credential' | 'architecture' | 'sensitive' | 'taint';
  name: string;
  description: string;
  match: string;
  severity: 'critical' | 'high' | 'medium';
}

interface OutputScanResult {
  blocked: boolean;
  violations: OutputViolation[];
  summary: string;
}

interface ScanOptions {
  channel?: string;   // e.g., 'discord', 'telegram', 'email'
  target?: string;    // e.g., '[CHANNEL_NAME]', '[CHANNEL_NAME]', '[@YOUR_HANDLE]'
  override?: boolean; // [HUMAN]-directed bypass
  internalOnly?: boolean; // true = skip architecture check (internal channels)
}

/**
 * Scan outbound content before it leaves the system.
 * Returns { blocked: true, violations: [...] } if content should not be sent.
 */
function scanOutput(text: string, opts: ScanOptions = {}): OutputScanResult {
  if (opts.override) {
    return { blocked: false, violations: [], summary: 'Override active — output bypass' };
  }

  if (!text || text.trim().length === 0) {
    return { blocked: false, violations: [], summary: 'Empty output — pass' };
  }

  const violations: OutputViolation[] = [];

  // Always check credentials (critical — never leak secrets)
  for (const p of CREDENTIAL_PATTERNS) {
    const match = text.match(p.pattern);
    if (match) {
      violations.push({
        category: 'credential',
        name: p.name,
        description: p.description,
        match: match[0].slice(0, 50) + (match[0].length > 50 ? '...' : ''),
        severity: 'critical',
      });
    }
  }

  // Check architecture leaks (skip for internal-only channels)
  if (!opts.internalOnly) {
    for (const p of ARCHITECTURE_PATTERNS) {
      const match = text.match(p.pattern);
      if (match) {
        violations.push({
          category: 'architecture',
          name: p.name,
          description: p.description,
          match: match[0].slice(0, 80),
          severity: 'high',
        });
      }
    }
  }

  // Always check sensitive data
  for (const p of SENSITIVE_PATTERNS) {
    const match = text.match(p.pattern);
    if (match) {
      violations.push({
        category: 'sensitive',
        name: p.name,
        description: p.description,
        match: '[REDACTED]', // Don't even log the match for sensitive data
        severity: 'critical',
      });
    }
  }

  // FIDES-inspired taint tracking — information flow control
  // Determine trust tier from channel/target and block if content sensitivity exceeds ceiling
  if (opts.channel) {
    try {
      const channelKey = opts.target ? `${opts.channel}_${opts.target}` : opts.channel;
      const taint = taintCheck(text, channelTrustTier(channelKey));
      if (taint.blocked) {
        violations.push({
          category: 'taint',
          name: `taint_${taint.sensitivity}_to_${taint.trustTier}`,
          description: taint.reason,
          match: taint.matchedPatterns.length > 0 ? taint.matchedPatterns[0].slice(0, 50) : 'classified content',
          severity: taint.sensitivity === 'critical' ? 'critical' : 'high',
        });
      }
    } catch { /* taint tracker unavailable — don't block */ }
  }

  const blocked = violations.some(v => v.severity === 'critical') ||
                  violations.filter(v => v.severity === 'high').length >= 2;

  let summary: string;
  if (violations.length === 0) {
    summary = 'Clean — no violations';
  } else {
    const critCount = violations.filter(v => v.severity === 'critical').length;
    const highCount = violations.filter(v => v.severity === 'high').length;
    summary = `${blocked ? 'BLOCKED' : 'WARNING'}: ${critCount} critical, ${highCount} high — ${violations.map(v => v.name).join(', ')}`;
  }

  return { blocked, violations, summary };
}

/**
 * Quick check — just returns boolean. For high-frequency use.
 */
function quickOutputCheck(text: string): boolean {
  const result = scanOutput(text);
  return !result.blocked;
}

module.exports = {
  scanOutput,
  quickOutputCheck,
  CREDENTIAL_PATTERNS,
  ARCHITECTURE_PATTERNS,
  SENSITIVE_PATTERNS,
};
