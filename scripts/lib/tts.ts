// @alienkind-core
/**
 * tts.ts — local text-to-speech synthesis with a partner-supplied voice.
 *
 * This module owns everything EXCEPT the voice model itself:
 *   - markdown stripping (strips code blocks, links, lists, tables)
 *   - speech prep (expands abbreviations, normalizes numbers, adds
 *     natural pauses at structural boundaries)
 *   - paragraph-boundary chunking for long text
 *   - batch invocation of the partner's synth script
 *   - ffmpeg pipeline: WAV → OGG/Opus with crossfaded chunk joins
 *
 * The voice itself — weights, speaker clone, language model — lives in
 * a partner-supplied Python script at TTS.synthScript. The contract:
 *
 *     python TTS.synthScript <input.txt> <output.wav>
 *     python TTS.synthScript --batch <in1.txt> <out1.wav> <in2.txt> <out2.wav> ...
 *
 * Single-file invocation for short text; batch invocation for chunked
 * long text so the model loads once.
 *
 * Env overrides (all read through constants.ts TTS block):
 *   ALIENKIND_TTS_VOICE, ALIENKIND_TTS_SPEED, ALIENKIND_TTS_MAX_CHARS,
 *   ALIENKIND_TTS_TIMEOUT_MS, ALIENKIND_PYTHON_BIN, ALIENKIND_TTS_SYNTH
 *
 * Graceful degradation: if python or the synth script aren't on disk,
 * registerUnavailable fires at module load and synthesizeVoice returns
 * null instead of throwing. Callers get a signal, not a crash.
 *
 * Usage:
 *   const { synthesizeVoice, synthesizeVoiceChunked } =
 *     require('./tts.ts');
 *   const oggPath = await synthesizeVoice('Hello.');
 *   if (oggPath) { / * send / play / fs.unlinkSync(oggPath) * / }
 *
 * Readers: listener voice-response paths, long-form narration tools,
 * any outbound channel that wants audio as an alternative to text.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { TTS, PATHS } = require('./constants.ts');
const { registerUnavailable } = require('./portable.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

const SYNTH_SCRIPT = resolveRepoPath(TTS.synthScript);
const PYTHON_BIN = resolveRepoPath(TTS.pythonBin);

if (!fs.existsSync(PYTHON_BIN) || !fs.existsSync(SYNTH_SCRIPT)) {
  registerUnavailable('tts', {
    reason: 'Python venv or partner-supplied synth script not on disk — TTS synthesis unavailable.',
    enableWith:
      'Provide a Python script at TTS.synthScript (default scripts/tts-synth.py) that accepts <input.txt> <output.wav> args and optional --batch mode, plus a Python binary at TTS.pythonBin. Override via ALIENKIND_PYTHON_BIN / ALIENKIND_TTS_SYNTH.',
    docs: 'scripts/lib/tts.ts module header.',
  });
}

interface SynthesizeOptions {
  voice?: string;
  speed?: number;
  log?: (...args: any[]) => void;
}

/**
 * Strip markdown formatting so TTS reads natural language, not syntax.
 * Removes code blocks, inline code, bold/italic, strikethrough, links,
 * images, headers, horizontal rules, blockquotes, bullet and numbered
 * lists, HTML tags, tables, and bare URLs. Converts common symbols
 * (emdash, endash, slash, ampersand, percent, dollar amounts) into
 * their spoken equivalents.
 */
function stripMarkdown(text: string): string {
  return text
    // --- Remove markdown structure ---
    .replace(/```[\s\S]*?```/g, '')           // code blocks
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/\*{3}(.+?)\*{3}/g, '$1')        // bold italic
    .replace(/_{3}(.+?)_{3}/g, '$1')
    .replace(/\*{2}(.+?)\*{2}/g, '$1')        // bold
    .replace(/_{2}(.+?)_{2}/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')              // italic
    .replace(/\b_(.+?)_\b/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')              // strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links — keep text, drop URL
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')   // images — remove entirely
    .replace(/^#{1,6}\s+/gm, '')              // headers
    .replace(/^[\s]*([-*_]){3,}\s*$/gm, '')   // horizontal rules
    .replace(/^>\s+/gm, '')                   // blockquotes
    .replace(/^[\s]*[-*+]\s+/gm, '')          // bullet lists
    .replace(/^[\s]*\d+\.\s+/gm, '')          // numbered lists
    .replace(/<[^>]+>/g, '')                  // HTML tags

    // --- Remove tables ---
    .replace(/^\|.*\|$/gm, '')                // table rows
    .replace(/^[-|:\s]+$/gm, '')              // table separators

    // --- Remove URLs first (before slash replacement) ---
    .replace(/https?:\/\/[^\s)]+/g, '')       // bare URLs

    // --- Convert symbols to natural speech ---
    .replace(/—/g, ', ')                      // emdash → comma pause
    .replace(/–/g, ', ')                      // endash → comma pause
    .replace(/\bw\/o\b/g, 'without')          // w/o → "without"
    .replace(/\bw\//g, 'with ')               // w/ → "with"
    .replace(/(\w)\/(month|year|day|week|hour|min|sec|unit|user|person)\b/gi, '$1 per $2')
    .replace(/(\w)\/(\w)/g, '$1 or $2')       // word/word → "word or word"
    .replace(/&/g, ' and ')                   // ampersand → "and"
    .replace(/\+/g, ' plus ')                 // plus sign
    .replace(/%/g, ' percent')                // percent
    .replace(/\$(\d[\d,]*\.?\d*)\s*B\b/gi, '$1 billion dollars')
    .replace(/\$(\d[\d,]*\.?\d*)\s*M\b/gi, '$1 million dollars')
    .replace(/\$(\d[\d,]*\.?\d*)\s*k\b/gi, '$1 thousand dollars')
    .replace(/\$(\d[\d,]*\.?\d*)/g, '$1 dollars')
    .replace(/#(\d)/g, 'number $1')           // # before number → "number"
    .replace(/@(\w)/g, 'at $1')               // @ mentions
    .replace(/\.\.\./g, '. ')                 // ellipsis → period pause
    .replace(/…/g, '. ')                      // unicode ellipsis
    .replace(/[•·]/g, '')                     // bullet chars

    // --- Clean up artifacts ---
    .replace(/\(\s*\)/g, '')                  // empty parens
    .replace(/\[\s*\]/g, '')                  // empty brackets
    .replace(/\s*\|\s*/g, ', ')               // pipes → commas
    .replace(/[{}]/g, '')                     // curly braces
    .replace(/[[\]]/g, '')                    // square brackets
    .replace(/\s{2,}/g, ' ')                  // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')               // collapse multiple newlines
    .trim();
}

/**
 * Prepare cleaned text for natural-sounding speech: expand common
 * abbreviations, spell out technical acronyms letter-by-letter so the
 * TTS doesn't mangle them, insert pauses at paragraph and colon
 * boundaries, and normalize numbers (thousand-separators, units, money).
 */
function prepareForSpeech(text: string): string {
  return text
    // --- Expand common abbreviations ---
    .replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/\be\.g\.\s/gi, 'for example ')
    .replace(/\bi\.e\.\s/gi, 'that is ')
    .replace(/\betc\.\s/gi, 'et cetera ')
    .replace(/\bAPR\b/g, 'A P R')
    .replace(/\bAPI\b/g, 'A P I')
    .replace(/\bUI\b/g, 'U I')
    .replace(/\bAI\b/g, 'A I')
    .replace(/\bTTS\b/g, 'T T S')
    .replace(/\bURL\b/g, 'U R L')
    .replace(/\bSEO\b/g, 'S E O')

    // --- Natural pausing at structure boundaries ---
    .replace(/\n\n/g, '.\n\n')                // paragraph breaks → sentence-ending pause
    .replace(/:\s*\n/g, '.\n')                // colon at line end → pause
    .replace(/;\s/g, '. ')                    // semicolons → sentence pause

    // --- Number readability ---
    .replace(/\$(\d[\d,]*\.?\d*)/g, '$1 dollars')
    .replace(/(\d),(\d{3})\b/g, '$1$2')       // strip thousands commas
    .replace(/(\d+)x\b/g, '$1 times')         // 2x → "2 times"
    .replace(/(\d+)k\b/gi, '$1 thousand')     // 10k → "10 thousand"
    .replace(/(\d+)M\b/g, '$1 million')       // 5M → "5 million"
    .replace(/(\d+)B\b/g, '$1 billion')       // 2B → "2 billion"

    // --- Clean up double periods from transforms ---
    .replace(/\.{2,}/g, '.')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*,/g, '.')
    .trim();
}

const FFMPEG = PATHS.ffmpeg;

/**
 * Synthesize short text to an OGG/Opus file. Returns absolute path to
 * the OGG on success, or null on any failure (missing deps, synth
 * error, ffmpeg error, oversize input). Caller owns the returned file
 * — clean up with fs.unlinkSync after use.
 */
async function synthesizeVoice(
  text: string,
  { voice, speed, log = console.log }: SynthesizeOptions = {},
): Promise<string | null> {
  if (!text || text.trim().length === 0) return null;

  if (text.length > TTS.maxCharsForVoice) {
    log('INFO', `TTS: skipping — text too long (${text.length} > ${TTS.maxCharsForVoice} chars)`);
    return null;
  }

  if (!fs.existsSync(PYTHON_BIN)) {
    log('WARN', `TTS: python not found at ${PYTHON_BIN}`);
    return null;
  }
  if (!fs.existsSync(SYNTH_SCRIPT)) {
    log('WARN', `TTS: synth script not found at ${SYNTH_SCRIPT}`);
    return null;
  }

  const id = crypto.randomBytes(4).toString('hex');
  const inputPath = `/tmp/alienkind-tts-input-${id}.txt`;
  const wavPath = `/tmp/alienkind-tts-out-${id}.wav`;
  const oggPath = `/tmp/alienkind-tts-out-${id}.ogg`;

  const selectedVoice = voice || TTS.defaultVoice;
  const selectedSpeed = speed || TTS.defaultSpeed;

  try {
    const cleanText = prepareForSpeech(stripMarkdown(text));
    if (!cleanText || cleanText.length === 0) return null;

    fs.writeFileSync(inputPath, cleanText, 'utf8');

    execSync(`${PYTHON_BIN} ${SYNTH_SCRIPT} ${inputPath} ${wavPath}`, {
      timeout: TTS.synthesisTimeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });

    if (!fs.existsSync(wavPath)) {
      log('WARN', 'TTS: synth script produced no output WAV');
      return null;
    }

    execSync(`${FFMPEG} -i ${wavPath} -c:a libopus -b:a 64k ${oggPath} -y`, {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!fs.existsSync(oggPath)) {
      log('WARN', 'TTS: ffmpeg produced no output OGG');
      return null;
    }

    const stat = fs.statSync(oggPath);
    log(
      'INFO',
      `TTS: synthesized ${text.length} chars → ${(stat.size / 1024).toFixed(1)}KB OGG (voice=${selectedVoice}, speed=${selectedSpeed})`,
    );
    return oggPath;
  } catch (err: any) {
    log('WARN', `TTS: synthesis failed: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

/**
 * Synthesize long text by chunking at paragraph boundaries (~1000 chars
 * per chunk), invoking the synth script once in --batch mode so the
 * model loads once, trimming trailing silence from each chunk's WAV,
 * then crossfading chunks for seamless joins. Falls back to plain
 * ffmpeg concat if crossfade fails. Returns OGG path or null.
 */
async function synthesizeVoiceChunked(
  text: string,
  { voice, speed, log = console.log }: SynthesizeOptions = {},
): Promise<string | null> {
  if (!text || text.trim().length === 0) return null;

  const cleanText = prepareForSpeech(stripMarkdown(text));
  if (!cleanText || cleanText.length === 0) return null;

  if (cleanText.length <= TTS.maxCharsForVoice) {
    return synthesizeVoice(text, { voice, speed, log });
  }

  if (!fs.existsSync(PYTHON_BIN) || !fs.existsSync(SYNTH_SCRIPT)) {
    log('WARN', 'TTS chunked: python or synth script not found');
    return null;
  }

  const id = crypto.randomBytes(4).toString('hex');

  // Chunk at paragraph boundaries, ~1000 chars each
  const chunks: string[] = [];
  const paragraphs = cleanText.split('\n\n');
  let current = '';
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length > 1000) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
      const sentences = trimmed.match(/[^.!?]+[.!?]+[\s]*/g) || [trimmed];
      for (const sentence of sentences) {
        if (current.length + sentence.length > 1000 && current.length > 0) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current += sentence;
        }
      }
      continue;
    }
    if (current.length + trimmed.length + 2 > 1000 && current.length > 0) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length === 0) return null;

  log('INFO', `TTS chunked: ${cleanText.length} chars → ${chunks.length} chunks`);

  const inputPaths: string[] = [];
  const wavPaths: string[] = [];
  const batchArgs: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const inputPath = `/tmp/alienkind-tts-chunk-${id}-${i}.txt`;
    const wavPath = `/tmp/alienkind-tts-chunk-${id}-${i}.wav`;
    fs.writeFileSync(inputPath, chunks[i], 'utf8');
    inputPaths.push(inputPath);
    wavPaths.push(wavPath);
    batchArgs.push(inputPath, wavPath);
  }

  const oggPath = `/tmp/alienkind-tts-chunked-${id}.ogg`;

  try {
    // Batch synthesis — model loads once for all chunks
    execSync(`${PYTHON_BIN} ${SYNTH_SCRIPT} --batch ${batchArgs.join(' ')}`, {
      timeout: 1200000,  // 20 min cap: model load + N chunks
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });

    for (let i = 0; i < wavPaths.length; i++) {
      if (!fs.existsSync(wavPaths[i])) {
        log('WARN', `TTS chunked: chunk ${i} produced no WAV`);
        return null;
      }
    }

    // Trim trailing silence from each chunk for clean crossfades
    const trimmedPaths: string[] = [];
    for (let i = 0; i < wavPaths.length; i++) {
      const trimmedPath = `/tmp/alienkind-tts-trimmed-${id}-${i}.wav`;
      try {
        execSync(
          `${FFMPEG} -i ${wavPaths[i]} -af "silenceremove=stop_periods=1:stop_duration=0.03:stop_threshold=-50dB" ${trimmedPath} -y`,
          { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        trimmedPaths.push(fs.existsSync(trimmedPath) ? trimmedPath : wavPaths[i]);
      } catch {
        trimmedPaths.push(wavPaths[i]);
      }
    }

    if (trimmedPaths.length === 1) {
      execSync(
        `${FFMPEG} -i ${trimmedPaths[0]} -c:a libopus -b:a 64k ${oggPath} -y`,
        { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } else {
      // Chain acrossfade filters (30ms crossfade between each pair)
      const inputs = trimmedPaths.map(p => `-i ${p}`).join(' ');
      const filterParts: string[] = [];
      for (let i = 1; i < trimmedPaths.length; i++) {
        const outLabel = i < trimmedPaths.length - 1 ? `[a${i}]` : '';
        if (i === 1) {
          filterParts.push(`[0:a][1:a]acrossfade=d=0.03:c1=tri:c2=tri${outLabel}`);
        } else {
          filterParts.push(`[a${i - 1}][${i}:a]acrossfade=d=0.03:c1=tri:c2=tri${outLabel}`);
        }
      }

      try {
        execSync(
          `${FFMPEG} ${inputs} -filter_complex "${filterParts.join(';')}" -c:a libopus -b:a 64k ${oggPath} -y`,
          { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (crossfadeErr: any) {
        // Fallback to plain concat if crossfade filter fails
        log('WARN', `TTS chunked: crossfade failed (${crossfadeErr.message}), falling back to concat`);
        const listPath = `/tmp/alienkind-tts-concat-${id}.txt`;
        fs.writeFileSync(listPath, trimmedPaths.map(p => `file '${p}'`).join('\n'), 'utf8');
        execSync(
          `${FFMPEG} -f concat -safe 0 -i ${listPath} -c:a libopus -b:a 64k ${oggPath} -y`,
          { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        try { fs.unlinkSync(listPath); } catch {}
      }
    }

    trimmedPaths.forEach(p => {
      if (p.includes('trimmed')) {
        try { fs.unlinkSync(p); } catch {}
      }
    });

    if (!fs.existsSync(oggPath)) {
      log('WARN', 'TTS chunked: ffmpeg produced no output');
      return null;
    }

    const stat = fs.statSync(oggPath);
    log(
      'INFO',
      `TTS chunked: ${cleanText.length} chars → ${chunks.length} chunks → ${(stat.size / 1024).toFixed(1)}KB OGG`,
    );
    return oggPath;
  } catch (err: any) {
    log('WARN', `TTS chunked: synthesis failed: ${err.message}`);
    return null;
  } finally {
    inputPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    wavPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  }
}

module.exports = {
  synthesizeVoice,
  synthesizeVoiceChunked,
  stripMarkdown,
  prepareForSpeech,
};
