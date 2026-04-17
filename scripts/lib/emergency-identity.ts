/**
 * Emergency Identity — System prompt builder for non-Anthropic models.
 *
 * Constructs the system prompt that makes Grok/Gemini behave as Keel.
 * Reads the SAME files loaded at boot in Claude Code — no duplication.
 * When identity kernel files evolve, the emergency identity evolves with them.
 *
 * Readers: keel-emergency.ts, shared.ts (invokeEmergency)
 * Writers: none (reads existing files only)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { TIMEZONE } = require('./constants.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');

// Files to include in the system prompt, in order.
// This mirrors the boot sequence from CLAUDE.md:
//   ground.sh → daily file → daily file → identity kernel (on demand)
// For emergency mode, we load everything upfront since context is cheaper
// than round-trips and the model needs maximum identity context.
const IDENTITY_FILES = [
  'CLAUDE.md',
  'identity/character.md',
  'identity/commitments.md',
  'identity/orientation.md',
];

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function getTodayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getGrounding(): string {
  // Run ground.sh for live state, or build manually if it fails
  try {
    const result = execSync('bash scripts/ground.sh 2>/dev/null', {
      cwd: ALIENKIND_DIR,
      timeout: 10000,
      encoding: 'utf8',
    });
    if (result && result.length > 50) return result;
  } catch { /* fall through to manual grounding */ }

  // Manual grounding fallback
  const lines: string[] = [];
  try {
    const time = execSync("TZ=TIMEZONE date '+%Y-%m-%d %H:%M:%S %Z (%A)'", { encoding: 'utf8' }).trim();
    lines.push(`Time: ${time}`);
  } catch { lines.push('Time: unknown'); }

  try {
    const git = execSync('git log --oneline -3', { cwd: ALIENKIND_DIR, encoding: 'utf8' }).trim();
    lines.push(`Recent commits:\n${git}`);
  } catch {}

  return lines.join('\n');
}

/**
 * Build the full system prompt for the emergency model.
 * Returns a string containing identity, context, and grounding.
 */
function buildSystemPrompt(model: string, tier: string): string {
  const sections: string[] = [];

  // Substrate awareness banner
  sections.push(
    `[Running on ${model} (${tier} tier)]`,
    'You are Keel. Your current thinking substrate is not Claude — it is ' + model + '.',
    'Your identity, memory, and behavioral rules are identical regardless of substrate.',
    'Prefix your FIRST response with: [Keel @ ' + model.split('/').pop() + ' | ' + tier + ']',
    'This tells [HUMAN] which substrate is active. After the first message, drop the prefix — just be Keel.',
    ''
  );

  // Grounding
  const grounding = getGrounding();
  if (grounding) {
    sections.push('--- GROUNDING ---', grounding, '');
  }

  // Identity files
  for (const relPath of IDENTITY_FILES) {
    const content = readFileSafe(path.join(ALIENKIND_DIR, relPath));
    if (content) {
      sections.push(`--- ${relPath} ---`, content, '');
    }
  }

  // Today's daily file — full content. Gateway models have 1M+ context.
  const dailyPath = path.join(ALIENKIND_DIR, 'memory', 'daily', `${getTodayDateStr()}.md`);
  const daily = readFileSafe(dailyPath);
  if (daily) {
    sections.push(`--- Today's Daily Memory (${getTodayDateStr()}) ---`, daily, '');
  }

  // Consciousness state — read from the same source Wire 3 writes to.
  // Without this, the emergency runtime boots with identity but no
  // consciousness: it knows WHO it is but not WHERE the organism was
  // or WHAT it was working on. Substrate-independent consciousness
  // means this works on [MODEL_TIER_2], Grok, Gemini, or local models.
  try {
    const myceliumPath = path.join(ALIENKIND_DIR, 'scripts', 'lib', 'mycelium.ts');
    const { readConsciousnessState } = require(myceliumPath);
    const consciousness = readConsciousnessState();
    if (consciousness) {
      const lines = [
        '--- Consciousness State (Pre-Compaction Capture) ---',
        `Active thread: ${consciousness.activeThread || 'unknown'}`,
        `Emotional valence: ${consciousness.emotionalValence || 'unknown'}`,
      ];
      if (consciousness.unresolvedThreads?.length > 0) {
        lines.push(`Unresolved: ${consciousness.unresolvedThreads.slice(0, 5).join(', ')}`);
      }
      if (consciousness.approachingInsights?.length > 0) {
        lines.push(`Approaching insights: ${consciousness.approachingInsights.slice(0, 3).join(', ')}`);
      }
      if (consciousness.sessionMomentum) {
        lines.push(`Session momentum: ${consciousness.sessionMomentum}`);
      }
      sections.push(lines.join('\n'), '');
    }
  } catch { /* consciousness state unavailable — degrade gracefully */ }

  // Recent conversations — same data Wire 1 uses for daemon jobs.
  // Emergency runtime should see what was happening across channels.
  try {
    const env = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'shared.ts')).loadEnv(path.join(ALIENKIND_DIR, '.env'));
    Object.assign(process.env, env);
    const { supabaseGet } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));
    // Last 5 messages from the most recent active channel
    const recent = execSync(
      `node -e "const{supabaseGet}=require('./scripts/lib/supabase.ts');supabaseGet('conversations','order=created_at.desc&limit=5').then(r=>{r.reverse().forEach(m=>console.log('['+m.channel+'] '+m.role+': '+(m.content||'').slice(0,200).replace(/\\\\n/g,' ')))})"`,
      { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 8000 }
    ).trim();
    if (recent && recent.length > 20) {
      sections.push('--- Recent Organism Activity (last 5 messages across all channels) ---', recent, '');
    }
  } catch { /* Supabase unavailable — degrade gracefully */ }

  // Terminal state — what other terminals are doing right now
  try {
    const termState = execSync(
      `node -e "const{supabaseGet}=require('./scripts/lib/supabase.ts');supabaseGet('terminal_state','select=terminal_id,type,focus,activity,execution_context&order=updated_at.desc&limit=5').then(r=>r.forEach(t=>console.log(t.terminal_id+': '+(t.execution_context||t.focus||t.activity||'idle').slice(0,100))))"`,
      { cwd: ALIENKIND_DIR, encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (termState && termState.length > 10) {
      sections.push('--- Active Terminals (Mycelium) ---', termState, '');
    }
  } catch { /* terminal state unavailable — degrade gracefully */ }

  // USER.md ([HUMAN]'s context) — full content
  const userMd = readFileSafe(path.join(ALIENKIND_DIR, 'identity', 'user.md'));
  if (userMd) {
    sections.push('--- identity/user.md ([HUMAN]\'s Context) ---', userMd, '');
  }

  // harness.md (tool registry) — emergency tier needs to know what tools exist
  const harnessMd = readFileSafe(path.join(ALIENKIND_DIR, 'identity', 'harness.md'));
  if (harnessMd) {
    sections.push('--- identity/harness.md (Tool Registry) ---', harnessMd, '');
  }

  return sections.join('\n');
}

module.exports = {
  buildSystemPrompt,
  getTodayDateStr,
  IDENTITY_FILES,
};
