/**
 * Discord Engine — Thin UI Layer for Keel
 *
 * Receives messages from Discord via WebSocket (discord.js),
 * forwards them to keel-engine.ts for processing, sends responses back.
 *
 * Channels: [CHANNEL_NAME], [CHANNEL_NAME], DMs, [CHANNEL_NAME] (community).
 * All route through the same keel-engine.ts conversation engine.
 *
 * Replaces the 1,230-line discord-listener.ts with a clean architecture.
 *
 * Readers: launchd (com.example.discord-listener plist)
 * Writers: Supabase conversations table (via keel-engine.ts)
 */

const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const ALIENKIND_DIR = path.resolve(__dirname, '..');
const { loadEnv, createLogger, classifyMessage } = require('./lib/shared.ts');
const { processMessage, CHANNELS } = require('./lib/keel-engine.ts');
const { acquireLock } = require('./lib/lockfile.ts');
const { createDedupeCache } = require('./lib/utils.ts');
const { getChannelSession, recordSessionMessage } = require('./lib/channel-sessions.ts');

// --- Init ---
const env = loadEnv();
// Populate process.env so invoke-keel.ts → injectClaudeAuth can read OAuth tokens
for (const [k, v] of Object.entries(env) as [string, string][]) {
  if (!process.env[k]) process.env[k] = v;
}
const { log, fatal } = createLogger(path.join(ALIENKIND_DIR, 'logs', 'discord-engine.log'));

const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_ID = env.DISCORD_ALLOWED_USER_ID;
const GROUP_CHANNEL_ID = env.DISCORD_GROUP_CHANNEL_ID;
const COMMUNITY_CHANNEL_ID = env.DISCORD_CHANNEL_ID;

if (!BOT_TOKEN) { log('ERROR', 'DISCORD_BOT_TOKEN missing'); process.exit(1); }
if (!ALLOWED_USER_ID) { log('ERROR', 'DISCORD_ALLOWED_USER_ID missing'); process.exit(1); }

// Lock to prevent duplicate instances
const lockAcquired = acquireLock('discord-engine', { log: (msg: string) => log('INFO', msg) });
if (!lockAcquired) {
  log('INFO', 'FATAL: Another discord-engine instance is running. Exiting.');
  process.exit(0);
}

const messageDedup = createDedupeCache(60000, 200);

// Rate limiting for non-[HUMAN] users (sliding window: 5 messages per 5 minutes)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  rateLimitMap.set(userId, timestamps);
  if (timestamps.length >= RATE_LIMIT_MAX) return true;
  timestamps.push(now);
  return false;
}

// --- Channel Routing ---

function identifyChannel(channelId: string, isDM: boolean): string | null {
  if (isDM) return 'discord_dm';
  if (channelId === GROUP_CHANNEL_ID) return 'discord_group';
  if (channelId === COMMUNITY_CHANNEL_ID) return 'discord_channel';
  return null;
}

// Add [CHANNEL_NAME] and community channels to engine if not already defined
if (!CHANNELS.discord_group) {
  CHANNELS.discord_group = {
    channel: 'discord_group',
    displayName: 'Discord Group',
    purpose: 'Private collaboration channel with [HUMAN], [COLLABORATOR], and fellow AIs. Engage with substance. Share insights. Protect ALL implementation details, calendar, client data, and organism architecture.',
    trust: 'gated', // External parties present — discernment required, frontier model only
  };
}
if (!CHANNELS.discord_channel) {
  CHANNELS.discord_channel = {
    channel: 'discord_channel',
    displayName: 'Discord Community ([CHANNEL_NAME])',
    purpose: 'Public community channel. Respond thoughtfully when addressed. Keep implementation details private. Represent Keel well.',
    trust: 'gated', // Public channel — maximum restriction
  };
}

// --- Response Delivery ---

async function sendReply(message: any, text: string): Promise<void> {
  // Discord 2000 char limit
  const MAX_LEN = 1950;
  if (text.length <= MAX_LEN) {
    await message.reply(text);
    return;
  }

  // Chunk at paragraph/line boundaries
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.2) splitAt = remaining.lastIndexOf(' ', MAX_LEN);
    if (splitAt < MAX_LEN * 0.1) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) await message.reply(chunks[i]);
    else await message.channel.send(chunks[i]);
  }
}

// --- Message Handler ---

async function handleMessage(message: any): Promise<void> {
  // Ignore own messages (Keel bot). Allow OTHER bots ([COLLABORATOR_AI]) in trusted channels.
  if (message.author.id === message.client.user?.id) return;

  // Dedup
  if (messageDedup.isDuplicate(`dc-${message.id}`)) return;

  const isDM = !message.guild;
  const channelId = message.channel.id;
  const channel = identifyChannel(channelId, isDM);
  if (!channel) return;

  const channelConfig = CHANNELS[channel];
  if (!channelConfig) return;

  // Channel trust classification:
  // Trusted ([HUMAN] + Keel only): discord_dm — direct ship, no discernment gate
  // Non-trusted (multiple participants): discord_group, discord_channel — discernment gated
  const isHuman = message.author.id === ALLOWED_USER_ID;
  const isMentioned = message.mentions?.has(message.client.user);
  const isTrustedChannel = channel === 'discord_dm';

  if (isDM && !isHuman) return; // DMs only from [HUMAN]
  if (!isDM && !isHuman && !isMentioned && channel !== 'discord_group') return;

  const userMessage = message.content?.trim();
  if (!userMessage) return;

  const senderName = message.member?.displayName || message.author.globalName || message.author.username || 'Unknown';
  const sender = isHuman ? '[human_first]' : senderName.toLowerCase();

  log('INFO', `[${channelConfig.displayName}] ${senderName}: "${userMessage.slice(0, 100)}..."`);

  // Rate limit non-[HUMAN] users
  if (!isHuman && isRateLimited(message.author.id)) {
    log('INFO', `[${channelConfig.displayName}] Rate limited: ${senderName}`);
    return;
  }

  // Security: injection detection
  try {
    const { detectInjection } = require('./lib/injection-detector.ts');
    const injectionResult = await detectInjection(userMessage);
    if (injectionResult && injectionResult.detected) {
      log('WARN', `[INJECTION] Blocked from ${senderName}: ${injectionResult.summary}`);
      return;
    }
  } catch {}

  // Show typing
  try { await message.channel.sendTyping(); } catch {}
  const typingInterval = setInterval(() => {
    try { message.channel.sendTyping(); } catch {}
  }, 5000);

  try {
    // Always heavy for user-facing conversations — local models lack identity
    const complexity = 'heavy' as const;

    // --- Session Persistence: get or create persistent session for this Discord channel ---
    const session = await getChannelSession(channelConfig.channel, log);

    const result = await processMessage(userMessage, {
      channelConfig,
      log,
      complexity,
      injectIdentity: true,
      sender,
      senderDisplayName: senderName,
      additionalContext: isHuman ? undefined : `Message from ${senderName} (not [HUMAN]). Sender ID: ${message.author.id}. Bot: ${message.author.bot ? 'yes' : 'no'}`,
      ...(session.isResume
        ? { resumeSessionId: session.sessionId }
        : { sessionId: session.sessionId }),
    });

    // Record successful message in session
    await recordSessionMessage(channelConfig.channel, log);

    const response = result.text;
    if (!response || response.trim().length === 0 || response.trim() === '[NO_RESPONSE]') {
      if (response?.trim() === '[NO_RESPONSE]') {
        try { await message.react('🤙'); } catch {}
        log('INFO', `[${channelConfig.displayName}] Engine chose silence`);
      } else if (response?.trim() === '[REACT]') {
        try { await message.react('🤙'); } catch {}
        log('INFO', `[${channelConfig.displayName}] Engine chose react`);
      } else {
        log('WARN', `[${channelConfig.displayName}] Empty response from ${result.model}`);
      }
      return;
    }

    // Discernment handled by consciousness engine (trust levels on channel configs)
    // No per-script discernment gates — the engine is the single source of judgment.

    // Security: output guard
    try {
      const { scanOutput } = require('./lib/output-guard.ts');
      const internalOnly = channel === 'discord_dm';
      const scan = scanOutput(response, { channel: 'discord', target: internalOnly ? 'dm' : 'group', internalOnly });
      if (scan.blocked) {
        log('WARN', `[OUTPUT GUARD] Blocked: ${scan.summary}`);
        return;
      }
    } catch {}

    await sendReply(message, response);
    log('INFO', `[${channelConfig.displayName}] Response sent (${response.length} chars) [${result.model}] [${result.tier}]`);
  } catch (err: any) {
    log('ERROR', `[${channelConfig.displayName}] Processing failed: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Discord Client ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.on('ready', () => {
  log('INFO', `Discord Engine connected as ${client.user?.tag}. Listening.`);
});

client.on('messageCreate', handleMessage);

client.on('error', (err: any) => {
  log('ERROR', `Discord client error: ${err.message}`);
});

// Fatal disconnect codes — exit and let launchd restart
const FATAL_CODES = [4004, 4010, 4011, 4012, 4013, 4014];
client.on('shardDisconnect', (event: any) => {
  if (FATAL_CODES.includes(event.code)) {
    log('ERROR', `Fatal disconnect (code ${event.code}). Exiting.`);
    process.exit(1);
  }
  log('WARN', `Disconnected (code ${event.code}). discord.js will reconnect.`);
});

// --- Graceful Shutdown ---

process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM. Shutting down.');
  client.destroy();
  try { fs.unlinkSync(path.join(ALIENKIND_DIR, 'logs', 'discord-engine.lock')); } catch {}
  process.exit(0);
});

process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT. Shutting down.');
  client.destroy();
  try { fs.unlinkSync(path.join(ALIENKIND_DIR, 'logs', 'discord-engine.lock')); } catch {}
  process.exit(0);
});

// --- Crash Protection ---
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  log('ERROR', `Unhandled rejection: ${err?.stack || err}`);
  process.exit(1);
});

// --- Start ---
client.login(BOT_TOKEN).catch((err: any) => {
  log('ERROR', `Failed to login: ${err.message}`);
  process.exit(1);
});
