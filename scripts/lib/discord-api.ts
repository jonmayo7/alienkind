/**
 * Discord API utilities — cross-channel posting + terminal claim coordination.
 *
 * Enables any consumer (terminal, Telegram, daemon) to:
 *   - Send messages to Discord channels via REST API
 *   - Claim a channel for terminal-driven conversation (listener defers)
 *   - Release claims when done
 *
 * Data flows:
 *   Writers: terminal (claimChannel/releaseChannel), sendMessage callers
 *   Readers: discord-listener.js (isChannelClaimed — defers if claimed)
 *   State file: logs/terminal-channel-claims.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { recordThread } = require('./external-threads.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CLAIMS_FILE = path.join(ALIENKIND_DIR, 'logs', 'terminal-channel-claims.json');
const DEFAULT_CLAIM_MS = 2 * 60 * 60 * 1000; // 2 hours

// Known channel ID → name map for routing audit trail.
// Populated lazily from .env on first sendMessage call.
let KNOWN_CHANNELS: Record<string, string> | null = null;

function getKnownChannels(): Record<string, string> {
  if (KNOWN_CHANNELS) return KNOWN_CHANNELS;
  KNOWN_CHANNELS = {};
  // Read from .env file directly (same source of truth as loadEnv)
  try {
    const envPath = path.join(ALIENKIND_DIR, '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const channelEnvMap: Record<string, string> = {
      'DISCORD_CHANNEL_ID': '[CHANNEL_NAME]',
      'DISCORD_PARTNER_COLLAB_CHANNEL_ID': '[CHANNEL_NAME]',
      'DISCORD_GROUP_CHANNEL_ID': '[CHANNEL_NAME]',
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (channelEnvMap[key]) {
        KNOWN_CHANNELS![val] = channelEnvMap[key];
      }
    }
  } catch { /* silent — audit is best-effort */ }
  return KNOWN_CHANNELS;
}

/** Resolve a channel ID to its human-readable name, or 'UNKNOWN' if not in registry. */
function resolveChannelName(channelId: string): string {
  const known = getKnownChannels();
  return known[channelId] || 'UNKNOWN';
}

interface ChannelClaim {
  claimedAt: string;
  expiresAt: string;
  reason: string;
}

interface ClaimStatus {
  claimed: boolean;
  reason?: string;
  expiresAt?: string;
}

interface SendMessageOptions {
  botToken?: string;
  allowUnknownChannel?: boolean;
}

interface ClaimOptions {
  durationMs?: number;
  reason?: string;
}

interface FetchOptions {
  limit?: number;
  botToken?: string;
}

/**
 * Send a message to a Discord channel via REST API.
 * Works from any context (terminal, daemon, Telegram) — same bot token.
 *
 * ROUTING SAFETY: Logs channel name on every send. Rejects unknown channel IDs
 * unless opts.allowUnknownChannel is true. AAR 2026-03-10: silent misrouting
 * sent a message to [CHANNEL_NAME] instead of [CHANNEL_NAME]. This guard prevents that class of bug.
 */
function sendMessage(channelId: string, content: string, opts: SendMessageOptions = {}): Promise<any> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));

  // Routing audit: resolve and log the target channel
  const channelName = resolveChannelName(channelId);
  const routingTag = `[discord-api] → #${channelName} (${channelId})`;

  if (channelName === 'UNKNOWN' && !opts.allowUnknownChannel) {
    return Promise.reject(new Error(
      `${routingTag} — BLOCKED: channel ID not in known registry. ` +
      `Pass allowUnknownChannel: true to override. Known channels: ${JSON.stringify(getKnownChannels())}`
    ));
  }

  // Log routing for audit trail (stderr so it doesn't interfere with stdout piping)
  process.stderr.write(`${routingTag} — sending ${content.length} chars\n`);

  const body = JSON.stringify({ content });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // Fire-and-forget thread tracking — never blocks message delivery
            try {
              recordThread({
                platform: 'discord' as const,
                threadId: parsed.id,
                channelId,
                channelName: channelName !== 'UNKNOWN' ? `#${channelName}` : undefined,
                role: 'initiator' as const,
                contentPreview: content.slice(0, 200),
              }).catch(() => {}); // swallow — tracking never blocks
            } catch { /* non-critical */ }
            resolve(parsed);
          } else {
            reject(new Error(`Discord API ${res.statusCode}: ${parsed.message || data}`));
          }
        } catch {
          reject(new Error(`Discord API: invalid response (${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Read current channel claims, pruning expired entries.
 */
function readClaims(): Record<string, ChannelClaim> {
  try {
    if (!fs.existsSync(CLAIMS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
    const now = Date.now();
    const active: Record<string, ChannelClaim> = {};
    for (const [channelId, claim] of Object.entries(raw) as [string, ChannelClaim][]) {
      if (new Date(claim.expiresAt).getTime() > now) {
        active[channelId] = claim;
      }
    }
    return active;
  } catch {
    return {};
  }
}

/**
 * Write claims to file (atomic).
 */
function writeClaims(claims: Record<string, ChannelClaim>): void {
  const tmpFile = CLAIMS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(claims, null, 2));
  fs.renameSync(tmpFile, CLAIMS_FILE);
}

/**
 * Claim a channel for terminal-driven conversation.
 * While claimed, the Discord listener defers responses in this channel.
 */
function claimChannel(channelId: string, opts: ClaimOptions = {}): ChannelClaim {
  const claims = readClaims();
  const durationMs = opts.durationMs || DEFAULT_CLAIM_MS;
  const claim: ChannelClaim = {
    claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
    reason: opts.reason || 'terminal-driven conversation',
  };
  claims[channelId] = claim;
  writeClaims(claims);
  return claim;
}

/**
 * Release a channel claim.
 */
function releaseChannel(channelId: string): void {
  const claims = readClaims();
  delete claims[channelId];
  writeClaims(claims);
}

/**
 * Check if a channel is currently claimed by terminal.
 * Used by discord-listener.js to decide whether to defer.
 */
function isChannelClaimed(channelId: string): ClaimStatus {
  const claims = readClaims();
  const claim = claims[channelId];
  if (claim) {
    return { claimed: true, reason: claim.reason, expiresAt: claim.expiresAt };
  }
  return { claimed: false };
}

/**
 * Edit an existing message in a Discord channel via REST API.
 */
function editMessage(channelId: string, messageId: string, content: string, opts: SendMessageOptions = {}): Promise<any> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));

  const body = JSON.stringify({ content });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages/${messageId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Discord API ${res.statusCode}: ${parsed.message || data}`));
          }
        } catch {
          reject(new Error(`Discord API: invalid response (${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Delete a message from a Discord channel via REST API.
 */
function deleteMessage(channelId: string, messageId: string, opts: SendMessageOptions = {}): Promise<void> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages/${messageId}`,
      method: 'DELETE',
      headers: {
        'Authorization': `Bot ${token}`,
      },
    }, (res: any) => {
      res.resume();
      if (res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 300)) {
        resolve();
      } else {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.end();
  });
}

/**
 * Add a reaction to a Discord message.
 * Discord API: PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me
 * For Unicode emoji (e.g. 🤙), pass the raw emoji — it's URI-encoded automatically.
 * For custom emoji, pass "name:id".
 * Returns void (204 No Content on success).
 */
function addReaction(channelId: string, messageId: string, emoji: string, opts: SendMessageOptions = {}): Promise<void> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));

  const encodedEmoji = encodeURIComponent(emoji);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Length': '0',
      },
    }, (res: any) => {
      res.resume();
      if (res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 300)) {
        resolve();
      } else {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.end();
  });
}

/**
 * Remove a reaction from a Discord message.
 * Discord API: DELETE /channels/{id}/messages/{id}/reactions/{emoji}/@me
 */
function removeReaction(channelId: string, messageId: string, emoji: string, opts: SendMessageOptions = {}): Promise<void> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));

  const encodedEmoji = encodeURIComponent(emoji);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      method: 'DELETE',
      headers: {
        'Authorization': `Bot ${token}`,
      },
    }, (res: any) => {
      res.resume();
      if (res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 300)) {
        resolve();
      } else {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.end();
  });
}

/**
 * Fetch recent messages from a Discord channel.
 */
function fetchMessages(channelId: string, opts: FetchOptions = {}): Promise<any[]> {
  const token = opts.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('DISCORD_BOT_TOKEN not set'));
  const limit = opts.limit || 10;

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages?limit=${limit}`,
      headers: { 'Authorization': `Bot ${token}` },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Discord API: invalid response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
  });
}

module.exports = {
  sendMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  fetchMessages,
  claimChannel,
  releaseChannel,
  isChannelClaimed,
  resolveChannelName,
  getKnownChannels,
};
