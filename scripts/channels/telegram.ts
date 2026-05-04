#!/usr/bin/env npx tsx

/**
 * Telegram Channel Adapter — bridges Telegram to your AlienKind partner.
 *
 * Substrate-agnostic by design: this adapter calls askPartner() from
 * scripts/lib/substrate.ts, which routes to whichever provider is in .env
 * (Claude Code Max / Anthropic API / OpenAI / OpenRouter / local Ollama).
 *
 * grammY does the Telegram I/O (1.4M weekly downloads, mature, well-maintained).
 * We supply the bridge.
 *
 * Auth: hardcoded chat-ID whitelist via TELEGRAM_ALLOWED_CHAT_IDS.
 *
 * Usage:
 *   npx tsx scripts/channels/telegram.ts
 *   (or via pm2 — managed by scripts/tools/add-channel.ts)
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN        — from @BotFather
 *   TELEGRAM_ALLOWED_CHAT_IDS — comma-separated chat IDs allowed to talk
 *
 * Optional:
 *   OPENAI_API_KEY            — enables voice-note transcription via Whisper
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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',').map((s: string) => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('[telegram] TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}
if (ALLOWED_CHAT_IDS.length === 0) {
  console.error('[telegram] TELEGRAM_ALLOWED_CHAT_IDS not set — refusing to start (would accept anonymous messages)');
  process.exit(1);
}

let Bot: any;
try {
  ({ Bot } = require('grammy'));
} catch {
  console.error('[telegram] grammy not installed. Run: npm install grammy');
  process.exit(1);
}

const { askPartner } = require(path.join(ROOT, 'scripts', 'lib', 'substrate.ts'));

const bot = new Bot(BOT_TOKEN);

async function transcribeVoice(fileUrl: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Download the .ogg
  const https = require('https');
  const audioBuffer: Buffer = await new Promise((resolve, reject) => {
    https.get(fileUrl, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });

  // Multipart upload to Whisper. Hand-rolled to avoid form-data dep.
  const boundary = `----alienkind${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="voice.ogg"\r\n` +
    `Content-Type: audio/ogg\r\n\r\n`
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}--\r\n`
  );
  const body = Buffer.concat([head, audioBuffer, tail]);

  return new Promise((resolve) => {
    const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.text || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function chunkAndSend(ctx: any, text: string): Promise<void> {
  let remaining = text;
  while (remaining.length > 4000) {
    await ctx.reply(remaining.slice(0, 4000));
    remaining = remaining.slice(4000);
  }
  if (remaining) await ctx.reply(remaining);
}

bot.on('message:text', async (ctx: any) => {
  const chatId = String(ctx.from?.id || '');
  if (!ALLOWED_CHAT_IDS.includes(chatId)) {
    console.log(`[telegram] rejected message from unauthorized chat ${chatId}`);
    return;
  }

  await ctx.replyWithChatAction('typing');
  try {
    const reply = await askPartner(ctx.message.text);
    await chunkAndSend(ctx, reply);
  } catch (err: any) {
    console.error(`[telegram] askPartner failed: ${err.message}`);
    await ctx.reply(`(partner error: ${err.message.slice(0, 200)})`);
  }
});

bot.on('message:voice', async (ctx: any) => {
  const chatId = String(ctx.from?.id || '');
  if (!ALLOWED_CHAT_IDS.includes(chatId)) return;

  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice notes need OPENAI_API_KEY in .env for transcription. Add it and restart, or send text.");
    return;
  }

  await ctx.replyWithChatAction('typing');
  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const transcript = await transcribeVoice(fileUrl);
    if (!transcript) {
      await ctx.reply("(transcription failed — check OPENAI_API_KEY)");
      return;
    }
    await ctx.reply(`🎤 Heard: "${transcript}"`);
    const reply = await askPartner(transcript);
    await chunkAndSend(ctx, reply);
  } catch (err: any) {
    console.error(`[telegram] voice handler failed: ${err.message}`);
    await ctx.reply(`(error: ${err.message.slice(0, 200)})`);
  }
});

bot.catch((err: any) => {
  console.error(`[telegram] bot error: ${err.error?.message || err.message || err}`);
});

console.log(`[telegram] starting — authorized chat IDs: ${ALLOWED_CHAT_IDS.join(', ')}`);
bot.start();
