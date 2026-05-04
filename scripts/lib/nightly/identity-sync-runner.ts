#!/usr/bin/env npx tsx

/**
 * Identity Sync Runner — nightly daemon entry point.
 *
 * Assembles the identity-sync prompt + recent context from the data core
 * and sends it to the partner's substrate. The partner reads + writes its
 * own identity kernel files based on what it observed.
 *
 * Substrate-portable: works against Claude Code subscription, Anthropic API,
 * OpenAI / OpenRouter, or any local OpenAI-compatible endpoint. Same prompt,
 * different body.
 *
 * Schedule via cron / launchd / your preferred scheduler:
 *   0 3 * * *  cd /path/to/alienkind && npx tsx scripts/lib/nightly/identity-sync-runner.ts
 *
 * The setup wizard wires this for you when you run `npm run setup`.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROMPT_PATH = path.join(ROOT, 'scripts', 'lib', 'nightly', 'identity-sync-prompt.md');
const ENV_PATH = path.join(ROOT, '.env');
const LOG_DIR = path.join(ROOT, 'logs');

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function loadEnvIntoProcess(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

async function supabaseGet(envVars: Record<string, string>, query: string): Promise<any[]> {
  const url = envVars.SUPABASE_URL;
  const key = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.SUPABASE_SERVICE_KEY;
  if (!url || !key) return [];

  return new Promise((resolve) => {
    const target = new URL(`${url}/rest/v1/${query}`);
    const options = {
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
    };
    const req = https.request(target, options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function ensureLogDir(): void {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

async function main() {
  ensureLogDir();
  const env = loadEnv();
  loadEnvIntoProcess(env);

  const today = new Date().toISOString().slice(0, 10);
  const partnerName = env.PARTNER_NAME || 'your partner';

  // Load the prompt template
  let promptTemplate: string;
  try {
    promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch (err) {
    console.error(`identity-sync-runner: cannot read prompt template at ${PROMPT_PATH}`);
    process.exit(1);
  }

  // Extract just the prompt block from the template
  const promptMatch = promptTemplate.match(/```\s*\n([\s\S]*?)\n```/);
  if (!promptMatch) {
    console.error('identity-sync-runner: could not find prompt block in template (expected ```...```)');
    process.exit(1);
  }
  let prompt = promptMatch[1]
    .replace(/\$\{DATE\}/g, today)
    .replace(/\$\{PARTNER_NAME\}/g, partnerName);

  // Pull recent context from the data core
  const recentConvs = await supabaseGet(env, `conversations?order=created_at.desc&limit=50`);
  const recentLearnings = await supabaseGet(env, `learning_ledger?order=created_at.desc&limit=20`);

  prompt += `\n\n## Recent context (last 50 conversation turns)\n\n${JSON.stringify(recentConvs, null, 2).slice(0, 8000)}`;
  prompt += `\n\n## Recent corrections / reinforcements (last 20 ledger entries)\n\n${JSON.stringify(recentLearnings, null, 2).slice(0, 4000)}`;

  // Write the assembled prompt + a flag for the runner-of-choice to invoke
  const assembledPath = path.join(LOG_DIR, `identity-sync-prompt-${today}.md`);
  fs.writeFileSync(assembledPath, prompt, 'utf8');
  console.log(`identity-sync-runner: assembled prompt at ${assembledPath}`);

  // Pick the runner: prefer Claude Code subscription if available, else error
  // out with a clear message about what to do.
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const useClaudeCode = !!(env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN);

  if (useClaudeCode) {
    const { spawnSync } = require('child_process');
    console.log(`identity-sync-runner: invoking ${claudeBin} code with allow-tools Read,Write,Edit`);
    const result = spawnSync(claudeBin, ['code', '--allow-tools', 'Read,Write,Edit'], {
      cwd: ROOT,
      input: prompt,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 30 * 60 * 1000, // 30 min
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`identity-sync-runner: claude code exited with status ${result.status}`);
      process.exit(result.status || 1);
    }
    console.log('identity-sync-runner: complete');
  } else {
    console.error(`identity-sync-runner: no CLAUDE_CODE_OAUTH_TOKEN set in .env`);
    console.error(`The assembled prompt is at: ${assembledPath}`);
    console.error(`Pipe it to your substrate of choice (Anthropic API, OpenAI, OpenRouter, local).`);
    console.error(`See identity-sync-prompt.md for runner notes.`);
    process.exit(1);
  }
}

main().catch((err: any) => {
  console.error(`identity-sync-runner: ${err.message}`);
  process.exit(1);
});
