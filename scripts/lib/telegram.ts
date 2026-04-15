/**
 * Shared Telegram messaging module.
 *
 * Replaces per-script sendTelegram() functions with a single implementation:
 * - Write-ahead delivery queue (message persisted to disk BEFORE send attempt)
 * - 3 attempts with exponential backoff (1s → 5s → 15s) + ±10% jitter
 * - Markdown parse fallback: try with parse_mode → retry without on parse error
 * - Atomic file writes (write .tmp then rename)
 * - Startup recovery: processQueue() scans pending messages and retries
 * - Node.js native https (no curl dependency)
 * - Honors Telegram 429 retry_after
 *
 * Usage:
 *   const { sendTelegram, processQueue } = require('./lib/telegram');
 *   await processQueue({ botToken, chatId, log }); // recover pending on startup
 *   sendTelegram(text, { parseMode: 'Markdown', chatId, botToken });
 *
 * OpenClaw patterns implemented:
 *   #1  — Retry with exponential backoff + jitter
 *   #2  — Write-ahead delivery queue
 *   #3  — Startup recovery (scan pending deliveries)
 *   #7  — Atomic file writes (temp + rename)
 *   #12 — HTML/Markdown parse fallback
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('node:crypto');

const { sleepWithAbort } = require('./utils.ts');
const { redact } = require('./security.ts');
const { DELIVERY, PLATFORM } = require('./constants.ts');
const { shouldSuppress, formatLoopAlert } = require('./notification-dedup.ts');
const { supabasePost } = require('./supabase.ts');

const MAX_ATTEMPTS: number = DELIVERY.maxAttempts;
const BASE_DELAYS: number[] = DELIVERY.baseDelays;
const JITTER: number = DELIVERY.jitter;
const QUEUE_DIR = path.join(__dirname, '..', '..', 'logs', 'delivery-queue');
const FAILED_DIR = path.join(QUEUE_DIR, 'failed');
const QUEUE_TIME_BUDGET: number = DELIVERY.queueTimeBudget;
const TELEGRAM_CHAR_LIMIT: number = PLATFORM.telegram.messageLimit;
const CHUNK_DELAY_MS = 300; // delay between sending chunks

type LogFn = (...args: any[]) => void;

interface QueueEntry {
  id: string;
  text: string;
  chatId: string;
  botToken: string;
  parseMode: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

interface SendResult {
  ok: boolean;
  retries: number;
  fallback: boolean;
  messageId?: number; // Telegram message_id — needed for reply matching (LinkedIn approvals)
}

interface PostResult {
  ok: boolean;
  statusCode: number;
  body: string;
}

interface QueueResult {
  processed: number;
  failed: number;
}

interface SendOptions {
  botToken?: string;
  chatId?: string;
  parseMode?: string;
  log?: LogFn;
}

interface VoiceOptions {
  botToken?: string;
  log?: LogFn;
}

interface DocumentOptions {
  botToken?: string;
  caption?: string;
  parseMode?: string;
  fileName?: string;
  log?: LogFn;
}

// Global abort controller for clean shutdown (P3-14)
let _shutdownController: AbortController | null = null;
function getShutdownSignal(): AbortSignal {
  if (!_shutdownController) _shutdownController = new AbortController();
  return _shutdownController.signal;
}
function abortPendingSleeps(): void {
  if (_shutdownController) _shutdownController.abort();
}

function sleep(ms: number): Promise<void> {
  return sleepWithAbort(ms, getShutdownSignal()).catch(() => {}); // swallow abort errors
}

function addJitter(ms: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * JITTER;
  return Math.round(ms * factor);
}

// --- Auto-log outbound messages to conversations table ---
// When sendTelegram sends to alerts or comms-coord chats, log to Supabase
// so cross-channel context includes Keel's outbound alerts.
function autoLogToConversations(text: string, chatId: string, log: LogFn): void {
  try {
    const alertsChatId = process.env.TELEGRAM_ALERTS_CHAT_ID;
    const commsCoordChatId = process.env.TELEGRAM_COMMS_COORD_CHAT_ID;

    let channel: string | null = null;
    if (alertsChatId && chatId === alertsChatId) {
      channel = 'telegram_alerts';
    } else if (commsCoordChatId && chatId === commsCoordChatId) {
      channel = 'telegram_comms_coord';
    }

    if (!channel) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;

    // Fire-and-forget — never block the send
    supabasePost('conversations', {
      channel,
      visibility: 'private',
      role: 'assistant',
      sender: 'keel',
      content: text,
      metadata: { source: 'auto-log' },
    }).catch(() => {}); // swallow errors silently
  } catch {
    // Never let logging break sends
  }
}

// --- Markdown-aware Message Chunking ---
// Splits messages exceeding Telegram's 4096-char limit.
// Priority: paragraph boundary (\n\n) → line boundary (\n) → word boundary.
// Closes/reopens code fences across chunk boundaries.

function chunkMessage(text: string, limit: number = TELEGRAM_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence = false; // track if we're inside a code fence

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Reserve space for fence closure if we might be splitting inside a code block
    const effectiveLimit = limit - 5; // room for \n```\n
    let splitAt = -1;
    const searchRange = remaining.slice(0, effectiveLimit);

    // Try paragraph boundary (\n\n) — split at last paragraph break within limit
    const paraIdx = searchRange.lastIndexOf('\n\n');
    if (paraIdx > effectiveLimit * 0.3) { // don't split too early
      splitAt = paraIdx;
    }

    // Fall back to line boundary (\n)
    if (splitAt === -1) {
      const lineIdx = searchRange.lastIndexOf('\n');
      if (lineIdx > effectiveLimit * 0.2) {
        splitAt = lineIdx;
      }
    }

    // Fall back to word boundary (space)
    if (splitAt === -1) {
      const spaceIdx = searchRange.lastIndexOf(' ');
      if (spaceIdx > effectiveLimit * 0.2) {
        splitAt = spaceIdx;
      }
    }

    // Hard split at effective limit if no good boundary found
    if (splitAt === -1) {
      splitAt = effectiveLimit;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n+/, ''); // trim leading newlines from next chunk

    // Handle code fence continuity
    const fenceMatches = chunk.match(/```/g);
    if (fenceMatches) {
      const fenceCount = fenceMatches.length;
      // If odd number of fences, we're splitting inside a code block
      if (fenceCount % 2 !== 0) {
        openFence = !openFence;
      }
    }

    if (openFence) {
      chunk += '\n```'; // close the fence in this chunk
      remaining = '```\n' + remaining; // reopen in next chunk
      openFence = false; // reset — the reopened fence will be tracked in the next iteration
    }

    chunks.push(chunk);
  }

  return chunks;
}

// --- Atomic File Write (Pattern #7) ---
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// --- Queue Management (Pattern #2) ---
function ensureQueueDirs(): void {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.mkdirSync(FAILED_DIR, { recursive: true });
}

function enqueue(text: string, opts: { chatId: string; botToken: string; parseMode?: string }): { id: string; filePath: string } {
  ensureQueueDirs();
  const id = `${Date.now()}-${nodeCrypto.randomBytes(4).toString('hex')}`;
  const entry: QueueEntry = {
    id,
    text,
    chatId: opts.chatId,
    botToken: opts.botToken,
    parseMode: opts.parseMode || '',
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  };
  const filePath = path.join(QUEUE_DIR, `${id}.json`);
  atomicWrite(filePath, JSON.stringify(entry, null, 2));
  return { id, filePath };
}

function dequeue(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function moveToFailed(filePath: string, entry: QueueEntry): void {
  ensureQueueDirs();
  const dest = path.join(FAILED_DIR, path.basename(filePath));
  try {
    atomicWrite(dest, JSON.stringify(entry, null, 2));
    fs.unlinkSync(filePath);
  } catch { /* best effort */ }
}

/**
 * Process pending queue items on startup (Pattern #3).
 * Scans queue dir, sends FIFO, respects time budget.
 */
async function processQueue({ botToken, chatId, log = console.log }: { botToken?: string; chatId?: string; log?: LogFn } = {}): Promise<QueueResult> {
  ensureQueueDirs();
  let files: string[];
  try {
    files = fs.readdirSync(QUEUE_DIR).filter((f: string) => f.endsWith('.json')).sort();
  } catch {
    return { processed: 0, failed: 0 };
  }

  if (files.length === 0) return { processed: 0, failed: 0 };

  log(`Delivery queue: ${files.length} pending message(s) found`);
  const startTime = Date.now();
  let processed = 0;
  let failed = 0;

  for (const file of files) {
    if (Date.now() - startTime > QUEUE_TIME_BUDGET) {
      log(`Delivery queue: time budget exhausted (${QUEUE_TIME_BUDGET}ms), ${files.length - processed - failed} remaining`);
      break;
    }

    const filePath = path.join(QUEUE_DIR, file);
    let entry: QueueEntry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      dequeue(filePath); // corrupt file, remove
      continue;
    }

    // Use stored credentials, fall back to provided ones
    const token = entry.botToken || botToken;
    const chat = entry.chatId || chatId;

    log(`Delivery queue: processing ${entry.id} (chat=${String(chat).slice(0, 6)}…, text="${entry.text.slice(0, 50)}…", attempts=${entry.attempts || 0})`);

    const result = await _sendWithRetry(entry.text, {
      botToken: token,
      chatId: chat,
      parseMode: entry.parseMode,
      log,
    });

    if (result.ok) {
      dequeue(filePath);
      processed++;
    } else {
      entry.attempts = (entry.attempts || 0) + MAX_ATTEMPTS;
      entry.lastError = `Failed after ${MAX_ATTEMPTS} attempts at ${new Date().toISOString()}`;

      if (entry.attempts >= MAX_ATTEMPTS * 2) {
        moveToFailed(filePath, entry);
        log(`Delivery queue: message ${entry.id} moved to failed/ after ${entry.attempts} total attempts (chat=${String(chat).slice(0, 6)}…)`);
        failed++;
      } else {
        atomicWrite(filePath, JSON.stringify(entry, null, 2));
        log(`Delivery queue: message ${entry.id} will retry next startup (${entry.attempts} attempts so far)`);
        failed++;
      }
    }
  }

  if (processed > 0 || failed > 0) {
    log(`Delivery queue: ${processed} sent, ${failed} failed`);
  }
  return { processed, failed };
}

/**
 * Send a Telegram message with write-ahead queue, retry, and parse fallback.
 *
 * Flow: enqueue to disk → attempt send with retry → dequeue on success
 */
async function sendTelegram(text: string, { botToken, chatId, parseMode = '', log = console.log }: SendOptions = {}): Promise<SendResult> {
  if (!botToken || !chatId) {
    log('WARN: No Telegram credentials — skipping send');
    return { ok: false, retries: 0, fallback: false };
  }

  if (!text || text.trim().length === 0) {
    return { ok: false, retries: 0, fallback: false };
  }

  // Loop detection (Intent #126) — suppress duplicate notifications
  const dedup = shouldSuppress(text, chatId);
  if (dedup.suppressed) {
    if (dedup.alertNeeded) {
      // Send ONE loop alert, then suppress all further duplicates
      const alertText = formatLoopAlert(text, chatId, dedup.count);
      log(`WARN: Loop detected — same notification sent ${dedup.count}x. Sending alert, suppressing further.`);
      // Send alert directly (bypass dedup to avoid recursion — alert text is unique)
      await _sendWithRetry(alertText, { botToken, chatId, parseMode: '', log });
    } else {
      log(`WARN: Loop suppressed — duplicate notification #${dedup.count} (already alerted)`);
    }
    return { ok: true, retries: 0, fallback: false }; // report ok so callers don't retry
  }

  // Dual-medium format: arrows → words for audio readability
  text = formatForAudio(text);

  // Chunk messages exceeding Telegram's 4096-char limit
  const chunks = chunkMessage(text);
  if (chunks.length > 1) {
    log(`Chunking message: ${text.length} chars to ${chunks.length} chunks`);
  }

  let lastResult: SendResult = { ok: false, retries: 0, fallback: false };
  let firstMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Write-ahead: persist to queue BEFORE attempting send
    const { filePath } = enqueue(chunk, { botToken, chatId, parseMode });

    const result = await _sendWithRetry(chunk, { botToken, chatId, parseMode, log });

    if (result.ok) {
      dequeue(filePath); // success — remove from queue
      if (i === 0 && result.messageId) firstMessageId = result.messageId;
    }
    // If failed, file stays in queue for processQueue() on next startup

    lastResult = result;

    // If a chunk failed, don't send remaining chunks (they'd be out of context)
    if (!result.ok) {
      log(`WARN: Chunk ${i + 1}/${chunks.length} failed — stopping remaining chunks`);
      break;
    }

    // Brief delay between chunks to maintain order
    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  // Auto-log to conversations for alerts/comms-coord channels
  if (lastResult.ok) {
    autoLogToConversations(text, chatId!, log);
  }

  // Attach first message ID (for reply matching — LinkedIn approvals)
  if (firstMessageId) lastResult.messageId = firstMessageId;

  return lastResult;
}

/**
 * Internal: send with retry + backoff + parse fallback.
 */
async function _sendWithRetry(text: string, { botToken, chatId, parseMode = '', log = console.log }: SendOptions = {}): Promise<SendResult> {
  let currentParseMode = parseMode;
  let fallbackUsed = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result: PostResult = await _post(botToken!, chatId!, text, currentParseMode!);

      if (result.ok) {
        // Extract message_id from Telegram API response
        let messageId: number | undefined;
        try {
          const parsed = JSON.parse(result.body);
          messageId = parsed.result?.message_id;
        } catch { /* non-fatal */ }
        if (attempt > 0 || fallbackUsed) {
          log(`Telegram message sent (${text.length} chars, ${attempt} retries${fallbackUsed ? ', parse fallback' : ''})`);
        } else {
          log(`Telegram message sent (${text.length} chars)`);
        }
        return { ok: true, retries: attempt, fallback: fallbackUsed, messageId };
      }

      // Parse error — fall back to no parse_mode and retry immediately
      if (result.statusCode === 400 && currentParseMode && result.body.includes('parse')) {
        log(`WARN: Telegram parse error with ${currentParseMode} — retrying without parse_mode`);
        currentParseMode = '';
        fallbackUsed = true;
        continue;
      }

      // Rate limited — honor retry_after
      if (result.statusCode === 429) {
        const retryAfter = _extractRetryAfter(result.body);
        const waitMs = retryAfter ? retryAfter * 1000 : BASE_DELAYS[attempt];
        log(`WARN: Telegram rate limited — waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(waitMs);
        continue;
      }

      // Other error — backoff and retry
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = addJitter(BASE_DELAYS[attempt]);
        log(`WARN: Telegram send failed (${result.statusCode}) — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(delay);
      } else {
        log(`ERROR: Telegram send failed after ${MAX_ATTEMPTS} attempts (${result.statusCode}): ${redact(result.body.slice(0, 200))}`);
      }
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = addJitter(BASE_DELAYS[attempt]);
        log(`WARN: Telegram send error: ${err.message} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(delay);
      } else {
        log(`ERROR: Telegram send failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
      }
    }
  }

  return { ok: false, retries: MAX_ATTEMPTS - 1, fallback: fallbackUsed };
}

/**
 * Raw HTTPS POST to Telegram sendMessage API.
 */
function _post(botToken: string, chatId: string, text: string, parseMode: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const payload: Record<string, string> = { chat_id: chatId, text };
    if (parseMode) payload.parse_mode = parseMode;

    const body = JSON.stringify(payload);
    const options = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', (err: Error) => reject(err));
    req.setTimeout(DELIVERY.requestTimeout, () => {
      req.destroy(new Error(`Telegram request timeout (${DELIVERY.requestTimeout / 1000}s)`));
    });
    req.write(body);
    req.end();
  });
}

function _extractRetryAfter(body: string): number | null {
  try {
    const parsed = JSON.parse(body);
    return parsed.parameters?.retry_after || null;
  } catch {
    return null;
  }
}

/**
 * Send a voice message to Telegram using the sendVoice API.
 * Uploads an OGG/Opus file as a voice message (plays inline in Telegram).
 */
async function sendVoice(chatId: string, filePath: string, { botToken, log = console.log }: VoiceOptions = {}): Promise<{ ok: boolean }> {
  if (!botToken || !chatId || !filePath) {
    log('WARN: sendVoice missing required params — skipping');
    return { ok: false };
  }

  if (!fs.existsSync(filePath)) {
    log(`WARN: sendVoice file not found: ${filePath}`);
    return { ok: false };
  }

  return new Promise((resolve) => {
    const boundary = `----KeelBoundary${nodeCrypto.randomBytes(8).toString('hex')}`;
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Build multipart/form-data body
    const parts: string[] = [];

    // chat_id field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${chatId}\r\n`
    );

    // voice file field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="voice"; filename="${fileName}"\r\n` +
      `Content-Type: audio/ogg\r\n\r\n`
    );

    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const options = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendVoice`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ ok: true });
        } else {
          log(`WARN: sendVoice failed (${res.statusCode}): ${data.slice(0, 200)}`);
          resolve({ ok: false });
        }
      });
    });

    req.on('error', (err: Error) => {
      log(`WARN: sendVoice error: ${err.message}`);
      resolve({ ok: false });
    });

    req.setTimeout(DELIVERY.requestTimeout, () => {
      req.destroy(new Error('sendVoice timeout'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send a document (file) to Telegram using the sendDocument API.
 * Uploads a file as a document attachment (not inline — user can tap to open/download).
 */
async function sendDocument(chatId: string, filePath: string, { botToken, caption = '', parseMode = '', fileName = '', log = console.log }: DocumentOptions = {}): Promise<{ ok: boolean }> {
  if (!botToken || !chatId || !filePath) {
    log('WARN: sendDocument missing required params — skipping');
    return { ok: false };
  }

  if (!fs.existsSync(filePath)) {
    log(`WARN: sendDocument file not found: ${filePath}`);
    return { ok: false };
  }

  return new Promise((resolve) => {
    const boundary = `----KeelBoundary${nodeCrypto.randomBytes(8).toString('hex')}`;
    const fileData = fs.readFileSync(filePath);
    const displayName = fileName || path.basename(filePath);

    const parts: string[] = [];

    // chat_id field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${chatId}\r\n`
    );

    // caption field (optional)
    if (caption) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption.slice(0, 1024)}\r\n`
      );
    }

    // parse_mode for caption (optional)
    if (parseMode && caption) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="parse_mode"\r\n\r\n` +
        `${parseMode}\r\n`
      );
    }

    // document file field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${displayName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );

    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const options = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendDocument`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log(`Document sent: ${displayName} (${fileData.length} bytes)`);
          resolve({ ok: true });
        } else {
          log(`WARN: sendDocument failed (${res.statusCode}): ${data.slice(0, 200)}`);
          resolve({ ok: false });
        }
      });
    });

    req.on('error', (err: Error) => {
      log(`WARN: sendDocument error: ${err.message}`);
      resolve({ ok: false });
    });

    req.setTimeout(DELIVERY.requestTimeout, () => {
      req.destroy(new Error('sendDocument timeout'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send a photo to Telegram using the sendPhoto API.
 * Renders inline as an image (not as a file attachment like sendDocument).
 */
async function sendPhoto(chatId: string, filePath: string, { botToken, caption = '', parseMode = '', log = console.log }: DocumentOptions = {}): Promise<{ ok: boolean }> {
  if (!botToken || !chatId || !filePath) {
    log('WARN: sendPhoto missing required params — skipping');
    return { ok: false };
  }

  if (!fs.existsSync(filePath)) {
    log(`WARN: sendPhoto file not found: ${filePath}`);
    return { ok: false };
  }

  return new Promise((resolve) => {
    const boundary = `----KeelBoundary${nodeCrypto.randomBytes(8).toString('hex')}`;
    const fileData = fs.readFileSync(filePath);
    const displayName = path.basename(filePath);

    const parts: string[] = [];

    // chat_id field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${chatId}\r\n`
    );

    // caption field (optional)
    if (caption) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption.slice(0, 1024)}\r\n`
      );
    }

    // parse_mode for caption (optional)
    if (parseMode && caption) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="parse_mode"\r\n\r\n` +
        `${parseMode}\r\n`
      );
    }

    // photo file field
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${displayName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );

    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const options = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendPhoto`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log(`Photo sent: ${displayName} (${fileData.length} bytes)`);
          resolve({ ok: true });
        } else {
          log(`WARN: sendPhoto failed (${res.statusCode}): ${data.slice(0, 200)}`);
          resolve({ ok: false });
        }
      });
    });

    req.on('error', (err: Error) => {
      log(`WARN: sendPhoto error: ${err.message}`);
      resolve({ ok: false });
    });

    req.setTimeout(DELIVERY.requestTimeout, () => {
      req.destroy(new Error('sendPhoto timeout'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Format text for dual-medium consumption (visual + audio).
 * Telegram messages are read visually AND listened to via TTS.
 * Arrows (→, ←) read as "arrow" in speech — replace with words outside code blocks.
 * Tier 1 enforcement: fires on every outbound Telegram message automatically.
 */
function formatForAudio(text: string): string {
  // Split by code fences and inline code to preserve arrows in code
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/);
  return parts.map((part, i) => {
    // Odd indices are code blocks/inline code — leave unchanged
    if (i % 2 === 1) return part;
    // Replace arrows with words in prose
    return part
      .replace(/\s*→\s*/g, ' to ')
      .replace(/\s*←\s*/g, ' from ');
  }).join('');
}

/**
 * Auto-credentialed DM sender. Loads botToken/chatId from process.env.
 * THROWS if credentials are missing — silent failures are not acceptable.
 *
 * Usage: const { sendTelegramMsg } = require('./lib/telegram.ts');
 *        await sendTelegramMsg('message');
 */
async function sendTelegramMsg(text: string, opts: { parseMode?: string; log?: LogFn } = {}): Promise<SendResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing from process.env — cannot send DM');
  }
  return sendTelegram(text, { botToken, chatId, parseMode: opts.parseMode || '', log: opts.log || console.log });
}

module.exports = { sendTelegram, sendTelegramMsg, processQueue, chunkMessage, sendVoice, sendDocument, sendPhoto, formatForAudio };
