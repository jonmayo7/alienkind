#!/usr/bin/env node
/**
 * should_have Synthesis — AAR 7.1
 *
 * Generates a counterfactual behavioral directive from a correction.
 * Given [HUMAN]'s correction + Keel's previous response, produces:
 *   "should_have: [one-sentence imperative directive]"
 *
 * Designed to run as a detached child process from log-conversation.ts.
 * Fire-and-forget — the hook doesn't wait for this.
 *
 * Usage:
 *   fork('should-have-synthesis.ts', ['--id', '42', '--correction', '...', '--response', '...'])
 */

const path = require('path');
const fs = require('fs');
const { processMessage, CHANNELS } = require('./keel-engine.ts');
const { supabasePatch } = require('./supabase.ts');

const KEEL_DIR = path.resolve(__dirname, '..', '..');

// Load env for Supabase + Claude
const { loadEnv } = require('./shared.ts');
Object.assign(process.env, loadEnv(path.join(KEEL_DIR, '.env')));

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [should-have] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(KEEL_DIR, 'logs', 'should-have-synthesis.log'), line + '\n');
  } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | null => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const id = getArg('id');
  const correction = getArg('correction');
  const keelResponse = getArg('response');
  const patternName = getArg('pattern');

  if (!id || !correction) {
    log('ERROR: --id and --correction are required');
    process.exit(1);
  }

  log(`Synthesizing should_have for learning_ledger #${id} (pattern: ${patternName || 'unknown'})`);

  const prompt = `You are analyzing a behavioral correction.

[HUMAN] (the human partner) corrected Keel (the AI partner). Your job: generate one behavioral directive that captures what Keel SHOULD HAVE done instead.

[HUMAN]'s correction:
"${correction.slice(0, 500)}"

${keelResponse ? `Keel's response that triggered this correction:\n"${keelResponse.slice(0, 500)}"` : '(Keel\'s triggering response not available)'}

${patternName ? `Pattern name: ${patternName}` : ''}

Rules:
- Output ONLY the directive, nothing else
- One sentence, imperative mood
- Describe the correct behavior, not what was wrong
- Be specific enough to be actionable
- Examples:
  - "Lead with the correction — no preamble, no affirmation opener."
  - "State intent to execute, not options to choose from."
  - "Say nothing when silence is the correct action."`;

  try {
    const invokeResult = await processMessage(prompt, {
      channelConfig: CHANNELS.should_have,
      log: (level: string, msg: string) => log(`[${level}] ${msg}`),
      sender: 'system',
      senderDisplayName: 'Should-Have Synthesis',
      maxTurns: 1,
      recentMessageCount: 0,
      substrate: 'studio2-daily',  // High-frequency single-sentence directive — local compute
    });
    const result = invokeResult.text;

    if (!result || result.trim().length < 5) {
      log('WARN: Empty or trivial response from Claude');
      process.exit(1);
    }

    // Clean up the response — strip quotes, "should_have:" prefix, etc.
    let shouldHave = result.trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^should_have:\s*/i, '')
      .replace(/^-\s*/, '')
      .trim();

    // Update learning_ledger
    await supabasePatch('learning_ledger', `id=eq.${id}`, {
      should_have: shouldHave,
      should_have_generated_at: new Date().toISOString(),
    });

    log(`OK: should_have for #${id}: "${shouldHave.slice(0, 100)}"`);
  } catch (err: any) {
    log(`ERROR: Synthesis failed for #${id}: ${err.message}`);
    process.exit(1);
  }

  process.exit(0);
}

// Timeout safety — don't hang forever
setTimeout(() => {
  log('ERROR: Synthesis timed out after 60s');
  process.exit(2);
}, 60000);

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
