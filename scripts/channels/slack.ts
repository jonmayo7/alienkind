#!/usr/bin/env npx tsx

/**
 * Slack Channel Adapter — bridges Slack to your AlienKind partner.
 *
 * Substrate-agnostic via askPartner(). Uses Bolt (@slack/bolt) for Slack I/O.
 *
 * Auth: Slack-native — bot is invited to a workspace, only responds to
 * users in SLACK_ALLOWED_USER_IDS. Optional channel scoping.
 *
 * Required env:
 *   SLACK_BOT_TOKEN        — xoxb-... (Bot User OAuth Token)
 *   SLACK_APP_TOKEN        — xapp-... (App-Level Token, for Socket Mode)
 *   SLACK_ALLOWED_USER_IDS — comma-separated U-prefixed user IDs
 *
 * Optional:
 *   SLACK_ALLOWED_CHANNEL_IDS — comma-separated C-prefixed channel IDs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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

const env = loadEnv();
Object.assign(process.env, env);

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const ALLOWED_USER_IDS = (process.env.SLACK_ALLOWED_USER_IDS || '')
  .split(',').map((s: string) => s.trim()).filter(Boolean);
const ALLOWED_CHANNEL_IDS = (process.env.SLACK_ALLOWED_CHANNEL_IDS || '')
  .split(',').map((s: string) => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !APP_TOKEN) {
  console.error('[slack] SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set in .env');
  process.exit(1);
}
if (ALLOWED_USER_IDS.length === 0) {
  console.error('[slack] SLACK_ALLOWED_USER_IDS not set — refusing to start');
  process.exit(1);
}

let App: any;
try {
  ({ App } = require('@slack/bolt'));
} catch {
  console.error('[slack] @slack/bolt not installed. Run: npm install @slack/bolt');
  process.exit(1);
}

const { askPartner } = require(path.join(ROOT, 'scripts', 'lib', 'substrate.ts'));

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, say }: any) => {
  if (message.subtype) return; // bot messages, edits, etc.
  if (!ALLOWED_USER_IDS.includes(message.user)) {
    console.log(`[slack] rejected message from ${message.user}`);
    return;
  }
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channel)) return;

  try {
    const reply = await askPartner(message.text);
    // Slack messages can be long; chunk at ~3500 chars (block-text limit is 3000 per block)
    let remaining = reply;
    while (remaining.length > 3500) {
      await say(remaining.slice(0, 3500));
      remaining = remaining.slice(3500);
    }
    if (remaining) await say(remaining);
  } catch (err: any) {
    console.error(`[slack] askPartner failed: ${err.message}`);
    await say(`(partner error: ${err.message.slice(0, 200)})`);
  }
});

(async () => {
  await app.start();
  console.log(`[slack] starting — authorized user IDs: ${ALLOWED_USER_IDS.join(', ')}`);
})();
