#!/usr/bin/env npx tsx

/**
 * add-channel — install + configure + supervise a channel adapter.
 *
 * Usage:
 *   npx tsx scripts/tools/add-channel.ts            # interactive: pick from list
 *   npx tsx scripts/tools/add-channel.ts telegram   # add by name
 *
 * What it does:
 *   1. Installs the adapter's npm dependency (grammy, discord.js, etc.)
 *   2. Prompts for the channel-specific credentials
 *   3. Appends them to .env
 *   4. Wires pm2 (auto-installs if missing) for auto-restart on crash + boot
 *   5. Starts the adapter
 *
 * Channel adapters live at scripts/channels/<name>.ts and follow the contract
 * defined in docs/CHANNEL_CONTRACT.md.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

interface ChannelDef {
  name: string;
  label: string;
  npmPackage: string;
  envVars: Array<{ key: string; prompt: string; required: boolean; secret?: boolean }>;
  setupNotes?: string[];
}

const CHANNELS: Record<string, ChannelDef> = {
  telegram: {
    name: 'telegram',
    label: 'Telegram',
    npmPackage: 'grammy',
    envVars: [
      {
        key: 'TELEGRAM_BOT_TOKEN',
        prompt: 'Telegram Bot Token (from @BotFather)',
        required: true,
        secret: true,
      },
      {
        key: 'TELEGRAM_ALLOWED_CHAT_IDS',
        prompt: 'Allowed Telegram chat IDs (comma-separated — your chat ID at minimum)',
        required: true,
      },
    ],
    setupNotes: [
      'Open Telegram → search @BotFather → send /newbot → follow prompts → copy the token',
      'After bot is running: send /start to your bot → log into Telegram web → URL contains your chat ID',
      'Or run: curl "https://api.telegram.org/bot<TOKEN>/getUpdates" after sending a message to see chat.id',
    ],
  },
  discord: {
    name: 'discord',
    label: 'Discord',
    npmPackage: 'discord.js',
    envVars: [
      {
        key: 'DISCORD_BOT_TOKEN',
        prompt: 'Discord Bot Token (from Developer Portal → Bot tab)',
        required: true,
        secret: true,
      },
      {
        key: 'DISCORD_ALLOWED_USER_IDS',
        prompt: 'Allowed Discord user IDs (comma-separated)',
        required: true,
      },
      {
        key: 'DISCORD_ALLOWED_CHANNEL_IDS',
        prompt: 'Allowed Discord channel IDs (optional — comma-separated, blank = any)',
        required: false,
      },
    ],
    setupNotes: [
      'Go to https://discord.com/developers/applications → New Application',
      'Bot tab → "Reset Token" → copy token',
      'Bot tab → toggle ON "Message Content Intent"',
      'OAuth2 → URL Generator → scopes: "bot" + permissions: "Send Messages, Read Message History"',
      'Open the generated URL → invite bot to your server',
      'Right-click your username in Discord → "Copy User ID" (with Developer Mode enabled in settings)',
    ],
  },
  slack: {
    name: 'slack',
    label: 'Slack',
    npmPackage: '@slack/bolt',
    envVars: [
      {
        key: 'SLACK_BOT_TOKEN',
        prompt: 'Slack Bot User OAuth Token (xoxb-...)',
        required: true,
        secret: true,
      },
      {
        key: 'SLACK_APP_TOKEN',
        prompt: 'Slack App-Level Token (xapp-..., for Socket Mode)',
        required: true,
        secret: true,
      },
      {
        key: 'SLACK_ALLOWED_USER_IDS',
        prompt: 'Allowed Slack user IDs (U-prefixed, comma-separated)',
        required: true,
      },
      {
        key: 'SLACK_ALLOWED_CHANNEL_IDS',
        prompt: 'Allowed Slack channel IDs (C-prefixed, optional)',
        required: false,
      },
    ],
    setupNotes: [
      'Go to https://api.slack.com/apps → Create New App → "From scratch"',
      'Socket Mode → Enable + create App-Level Token (xapp-) with connections:write',
      'OAuth & Permissions → Bot Token Scopes: chat:write, im:history, im:write, channels:history (if you want public channels)',
      'Install to Workspace → copy the Bot User OAuth Token (xoxb-)',
      'Event Subscriptions → enable + Subscribe to bot events: message.im (and message.channels if needed)',
      "Click your Slack profile → 'Profile' → '...' → 'Copy member ID' to get your user ID",
    ],
  },
  webhook: {
    name: 'webhook',
    label: 'Webhook (HTTP endpoint for any external system)',
    npmPackage: '', // no external dep — uses node:http
    envVars: [
      {
        key: 'WEBHOOK_AUTH_TOKEN',
        prompt: 'Auth token (any random string — callers pass it as Bearer token)',
        required: true,
        secret: true,
      },
      {
        key: 'WEBHOOK_PORT',
        prompt: 'Port to listen on (default 8787)',
        required: false,
      },
      {
        key: 'WEBHOOK_HOST',
        prompt: 'Bind host (default 0.0.0.0; use 127.0.0.1 for localhost-only)',
        required: false,
      },
    ],
    setupNotes: [
      'Generate a random auth token: openssl rand -hex 32',
      'Endpoint: POST /partner with Authorization: Bearer <token>, body: {"message": "..."}',
      'Use cases: Zapier, custom mobile app, IFTTT, your own web frontend, anything that speaks HTTP',
    ],
  },
};

function ask(rl: any, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${C.cyan}❯${C.reset} ${question}: `, (answer: string) => resolve(answer.trim()));
  });
}

function info(msg: string) { console.log(`${C.cyan}[info]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`${C.green}[ok]${C.reset}   ${msg}`); }
function warn(msg: string) { console.log(`${C.yellow}[warn]${C.reset} ${msg}`); }
function fail(msg: string) { console.error(`${C.red}[fail]${C.reset} ${msg}`); }

function readEnv(): string {
  const envPath = path.join(ROOT, '.env');
  return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
}

function appendEnv(updates: Record<string, string>): void {
  const envPath = path.join(ROOT, '.env');
  let current = readEnv();
  if (current && !current.endsWith('\n')) current += '\n';

  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(current)) {
      current = current.replace(re, `${key}=${value}`);
    } else {
      current += `${key}=${value}\n`;
    }
  }
  fs.writeFileSync(envPath, current, 'utf8');
}

function ensurePm2(): boolean {
  const which = spawnSync('which', ['pm2']);
  if (which.status === 0) return true;

  info('pm2 not installed — installing globally...');
  const result = spawnSync('npm', ['install', '-g', 'pm2'], { stdio: 'inherit' });
  if (result.status === 0) {
    ok('pm2 installed');
    return true;
  }
  return false;
}

function installNpmDep(pkg: string): boolean {
  info(`Installing ${pkg}...`);
  const result = spawnSync('npm', ['install', pkg, '--silent'], { cwd: ROOT, stdio: 'inherit' });
  return result.status === 0;
}

async function configureChannel(rl: any, def: ChannelDef): Promise<Record<string, string> | null> {
  console.log(`\n  ${C.bold}Configuring ${def.label}${C.reset}\n`);

  if (def.setupNotes) {
    console.log(`  ${C.dim}Setup steps:${C.reset}`);
    def.setupNotes.forEach((n, i) => console.log(`  ${C.dim}${i + 1}. ${n}${C.reset}`));
    console.log('');
  }

  const updates: Record<string, string> = {};
  for (const v of def.envVars) {
    const value = await ask(rl, v.prompt + (v.required ? '' : ' (optional)'));
    if (v.required && !value) {
      fail(`${v.key} is required.`);
      return null;
    }
    if (value) updates[v.key] = value;
  }
  return updates;
}

async function main() {
  const args = process.argv.slice(2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    let channelName = args[0];

    if (!channelName) {
      console.log('\n  Available channels:');
      Object.values(CHANNELS).forEach((c, i) => {
        console.log(`    ${i + 1}. ${c.label} (${c.name})`);
      });
      const pick = await ask(rl, '\n  Pick a channel by number or name');
      const num = parseInt(pick);
      if (!isNaN(num) && num >= 1 && num <= Object.keys(CHANNELS).length) {
        channelName = Object.keys(CHANNELS)[num - 1];
      } else {
        channelName = pick.toLowerCase();
      }
    }

    const def = CHANNELS[channelName];
    if (!def) {
      fail(`Unknown channel: ${channelName}. Available: ${Object.keys(CHANNELS).join(', ')}`);
      process.exit(1);
    }

    const adapterPath = path.join(ROOT, 'scripts', 'channels', `${def.name}.ts`);
    if (!fs.existsSync(adapterPath)) {
      fail(`Adapter not found: ${adapterPath}`);
      process.exit(1);
    }

    // 1. Install npm dependency (skip if no dep — e.g., webhook uses node:http)
    if (def.npmPackage) {
      if (!installNpmDep(def.npmPackage)) {
        fail(`Failed to install ${def.npmPackage}`);
        process.exit(1);
      }
    }

    // 2. Configure (prompt for credentials)
    const updates = await configureChannel(rl, def);
    if (!updates) process.exit(1);

    // 3. Append to .env
    appendEnv(updates);
    ok(`Wrote ${Object.keys(updates).length} value(s) to .env`);

    // 4. pm2 setup
    if (!ensurePm2()) {
      warn('pm2 setup failed — adapter not auto-supervised. Start manually:');
      console.log(`    ${C.cyan}npx tsx scripts/channels/${def.name}.ts${C.reset}\n`);
      process.exit(0);
    }

    const pm2Name = `alienkind-${def.name}`;

    // Stop existing if any (idempotent re-run)
    spawnSync('pm2', ['delete', pm2Name], { stdio: 'ignore' });

    // Start under pm2
    info(`Starting ${def.label} adapter under pm2 as "${pm2Name}"...`);
    const startResult = spawnSync('pm2', [
      'start', `npx`, '--name', pm2Name, '--',
      'tsx', adapterPath,
    ], { cwd: ROOT, stdio: 'inherit' });

    if (startResult.status !== 0) {
      fail(`pm2 start failed`);
      process.exit(1);
    }

    // Save pm2 process list so it survives reboot
    spawnSync('pm2', ['save'], { stdio: 'ignore' });

    // Wire pm2 to start on system boot (one-time, idempotent — outputs a sudo cmd if not yet wired)
    const startupCheck = spawnSync('pm2', ['startup'], { encoding: 'utf8' });
    if (startupCheck.stdout && startupCheck.stdout.includes('sudo env')) {
      console.log('');
      warn('To make pm2 start on system boot, run the command pm2 just printed above (one-time).');
      console.log('');
    }

    ok(`${def.label} adapter is running.`);
    console.log(`\n  ${C.dim}Logs:    ${C.reset}pm2 logs ${pm2Name}`);
    console.log(`  ${C.dim}Restart: ${C.reset}pm2 restart ${pm2Name}`);
    console.log(`  ${C.dim}Stop:    ${C.reset}pm2 stop ${pm2Name}`);
    console.log(`  ${C.dim}Status:  ${C.reset}pm2 status\n`);
  } finally {
    rl.close();
  }
}

main().catch((err: any) => {
  fail(err.message || String(err));
  process.exit(1);
});
