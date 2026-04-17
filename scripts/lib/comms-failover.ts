// @alienkind-core
/**
 * Comms Failover — ensures the human can always be reached.
 *
 * Hierarchy:
 *   1. Primary:    Terminal (interactive session — requires the human at computer)
 *   2. Alternate:  Telegram (DM, Alerts, CommsCoord — mobile-friendly)
 *   3. Contingent: Discord DM (if Telegram is completely down)
 *
 * The primary channel (terminal) is inherently reliable — it's a local process.
 * This module handles failover between Alternate and Contingent when the human
 * is away from the computer and the Telegram listener is unable to deliver messages.
 *
 * Graceful degradation: when Telegram/Discord creds are not configured, calls
 * return false (for sends) or an unhealthy result (for health checks) instead
 * of throwing. The capability registry is also notified at module-load time
 * so getCapabilityStatus() can report which channels are available.
 *
 * Usage:
 *   const { escalateToDiscord, checkTelegramHealth, sendToOperator } = require('./lib/comms-failover.ts');
 *
 *   // Direct escalation when Telegram is known-broken:
 *   await escalateToDiscord('Telegram listener in restart loop. Auto-heal engaged.');
 *
 *   // Smart send — tries Telegram first, falls back to Discord DM:
 *   await sendToOperator('Important update', { log });
 *
 *   // Health check (used by daemon heartbeat):
 *   const healthy = await checkTelegramHealth();
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const DM_CHANNEL_CACHE = path.join(ALIENKIND_DIR, 'logs', 'discord-dm-channel.json');

// Register comms capabilities at module-load time so getCapabilityStatus()
// can report availability. Silent degrade on send remains unchanged — this
// just makes the capability-registry aware of missing creds.
try {
  const { loadEnv } = require('./shared.ts');
  const env = loadEnv();
  const { registerUnavailable } = require('./portable.ts');
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    registerUnavailable('telegram', {
      reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env',
      enableWith: 'Create a Telegram bot via @BotFather, then set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (your user ID) in .env',
      docs: 'https://core.telegram.org/bots/tutorial',
    });
  }
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_ALLOWED_USER_ID) {
    registerUnavailable('discord-dm', {
      reason: 'DISCORD_BOT_TOKEN or DISCORD_ALLOWED_USER_ID not set in .env',
      enableWith: 'Create a Discord application + bot at discord.com/developers, invite it to a server you share, then set DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_ID (your Discord user ID) in .env',
      docs: 'https://discord.com/developers/docs/intro',
    });
  }
} catch { /* portable.ts or shared.ts not installed — silent degrade still works */ }

interface FailoverOptions {
  log?: (level: string, msg: string) => void;
}

interface SendOptions extends FailoverOptions {
  skipTelegram?: boolean; // Force Discord DM (used when Telegram is known-broken)
}

function loadEnvValue(key: string): string {
  if (process.env[key]) return process.env[key];
  try {
    const envFile = fs.readFileSync(path.join(ALIENKIND_DIR, '.env'), 'utf8');
    const match = envFile.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  } catch { return ''; }
}

// --- Discord DM Channel ---
// Discord bots create DM channels via POST /users/@me/channels with recipient_id.
// The channel ID is stable per user pair, so we cache it.

async function getOrCreateDmChannel(log?: (level: string, msg: string) => void): Promise<string> {
  // Check cache first
  try {
    if (fs.existsSync(DM_CHANNEL_CACHE)) {
      const cached = JSON.parse(fs.readFileSync(DM_CHANNEL_CACHE, 'utf8'));
      if (cached.channelId && cached.recipientId === loadEnvValue('DISCORD_ALLOWED_USER_ID')) {
        return cached.channelId;
      }
    }
  } catch { /* cache miss */ }

  const botToken = loadEnvValue('DISCORD_BOT_TOKEN');
  const recipientId = loadEnvValue('DISCORD_ALLOWED_USER_ID');

  if (!botToken || !recipientId) {
    throw new Error('DISCORD_BOT_TOKEN or DISCORD_ALLOWED_USER_ID not set');
  }

  const body = JSON.stringify({ recipient_id: recipientId });

  const channelId = await new Promise<string>((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/users/@me/channels',
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.id) {
            resolve(parsed.id);
          } else {
            reject(new Error(`Discord DM channel creation failed: ${res.statusCode} ${parsed.message || data}`));
          }
        } catch {
          reject(new Error(`Discord DM channel: invalid response (${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord DM channel: timeout')); });
    req.write(body);
    req.end();
  });

  // Cache the channel ID
  try {
    fs.writeFileSync(DM_CHANNEL_CACHE, JSON.stringify({ channelId, recipientId, createdAt: new Date().toISOString() }));
    if (log) log('INFO', `[comms-failover] Discord DM channel cached: ${channelId}`);
  } catch { /* non-fatal */ }

  return channelId;
}

// --- Send to Discord DM ---

async function sendDiscordDm(text: string, log?: (level: string, msg: string) => void): Promise<boolean> {
  const botToken = loadEnvValue('DISCORD_BOT_TOKEN');
  if (!botToken) {
    if (log) log('WARN', '[comms-failover] No DISCORD_BOT_TOKEN — cannot send Discord DM');
    return false;
  }

  try {
    const channelId = await getOrCreateDmChannel(log);
    const body = JSON.stringify({ content: text });

    await new Promise<void>((resolve, reject) => {
      const req = https.request({
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Discord DM send failed: ${res.statusCode} ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord DM send: timeout')); });
      req.write(body);
      req.end();
    });

    if (log) log('INFO', `[comms-failover] Discord DM sent (${text.length} chars)`);
    return true;
  } catch (err: any) {
    if (log) log('WARN', `[comms-failover] Discord DM failed: ${err.message}`);
    return false;
  }
}

// --- Send to Telegram ---

async function sendTelegram(text: string, log?: (level: string, msg: string) => void): Promise<boolean> {
  const botToken = loadEnvValue('TELEGRAM_BOT_TOKEN');
  const chatId = loadEnvValue('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) return false;

  try {
    const body = JSON.stringify({ chat_id: parseInt(chatId, 10), text });
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve();
            else reject(new Error(`Telegram API: ${parsed.description}`));
          } catch { reject(new Error('Telegram API: invalid response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram API: timeout')); });
      req.write(body);
      req.end();
    });
    return true;
  } catch (err: any) {
    if (log) log('WARN', `[comms-failover] Telegram send failed: ${err.message}`);
    return false;
  }
}

// --- Health Check ---

async function checkTelegramHealth(log?: (level: string, msg: string) => void): Promise<boolean> {
  const botToken = loadEnvValue('TELEGRAM_BOT_TOKEN');
  if (!botToken) return false;

  const singleCheck = (): Promise<boolean> => new Promise((resolve) => {
    const url = new URL(`https://api.telegram.org/bot${botToken}/getMe`);
    const req = https.request(url, { method: 'GET', timeout: 5000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).ok === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });

  try {
    let result = await singleCheck();
    // Retry once after 2s if first check fails — eliminates transient API blips
    if (!result) {
      if (log) log('INFO', '[comms-failover] Telegram health check failed, retrying in 2s...');
      await new Promise(r => setTimeout(r, 2000));
      result = await singleCheck();
    }

    // Also check if the listener process is running
    if (result) {
      try {
        const lockPath = path.join(ALIENKIND_DIR, 'logs', 'telegram-bot.lock');
        if (fs.existsSync(lockPath)) {
          const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (lockData.pid) {
            try {
              process.kill(lockData.pid, 0); // Signal 0 = check if process exists
              return true;
            } catch {
              if (log) log('WARN', '[comms-failover] Telegram API healthy but listener process not running');
              return false;
            }
          }
        }
      } catch { /* non-fatal — API health is sufficient */ }
    }

    return result;
  } catch {
    return false;
  }
}

// --- Escalate to Discord DM ---
// Used when Telegram is known-broken and auto-heal has been attempted.

async function escalateToDiscord(message: string, opts: FailoverOptions = {}): Promise<boolean> {
  const { log } = opts;
  const prefix = '[COMMS FAILOVER] ';
  return sendDiscordDm(prefix + message, log);
}

// --- Smart Send: tries Telegram, falls back to Discord DM ---

async function sendToOperator(message: string, opts: SendOptions = {}): Promise<{ channel: string; success: boolean }> {
  const { log, skipTelegram } = opts;

  // Try Telegram first (unless explicitly skipped)
  if (!skipTelegram) {
    const tgOk = await sendTelegram(message, log);
    if (tgOk) return { channel: 'telegram', success: true };
    if (log) log('WARN', '[comms-failover] Telegram failed — falling back to Discord DM');
  }

  // Fall back to Discord DM
  const discordOk = await sendDiscordDm(message, log);
  if (discordOk) return { channel: 'discord_dm', success: true };

  if (log) log('WARN', '[comms-failover] All comms channels failed');
  return { channel: 'none', success: false };
}

module.exports = {
  escalateToDiscord,
  sendToOperator,
  sendDiscordDm,
  checkTelegramHealth,
  getOrCreateDmChannel,
};
