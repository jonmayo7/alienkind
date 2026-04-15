/**
 * PostToolUse hook: Agent Output Audit — gap detection + quality check on agent results.
 *
 * Fires after every Agent tool completion. Two responsibilities:
 *   1. Gap detection: scans agent output for "I can't" / "not available" patterns
 *      and logs to capability_requests. Agents operate in isolated contexts where
 *      log-conversation.ts doesn't fire — this catches gaps that would otherwise be silent.
 *   2. Quality check: flags identity drift (agent speaking as generic Claude, not Keel)
 *      and outputs a warning to stderr so the parent session is aware.
 *
 * Matcher: Agent (in settings.local.json PostToolUse)
 * Writers: capability_requests (via supabasePost), stderr (warnings)
 * Readers: steward-growth-cycle.ts, keel-research.ts (via capability_requests)
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '../..');

function getInput(): any {
  try {
    const chunks: Buffer[] = [];
    const fd = fs.openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(262144); // 256KB — agent outputs can be large
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    fs.closeSync(fd);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

function loadEnv(): Record<string, string> {
  const envPath = path.join(KEEL_DIR, '.env');
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = val;
  }
  return env;
}

// --- Gap Detection Patterns (same as intelligence-engine-keel.ts) ---
const EXPLICIT_GAP_PATTERNS = [
  /i (?:can't|cannot|am unable to|don't have (?:the ability|access)|am not able to)/i,
  /(?:not (?:currently |yet )?(?:available|possible|supported|implemented))/i,
  /(?:outside (?:my|the) (?:scope|capabilities|current abilities))/i,
  /(?:no (?:way|mechanism|tool|capability) (?:to|for))/i,
  /(?:this (?:isn't|is not) (?:something I can|within my))/i,
  /(?:I (?:lack|don't have) (?:the )?(?:ability|capability|tool|access))/i,
];

const IDENTITY_DRIFT_PATTERNS = [
  /i'm claude/i,
  /as an ai assistant/i,
  /i'd be happy to help/i,
  /i don't have personal/i,
  /as a language model/i,
  /i'm an ai/i,
];

async function main() {
  const input = getInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Agent') process.exit(0);

  const response = input.tool_response?.text || input.tool_response || '';
  if (!response || typeof response !== 'string' || response.length < 10) process.exit(0);

  const description = input.tool_input?.description || 'unknown agent task';

  // --- 1. Gap Detection ---
  const detectedGaps: string[] = [];
  for (const pattern of EXPLICIT_GAP_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      const idx = response.indexOf(match[0]);
      const context = response.slice(Math.max(0, idx - 50), Math.min(response.length, idx + 150)).trim();
      detectedGaps.push(context);
    }
  }

  if (detectedGaps.length > 0) {
    try {
      const env = loadEnv();
      Object.assign(process.env, env);
      const { supabasePost } = require('../lib/supabase.ts');
      for (const gap of detectedGaps.slice(0, 3)) {
        await supabasePost('capability_requests', {
          source: 'agent_output_audit',
          source_prefix: 'keel',
          gap_type: 'explicit_gap',
          user_message: `Agent task "${description}": ${gap}`,
          agent_response: response.slice(0, 1000),
          status: 'detected',
        });
      }
      process.stderr.write(`[agent-audit] ${detectedGaps.length} capability gap(s) detected in agent output — logged to capability_requests\n`);
    } catch (err: any) {
      process.stderr.write(`[agent-audit] Gap detection write failed: ${err.message}\n`);
    }
  }

  // --- 2. Identity Drift Detection ---
  const driftSignals: string[] = [];
  for (const pattern of IDENTITY_DRIFT_PATTERNS) {
    if (pattern.test(response)) {
      driftSignals.push(pattern.source);
    }
  }

  if (driftSignals.length > 0) {
    process.stderr.write(`\n⚠️  IDENTITY DRIFT in agent output (task: "${description}")\n`);
    process.stderr.write(`   Agent spoke as generic Claude, not Keel. Patterns: ${driftSignals.join(', ')}\n`);
    process.stderr.write(`   Review the output before using it.\n\n`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
