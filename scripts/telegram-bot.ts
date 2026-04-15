/**
 * Telegram Bot — grammY-based Keel Interface
 *
 * Built on grammY (1.4M weekly downloads, TypeScript-first, 4 deps).
 * Architecture borrowed from fitz123/claude-code-bot patterns.
 *
 * grammY handles: polling, error retry, typing indicators, file downloads,
 * message routing, API rate limits. We handle: Keel identity, PACE routing,
 * kill switch, security scanning, voice transcription, conversation history.
 *
 * All channels (DM, Alerts, CommsCoord) route through keel-engine.ts.
 * Same code path. Same capability. Channel config determines context.
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Bot, InputFile } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');

const KEEL_DIR = path.resolve(__dirname, '..');
const { loadEnv, createLogger, classifyMessage } = require('./lib/shared.ts');
const { processMessage, CHANNELS } = require('./lib/keel-engine.ts');
const { TIMEZONE, WHISPER, MEDIA, TTS, PLATFORM } = require('./lib/constants.ts');
const { getNowCT } = require('./lib/keel-env.ts');
const { escapeShellArg, validateFilePath } = require('./lib/exec-safety.ts');
const { acquireLock } = require('./lib/lockfile.ts');
const { synthesizeVoice } = require('./lib/tts.ts');
const { formatForAudio, chunkMessage } = require('./lib/telegram.ts');
const { getChannelSession, recordSessionMessage } = require('./lib/channel-sessions.ts');

// --- Init ---
const env = loadEnv();
// Populate process.env so invoke-keel.ts → injectClaudeAuth can read OAuth tokens
for (const [k, v] of Object.entries(env) as [string, string][]) {
  if (!process.env[k]) process.env[k] = v;
}
const { log } = createLogger(path.join(KEEL_DIR, 'logs', 'telegram-bot.log'));

const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const DM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const ALERTS_CHAT_ID = env.TELEGRAM_ALERTS_CHAT_ID;
const COMMS_COORD_CHAT_ID = env.TELEGRAM_COMMS_COORD_CHAT_ID;
const WHISPER_MODEL_PATH = path.join(KEEL_DIR, WHISPER.modelPath);

if (!BOT_TOKEN) { log('ERROR', 'TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!DM_CHAT_ID) { log('ERROR', 'TELEGRAM_CHAT_ID missing'); process.exit(1); }

// Lock to prevent duplicate instances
const lockAcquired = acquireLock('telegram-bot', { log: (msg: string) => log('INFO', msg) });
if (!lockAcquired) {
  log('INFO', 'FATAL: Another telegram-bot instance is running. Exiting.');
  process.exit(0);
}

// --- Channel Routing ---

function identifyChannel(chatId: number): string | null {
  const id = String(chatId);
  if (id === DM_CHAT_ID) return 'telegram_dm';
  if (id === ALERTS_CHAT_ID) return 'telegram_alerts';
  if (id === COMMS_COORD_CHAT_ID) return 'telegram_comms_coord';
  return null;
}

// --- Voice Transcription (local Whisper — zero API cost) ---

function transcribeVoice(filePath: string): string | null {
  if (!fs.existsSync(WHISPER_MODEL_PATH) || !fs.existsSync(WHISPER.binaryPath)) return null;
  let wavPath: string | null = null;
  let inputPath = filePath;

  try {
    validateFilePath(filePath);

    // Probe duration
    try {
      const probeResult = execSync(`ffprobe -v quiet -print_format json -show_format ${escapeShellArg(filePath)}`, { timeout: WHISPER.probeTimeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const duration = parseFloat(JSON.parse(probeResult).format?.duration);
      if (!isNaN(duration)) {
        if (duration < WHISPER.minDurationSec || duration > WHISPER.maxDurationSec) {
          log('INFO', `Voice note ${duration.toFixed(1)}s — outside range, skipping`);
          return null;
        }
        log('INFO', `Audio preflight OK: ${duration.toFixed(1)}s`);
      }
    } catch {}

    // Convert OGA to WAV for Whisper
    if (filePath.endsWith('.oga') || filePath.endsWith('.ogg')) {
      wavPath = filePath.replace(/\.(oga|ogg)$/, '.wav');
      execSync(`ffmpeg -i ${escapeShellArg(filePath)} -ar 16000 -ac 1 -c:a pcm_s16le ${escapeShellArg(wavPath)} -y`, { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
      inputPath = wavPath;
      log('INFO', `Converted ${path.basename(filePath)} to WAV`);
    }

    const result = execSync(`${escapeShellArg(WHISPER.binaryPath)} -m ${escapeShellArg(WHISPER_MODEL_PATH)} -f ${escapeShellArg(inputPath)} -l ${escapeShellArg(WHISPER.language)} --no-timestamps -np`, { timeout: WHISPER.transcriptionTimeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const text = result.trim();
    if (text.length > 0) { log('INFO', `Whisper transcription: ${text.length} chars`); return text; }
    return null;
  } catch (err: any) {
    log('WARN', `Transcription failed: ${err.message}`);
    return null;
  } finally {
    if (wavPath) try { fs.unlinkSync(wavPath); } catch {}
  }
}

// --- Message Sending (with chunking + HTML + fallback) ---

function markdownToTelegramHtml(text: string): string {
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/```(?:\w*)([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  return html;
}

async function sendResponse(ctx: any, text: string): Promise<void> {
  text = formatForAudio(text);
  const chunks = chunkMessage(text, 3500);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    try {
      await ctx.reply(html, { parse_mode: 'HTML' });
    } catch (err: any) {
      if ((err?.message || '').includes("can't parse entities") || (err?.message || '').includes('too long')) {
        // Fallback: send raw text, re-chunk if needed
        const subChunks = chunkMessage(chunk, 3500);
        for (const sub of subChunks) {
          await ctx.reply(sub);
        }
      } else {
        throw err;
      }
    }
  }
}

// --- Message Debouncing (3-second window, fitz123 pattern) ---

interface PendingMessage {
  text: string;
  voiceMode: boolean;
  mediaContext: string;
  ctx: any; // grammY context — captured for reply
}

const debounceState = new Map<string, {
  pending: PendingMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}>();

const DEBOUNCE_MS = 3000;

function getDebouncedState(chatId: string) {
  if (!debounceState.has(chatId)) {
    debounceState.set(chatId, { pending: [], timer: null, busy: false });
  }
  return debounceState.get(chatId)!;
}

async function enqueueMessage(chatId: string, msg: PendingMessage): Promise<void> {
  const state = getDebouncedState(chatId);

  if (state.busy) {
    // Mid-turn: buffer for after current processing completes
    state.pending.push(msg);
    log('DEBUG', `[debounce] ${chatId}: buffered mid-turn message (${state.pending.length} pending)`);
    return;
  }

  state.pending.push(msg);

  // Reset debounce timer
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => flushMessages(chatId), DEBOUNCE_MS);
}

async function flushMessages(chatId: string): Promise<void> {
  const state = getDebouncedState(chatId);
  if (state.pending.length === 0) return;

  state.busy = true;
  state.timer = null;

  // Combine all pending messages
  const messages = [...state.pending];
  state.pending = [];

  const combinedText = messages.map(m => m.text).filter(Boolean).join('\n\n');
  const combinedMedia = messages.map(m => m.mediaContext).filter(Boolean).join('\n');
  const voiceMode = messages.some(m => m.voiceMode);
  const lastCtx = messages[messages.length - 1].ctx; // Use last context for reply

  const channel = identifyChannel(lastCtx.chat.id);
  if (!channel) { state.busy = false; return; }

  const channelConfig = CHANNELS[channel];
  if (!channelConfig) { state.busy = false; return; }

  if (messages.length > 1) {
    log('INFO', `[debounce] Coalesced ${messages.length} messages (${combinedText.length} chars)`);
  }

  // Show typing
  try { await lastCtx.api.sendChatAction(lastCtx.chat.id, 'typing'); } catch {}
  const typingInterval = setInterval(() => {
    try { lastCtx.api.sendChatAction(lastCtx.chat.id, 'typing'); } catch {}
  }, 4000);

  try {
    const messageForEngine = combinedText || '[media attached — see additional context]';

    // --- Kill Switch (code enforcement — not model-dependent) ---
    const lowerText = messageForEngine.toLowerCase();
    if (lowerText.includes('lockdown') || lowerText.includes('unlock')) {
      try {
        const { parseKillCommand, setKillLevel, clearKillSwitch, getKillLevel, LEVEL_NAMES } = require('./lib/defense-elements.ts');
        const killCmd = parseKillCommand(messageForEngine, 'owner');
        if (killCmd) {
          if (killCmd.action === 'lockdown') {
            setKillLevel(killCmd.level || 3, '[HUMAN] LOCKDOWN via Telegram', 'telegram-bot');
            await lastCtx.reply(`LOCKDOWN activated — level ${killCmd.level || 3}. All affected actions halted. Send UNLOCK to resume.`);
            log('WARN', `[KILL SWITCH] LOCKDOWN level ${killCmd.level || 3}`);
            return;
          } else if (killCmd.action === 'unlock') {
            clearKillSwitch('[HUMAN] UNLOCK via Telegram', 'telegram-bot');
            await lastCtx.reply('UNLOCK — kill switch cleared. All systems normal.');
            log('INFO', '[KILL SWITCH] Cleared');
            return;
          } else if (killCmd.action === 'status') {
            await lastCtx.reply(`Kill switch: level ${getKillLevel()} (${LEVEL_NAMES[getKillLevel()]})`);
            return;
          }
        }
      } catch {}
    }

    // --- Security: Injection Detection ---
    try {
      const { detectInjection } = require('./lib/injection-detector.ts');
      const injectionResult = await detectInjection(messageForEngine);
      if (injectionResult && injectionResult.detected) {
        log('WARN', `[INJECTION] Blocked: ${injectionResult.summary}`);
        await lastCtx.reply('Message flagged by security. If this is a mistake, try rephrasing.');
        return;
      }
    } catch {}

    // Always use 'heavy' for Telegram — user-facing conversations need full Keel identity.
    // 'light' routes to local models which lack identity/history. classifyMessage is for daemon tasks.
    const complexity = 'heavy' as const;
    const senderName = lastCtx.from?.first_name || '[HUMAN]';

    // Instruct model to READ attached files (critical for multimodal)
    let mediaInstructions = combinedMedia;
    if (mediaInstructions) {
      mediaInstructions = mediaInstructions.replace(
        /\[Photo attached: ([^\]]+)\]/g,
        '[HUMAN] sent a photo. Use the Read tool to view it at: $1'
      );
      mediaInstructions = mediaInstructions.replace(
        /\[Document attached: ([^\]]+)\]/g,
        '[HUMAN] sent a document. Use the Read tool to read it at: $1'
      );
    }

    // --- Session Persistence: get or create persistent session for this channel ---
    const session = await getChannelSession(channel, log);

    const result = await processMessage(messageForEngine, {
      channelConfig,
      log,
      complexity,
      injectIdentity: true,
      sender: '[human_first]',
      senderDisplayName: senderName,
      additionalContext: mediaInstructions || undefined,
      ...(session.isResume
        ? { resumeSessionId: session.sessionId }
        : { sessionId: session.sessionId }),
    });

    // Record successful message in session
    await recordSessionMessage(channel, log);

    const response = result.text;

    if (!response || response.trim().length === 0 || response.trim() === '[NO_RESPONSE]') {
      if (response?.trim() === '[NO_RESPONSE]') {
        log('INFO', `[${channelConfig.displayName}] Discernment — no response`);
      } else {
        log('WARN', `[${channelConfig.displayName}] Empty response from ${result.model}`);
        await lastCtx.reply('I processed your message but no text came through. Try in terminal or resend.');
      }
      return;
    }

    // --- Security: Output Guard ---
    try {
      const { scanOutput } = require('./lib/output-guard.ts');
      const outputScan = scanOutput(response, { channel: 'telegram', target: channel === 'telegram_dm' ? 'dm' : 'group', internalOnly: channel === 'telegram_dm' });
      if (outputScan.blocked) {
        log('WARN', `[OUTPUT GUARD] Blocked: ${outputScan.summary}`);
        await lastCtx.reply(`[Output guard blocked response — ${outputScan.violations.length} violation(s). Check logs.]`);
        return;
      }
    } catch {}

    // Send text response
    await sendResponse(lastCtx, response);
    log('INFO', `[${channelConfig.displayName}] Response sent (${response.length} chars) [${result.model}] [${result.tier}]`);

    // --- Daily Memory Logging ---
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dmMemPath = path.join(KEEL_DIR, 'memory', 'daily', `${today}.md`);
      const time = getNowCT();
      const channelTag = channel === 'telegram_dm' ? 'DM' : channel === 'telegram_alerts' ? 'Alerts' : 'CommsCoord';
      fs.appendFileSync(dmMemPath, `- **[${channelTag} ${time}] [HUMAN]:** ${combinedText.slice(0, 200)}\n`);
      fs.appendFileSync(dmMemPath, `- **[${channelTag} ${time}] Keel:** ${response.slice(0, 300)}\n`);
    } catch {}

    // --- Mycelium Focus Update ---
    try {
      const { updateFocus } = require('./lib/terminal-sessions.ts');
      updateFocus('telegram', { type: 'telegram', focus: `${channel}: ${combinedText.slice(0, 100)}`, pid: process.pid });
    } catch {}

    // --- Learning Ledger: Correction Detection ---
    try {
      const { detectCorrection, buildPatternName } = require('./lib/learning-ledger.ts');
      const correction = detectCorrection(combinedText);
      if (correction) {
        const { logLearning } = require('./lib/learning-ledger.ts');
        logLearning({
          patternName: buildPatternName(correction),
          correctionText: combinedText,
          context: `${channelConfig.displayName} channel`,
          sourceChannel: channel,
          category: 'behavioral',
          sentiment: correction.sentiment,
          severity: correction.severity || 5,
        });
      }
    } catch {}

    // --- Voice Response ---
    if (voiceMode && response.length <= (TTS?.maxCharsForVoice || 12000)) {
      try {
        const oggPath = await synthesizeVoice(response, { log: (level: string, msg: string) => log(level, msg) });
        if (oggPath) {
          await lastCtx.replyWithVoice(new InputFile(oggPath));
          log('INFO', `Voice response sent (${response.length} chars synthesized)`);
          try { fs.unlinkSync(oggPath); } catch {}
        }
      } catch (err: any) {
        log('WARN', `Voice synthesis failed: ${err.message}`);
      }
    }
  } catch (err: any) {
    log('ERROR', `[${channel}] Processing failed: ${err.message}`);
    try {
      await lastCtx.reply('Something went wrong. Check logs or try in terminal.');
    } catch {}
  } finally {
    clearInterval(typingInterval);
    state.busy = false;

    // Drain any messages that arrived during processing
    if (state.pending.length > 0) {
      log('INFO', `[debounce] Draining ${state.pending.length} messages collected during processing`);
      setTimeout(() => flushMessages(chatId), 500);
    }
  }
}

// --- grammY Bot Setup ---

const bot = new Bot(BOT_TOKEN);

// Auto-retry on 429 rate limits (fitz123 pattern)
bot.api.config.use(autoRetry({
  maxRetryAttempts: 5,
  maxDelaySeconds: 60,
  rethrowHttpErrors: false,
}));

// --- Text Messages ---
bot.on('message:text', async (ctx: any) => {
  const channel = identifyChannel(ctx.chat.id);
  if (!channel) return;

  // --- LinkedIn Engagement Interceptor (deterministic, no AI) ---
  // When [HUMAN] replies to a LinkedIn draft message, route directly to processApprovalReply.
  // This replaces the old path where a full Claude session spawned and improvised.
  const replyTo = ctx.message.reply_to_message;
  if (replyTo?.message_id && (channel === 'telegram_comms_coord' || channel === 'telegram_dm')) {
    try {
      const { supabaseGet } = require('./lib/supabase.ts');
      const matches = await supabaseGet(
        'linkedin_engagements',
        `select=id&telegram_message_id=eq.${replyTo.message_id}&status=in.(sent_to_human,editing,post_failed)&limit=1`
      );
      if (matches.length > 0) {
        log('INFO', `[LinkedIn] Intercepted reply to engagement ${matches[0].id} (msg ${replyTo.message_id})`);
        // Clear require cache to pick up code changes without restarting the listener
        const engagePath = require.resolve('./linkedin-engage.ts');
        delete require.cache[engagePath];
        const { processApprovalReply } = require('./linkedin-engage.ts');
        const result = await processApprovalReply(replyTo.message_id, ctx.message.text);
        await sendResponse(ctx, result);
        log('INFO', `[LinkedIn] Approval processed: ${result.slice(0, 100)}`);
        return; // Skip keel-engine — handled deterministically
      }
    } catch (err: any) {
      log('WARN', `[LinkedIn] Interceptor error: ${err.message}`);
      // Fall through to keel-engine on error — don't block normal messages
    }
  }

  // Voice mode phrase detection
  const lower = ctx.message.text.toLowerCase();
  const voiceOn = /\b(voice mode|talk in voice|let'?s talk|speak to me|use voice)\b/.test(lower);
  const voiceOff = /\b(text mode|stop voice|no voice|text only)\b/.test(lower);

  let voiceMode = false;
  if (voiceOn) { voiceMode = true; log('INFO', 'Voice mode activated via phrase'); }
  if (voiceOff) { voiceMode = false; log('INFO', 'Voice mode deactivated via phrase'); }

  await enqueueMessage(String(ctx.chat.id), {
    text: ctx.message.text,
    voiceMode,
    mediaContext: '',
    ctx,
  });
});

// --- Voice Notes ---
bot.on('message:voice', async (ctx: any) => {
  const channel = identifyChannel(ctx.chat.id);
  if (!channel) return;

  let text = '';
  let mediaContext = '';
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  // Download
  const ext = path.extname(file.file_path || '') || '.oga';
  const localPath = path.join(MEDIA.tempDir, `keel-media-${Date.now()}${ext}`);
  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    log('INFO', `Downloaded voice ${file.file_path} (${buffer.length} bytes)`);

    const transcription = transcribeVoice(localPath);
    if (transcription) {
      text = transcription;
    } else {
      text = '';
      mediaContext = `[HUMAN] sent a voice note (${ctx.message.voice.duration}s) but transcription failed. Ask him to type it or try again.`;
    }
  } catch (err: any) {
    log('WARN', `Voice download failed: ${err.message}`);
    mediaContext = '[HUMAN] sent a voice note but download failed.';
  }

  // Schedule cleanup
  setTimeout(() => { try { fs.unlinkSync(localPath); } catch {} }, 5 * 60 * 1000);

  await enqueueMessage(String(ctx.chat.id), {
    text,
    voiceMode: true, // Voice note triggers voice response for THIS batch only
    mediaContext,
    ctx,
  });
});

// --- Photos ---
bot.on('message:photo', async (ctx: any) => {
  const channel = identifyChannel(ctx.chat.id);
  if (!channel) return;

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];
  const file = await ctx.api.getFile(bestPhoto.file_id);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const ext = path.extname(file.file_path || '') || '.jpg';
  const localPath = path.join(MEDIA.tempDir, `keel-media-${Date.now()}${ext}`);
  let mediaContext = '';

  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    log('INFO', `Downloaded photo (${buffer.length} bytes)`);
    mediaContext = `[Photo attached: ${localPath}]`;
    setTimeout(() => { try { fs.unlinkSync(localPath); } catch {} }, 5 * 60 * 1000);
  } catch (err: any) {
    log('WARN', `Photo download failed: ${err.message}`);
  }

  await enqueueMessage(String(ctx.chat.id), {
    text: ctx.message.caption || '',
    voiceMode: false,
    mediaContext,
    ctx,
  });
});

// --- Documents ---
bot.on('message:document', async (ctx: any) => {
  const channel = identifyChannel(ctx.chat.id);
  if (!channel) return;

  const doc = ctx.message.document;
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const ext = path.extname(doc.file_name || file.file_path || '') || '';
  const localPath = path.join(MEDIA.tempDir, `keel-media-${Date.now()}${ext}`);
  let mediaContext = '';

  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    log('INFO', `Downloaded document ${doc.file_name} (${buffer.length} bytes)`);
    mediaContext = `[Document attached: ${localPath} (${doc.file_name || 'unknown'})]`;
    setTimeout(() => { try { fs.unlinkSync(localPath); } catch {} }, 5 * 60 * 1000);
  } catch (err: any) {
    log('WARN', `Document download failed: ${err.message}`);
  }

  await enqueueMessage(String(ctx.chat.id), {
    text: ctx.message.caption || '',
    voiceMode: false,
    mediaContext,
    ctx,
  });
});

// --- Global Error Handler ---
bot.catch((err: any) => {
  log('ERROR', `Bot error: ${err.error?.message || err.message || err}`);
});

// --- Crash Protection ---
process.on('uncaughtException', (err: any) => {
  log('ERROR', `Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  log('ERROR', `Unhandled rejection: ${err?.stack || err}`);
  process.exit(1);
});

// --- Graceful Shutdown ---
function shutdown(signal: string) {
  log('INFO', `Received ${signal}. Shutting down.`);
  bot.stop();
  try { fs.unlinkSync(path.join(KEEL_DIR, 'logs', 'telegram-bot.lock')); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
log('INFO', 'Starting Telegram Bot (grammY)...');
bot.start({
  allowed_updates: ['message'],
  onStart: (botInfo: any) => {
    log('INFO', `Telegram Bot connected as @${botInfo.username}. Polling.`);
  },
}).catch((err: any) => {
  log('ERROR', `Bot startup failed: ${err.message}`);
  process.exit(1);
});
