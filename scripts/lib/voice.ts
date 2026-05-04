/**
 * Voice transcription — provider-agnostic audio → text.
 *
 * Used by channel adapters that handle voice messages (Telegram voice notes,
 * Discord audio attachments, etc.). Detects the transcription backend from
 * .env, dispatches accordingly:
 *
 *   - OpenAI Whisper API   ($0.006/min, simplest if OPENAI_API_KEY set)
 *   - Local whisper.cpp    (sovereign, OPENAI_API_BASE=http://localhost:<port>)
 *   - (extensible — add more backends as branches)
 *
 * Channel adapters call transcribe() with a URL or buffer; this layer handles
 * the provider routing. Same pattern as substrate.ts for AI calls.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

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

async function downloadAudio(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function transcribeViaOpenAI(audio: Buffer, apiKey: string, mimeType: string = 'audio/ogg'): Promise<string | null> {
  const boundary = `----alienkind${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.${mimeType.split('/')[1] || 'ogg'}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}--\r\n`
  );
  const body = Buffer.concat([head, audio, tail]);

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

interface TranscribeOptions {
  /** Audio file as a Buffer, or a URL to download from. One must be provided. */
  buffer?: Buffer;
  url?: string;
  /** MIME type. Defaults to audio/ogg (Telegram's voice format). */
  mimeType?: string;
}

/**
 * Transcribe audio to text using whichever backend is configured in .env.
 * Returns null if no backend is available or transcription failed.
 *
 * Backends checked in order:
 *   1. OpenAI Whisper API  (if OPENAI_API_KEY set)
 *   2. (future: local whisper.cpp via WHISPER_CPP_HOST)
 *   3. (future: Voxtral via VOXTRAL_API_KEY)
 */
async function transcribe(opts: TranscribeOptions): Promise<string | null> {
  const env = { ...loadEnv(), ...process.env };

  let audio: Buffer;
  if (opts.buffer) {
    audio = opts.buffer;
  } else if (opts.url) {
    try {
      audio = await downloadAudio(opts.url);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const mimeType = opts.mimeType || 'audio/ogg';

  if (env.OPENAI_API_KEY) {
    return transcribeViaOpenAI(audio, env.OPENAI_API_KEY, mimeType);
  }

  // Future: whisper.cpp local, Voxtral, etc.
  return null;
}

function isTranscriptionAvailable(): boolean {
  const env = { ...loadEnv(), ...process.env };
  return !!env.OPENAI_API_KEY;
}

module.exports = { transcribe, isTranscriptionAvailable };
