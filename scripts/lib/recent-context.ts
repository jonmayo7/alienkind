#!/usr/bin/env node

/**
 * Cross-channel conversation context — shared module.
 *
 * Queryable as a module (for DM prompt builders, heartbeat) or as a CLI script
 * (for ground.sh at SessionStart).
 *
 * Module usage:
 *   const { getRecentContext } = require('./lib/recent-context');
 *   const thread = getRecentContext({
 *     url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY,
 *     channels: ['terminal', 'telegram_dm', 'discord'], limit: 12,
 *   });
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TIMEZONE, CONTEXT: CONTEXT_DEFAULTS } = require('./constants.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

// Direct conversation channels — where the human and Keel talk directly
const DM_CHANNELS: string[] = ['terminal', 'telegram_dm', 'discord', 'discord_partner_collab', 'discord_group', 'telegram_comms_coord', 'telegram_alerts'];

const CHANNEL_TAGS: Record<string, string> = {
  terminal: 'term',
  telegram_dm: 'tg',
  discord: 'disc',
  discord_channel: 'disc-pub',
  discord_partner_collab: 'disc-pc',
  telegram_group: 'tg-grp',
  discord_group: 'disc-grp',
  telegram_alerts: 'tg-alerts',
  telegram_comms_coord: 'tg-coord',
};

// Use shared loadEnv (quote stripping + secret normalization + permission hardening)
const { loadEnv } = require('./shared.ts');

interface RecentContextOptions {
  url?: string;
  key?: string;
  channels?: string[];
  limit?: number;
  previewLength?: number;
}

/**
 * Query recent conversations and return a formatted thread string.
 */
function getRecentContext({ url, key, channels = DM_CHANNELS, limit = CONTEXT_DEFAULTS.terminalLimit, previewLength = CONTEXT_DEFAULTS.previewLength }: RecentContextOptions = {}): string {
  if (!url || !key) return '';

  try {
    const channelFilter = channels.length === 1
      ? `channel=eq.${channels[0]}`
      : `channel=in.(${channels.join(',')})`;

    const query = `${url}/rest/v1/conversations?${channelFilter}&order=created_at.desc&limit=${limit}&select=channel,sender,content,created_at`;

    // Pass headers via stdin (--config -) to avoid API key in process args
    const curlConfig = `header = "apikey: ${key}"\nheader = "Authorization: Bearer ${key}"`;
    const result = execFileSync('/usr/bin/curl', [
      '-s', '--config', '-', query,
    ], { timeout: 5000, input: curlConfig }).toString();

    const rows = JSON.parse(result);
    if (!rows || rows.length === 0) return '';

    // Reverse to chronological order
    rows.reverse();

    const showChannelTag = channels.length > 1;
    const thread = rows.map((r: any) => {
      const time = new Date(r.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIMEZONE
      });
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: TIMEZONE
      });
      const preview = r.content.length > previewLength
        ? r.content.slice(0, previewLength) + '...'
        : r.content;
      const clean = preview.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const tag = CHANNEL_TAGS[r.channel] || r.channel;

      if (showChannelTag) {
        return `  [${date} ${time}] [${tag}] ${r.sender}: ${clean}`;
      }
      return `  [${date} ${time}] ${r.sender}: ${clean}`;
    }).join('\n');

    const label = channels.length > 1
      ? 'Recent conversation thread (across all channels)'
      : `Recent conversation history (${channels[0]})`;

    return `\n--- ${label} ---\n${thread}\n--- end history ---\n`;
  } catch (e: any) {
    console.error(`[recent-context] Supabase query failed: ${e.message} — trying local fallback`);
    // Local fallback: read today's daily memory for conversation entries
    try {
      const now = new Date();
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
      const dailyFile = path.join(ALIENKIND_DIR, 'memory', 'daily', `${todayStr}.md`);
      if (fs.existsSync(dailyFile)) {
        const content = fs.readFileSync(dailyFile, 'utf8');
        // Extract DM/Discord conversation lines
        const convLines = content.split('\n')
          .filter((line: string) => /^\s*-\s*\*\*\[(DM|Discord)/.test(line))
          .slice(-limit);
        if (convLines.length > 0) {
          return `\n--- Recent conversation thread (from daily memory — Supabase unavailable) ---\n${convLines.join('\n')}\n--- end history ---\n`;
        }
      }
    } catch { /* local fallback also failed */ }
    return '';
  }
}

// --- CLI mode (called by ground.sh) ---
if (require.main === module) {
  const limit = parseInt(process.argv[2], 10) || 15;
  const env = loadEnv();
  const output = getRecentContext({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_KEY,
    channels: DM_CHANNELS,
    limit,
  });
  if (output) {
    // Strip the --- delimiters for grounding output (ground.sh adds its own formatting)
    const lines = output.trim().split('\n');
    // Print header and content lines (skip delimiter lines)
    const header = lines[0].replace(/^---\s*/, '').replace(/\s*---$/, '').trim();
    const content = lines.slice(1, -1).join('\n');
    console.log(header + ':');
    console.log(content);
  }
}

module.exports = { getRecentContext, DM_CHANNELS };
