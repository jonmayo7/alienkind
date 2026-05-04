#!/usr/bin/env npx tsx

/**
 * Discord Channel Adapter — bridges Discord to your AlienKind partner.
 *
 * Substrate-agnostic via askPartner() — same as the Telegram adapter.
 * discord.js handles the Discord I/O.
 *
 * Auth: hardcoded user-ID whitelist via DISCORD_ALLOWED_USER_IDS.
 * Optional: scope to specific channel/server via DISCORD_ALLOWED_CHANNEL_IDS.
 *
 * Usage:
 *   npx tsx scripts/channels/discord.ts
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN          — from Discord Developer Portal
 *   DISCORD_ALLOWED_USER_IDS   — comma-separated user IDs allowed to talk
 *
 * Optional:
 *   DISCORD_ALLOWED_CHANNEL_IDS — restrict to specific channels
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

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.DISCORD_ALLOWED_USER_IDS || '')
  .split(',').map((s: string) => s.trim()).filter(Boolean);
const ALLOWED_CHANNEL_IDS = (process.env.DISCORD_ALLOWED_CHANNEL_IDS || '')
  .split(',').map((s: string) => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('[discord] DISCORD_BOT_TOKEN not set in .env');
  process.exit(1);
}
if (ALLOWED_USER_IDS.length === 0) {
  console.error('[discord] DISCORD_ALLOWED_USER_IDS not set — refusing to start');
  process.exit(1);
}

let Client: any, GatewayIntentBits: any;
try {
  ({ Client, GatewayIntentBits } = require('discord.js'));
} catch {
  console.error('[discord] discord.js not installed. Run: npm install discord.js');
  process.exit(1);
}

const { askPartner } = require(path.join(ROOT, 'scripts', 'lib', 'substrate.ts'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL'],
});

async function chunkAndReply(message: any, text: string): Promise<void> {
  let remaining = text;
  while (remaining.length > 1900) {
    await message.reply(remaining.slice(0, 1900));
    remaining = remaining.slice(1900);
  }
  if (remaining) await message.reply(remaining);
}

client.on('messageCreate', async (message: any) => {
  // Ignore bot messages including our own
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel.id;

  if (!ALLOWED_USER_IDS.includes(userId)) {
    console.log(`[discord] rejected message from unauthorized user ${userId}`);
    return;
  }
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(channelId)) {
    return; // silently ignore — channel not in allowlist
  }

  // Show typing
  if (message.channel.sendTyping) {
    try { await message.channel.sendTyping(); } catch {}
  }

  try {
    const reply = await askPartner(message.content);
    await chunkAndReply(message, reply);
  } catch (err: any) {
    console.error(`[discord] askPartner failed: ${err.message}`);
    await message.reply(`(partner error: ${err.message.slice(0, 200)})`);
  }
});

client.on('error', (err: any) => {
  console.error(`[discord] client error: ${err.message || err}`);
});

console.log(`[discord] starting — authorized user IDs: ${ALLOWED_USER_IDS.join(', ')}`);
client.login(BOT_TOKEN);
