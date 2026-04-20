#!/usr/bin/env node

/**
 * Log terminal session conversations to Supabase.
 *
 * Wired as a Claude Code hook for two events:
 *   - UserPromptSubmit → logs the human's prompt (role=user, sender=human)
 *   - Stop             → logs Keel's response (role=assistant, sender=keel)
 *
 * Fire-and-forget: always exits 0 so it never blocks the session.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Infrastructure deps — degrade gracefully on a fresh fork
let getActiveTerminals: any, updateFocus: any, logLearning: any, detectCorrection: any, buildPatternName: any, supabaseGet: any;
try {
  getActiveTerminals = require(path.resolve(__dirname, '..', 'lib', 'terminal-sessions.ts')).getActiveTerminals;
  updateFocus = require(path.resolve(__dirname, '..', 'lib', 'mycelium.ts')).updateFocus;
  const ll = require(path.resolve(__dirname, '..', 'lib', 'learning-ledger.ts'));
  logLearning = ll.logLearning;
  detectCorrection = ll.detectCorrection;
  buildPatternName = ll.buildPatternName;
  supabaseGet = require(path.resolve(__dirname, '..', 'lib', 'supabase.ts')).supabaseGet;
} catch {
  getActiveTerminals = () => [];
  updateFocus = () => {};
  logLearning = async () => {};
  detectCorrection = () => null;
  buildPatternName = () => '';
  supabaseGet = async () => [];
}

// --- Load Environment (same pattern as discord-listener.ts) ---
const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ALIENKIND_DIR, '.env');

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val.replace(/[\r\n\u2028\u2029]+/g, '');
  }
  return env;
}

// --- Supabase POST (same pattern as discord-listener.ts logConversation) ---
function supabasePost(envVars, table, data, prefer = 'return=minimal') {
  if (!envVars.SUPABASE_URL || !envVars.SUPABASE_SERVICE_KEY) return;

  const body = JSON.stringify(data);
  const url = new URL(`${envVars.SUPABASE_URL}/rest/v1/${table}`);
  const options = {
    method: 'POST',
    headers: {
      'apikey': envVars.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${envVars.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer,
    },
  };
  const req = https.request(url, options, (res) => { res.resume(); });
  req.on('error', () => { /* silent */ });
  req.write(body);
  req.end();
}

// Dedup — prevents duplicate inserts within 5 seconds for same channel+sender+content.
// Uses a shared file because each hook invocation is a separate process.
const DEDUP_FILE = path.join(ALIENKIND_DIR, 'logs', 'conversation-dedup.json');
const DEDUP_WINDOW_MS = 5000;

function isDuplicate(dedupKey: string): boolean {
  const now = Date.now();
  try {
    if (!fs.existsSync(DEDUP_FILE)) return false;
    const entries: Record<string, number> = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    return entries[dedupKey] && (now - entries[dedupKey]) < DEDUP_WINDOW_MS;
  } catch { return false; }
}

function recordDedup(dedupKey: string): void {
  const now = Date.now();
  try {
    let entries: Record<string, number> = {};
    try { entries = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')); } catch {}
    // Prune entries older than 30 seconds
    for (const key of Object.keys(entries)) {
      if (now - entries[key] > 30000) delete entries[key];
    }
    entries[dedupKey] = now;
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(entries));
  } catch { /* best-effort */ }
}

// --- Keel Intelligence Engine: message index tracking ---
const MSG_IDX_DIR = path.join(ALIENKIND_DIR, 'logs');

function getNextMessageIndex(termId: string): number {
  const file = path.join(MSG_IDX_DIR, `keel-msg-idx-${termId}.txt`);
  try {
    const current = parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
    fs.writeFileSync(file, String(current + 1));
    return current + 1;
  } catch {
    try { fs.writeFileSync(file, '1'); } catch {}
    return 1;
  }
}

function logConversation(envVars, { channel, role, sender, content, visibility = 'private', metadata = {}, terminal_id = null, model = null }) {
  if (!content || content.trim().length === 0) return;

  // Dedup: skip if same channel+sender+content within 5 seconds
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(content).digest('hex');
  const dedupKey = `${channel}|${sender}|${hash}`;

  if (isDuplicate(dedupKey)) return;
  recordDedup(dedupKey);

  const row: any = { channel, visibility, role, sender, content, metadata };
  if (terminal_id) row.terminal_id = terminal_id;
  if (model) row.model = model;
  supabasePost(envVars, 'conversations', row, 'return=minimal,resolution=ignore-duplicates');

  // --- Conversation cache for agent-grounding.ts ---
  // Write recent terminal messages to a local cache file so the agent grounding
  // hook doesn't need to curl Supabase on every spawn. Cache is append-only,
  // trimmed to last 20 messages. Eliminates network dependency from the hook.
  if (channel === 'terminal') {
    try {
      const cachePath = path.join(ALIENKIND_DIR, 'logs', 'recent-conversation-cache.json');
      let messages: any[] = [];
      try {
        if (fs.existsSync(cachePath)) {
          messages = JSON.parse(fs.readFileSync(cachePath, 'utf8')).messages || [];
        }
      } catch { messages = []; }
      messages.push({ role, content: (content || '').slice(0, 500), created_at: new Date().toISOString() });
      if (messages.length > 20) messages = messages.slice(-20);
      fs.writeFileSync(cachePath, JSON.stringify({ messages, cached_at: new Date().toISOString() }));
    } catch { /* non-critical */ }
  }
}

/**
 * Extract model from transcript JSONL. Same approach as log-terminal-compute.ts.
 * Returns the most-used model in the transcript, or 'claude-opus-4-6' as default.
 */
function extractModelFromTranscript(transcriptPath: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 'claude-opus-4-6';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const modelCounts: Record<string, number> = {};
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.model) {
          const m = obj.message.model;
          modelCounts[m] = (modelCounts[m] || 0) + 1;
        }
      } catch { continue; }
    }
    let best = 'claude-opus-4-6';
    let bestCount = 0;
    for (const [m, c] of Object.entries(modelCounts)) {
      if (c > bestCount) { best = m; bestCount = c; }
    }
    return best;
  } catch {
    return 'claude-opus-4-6';
  }
}

function logExperience(envVars, { observation, domain, significance, tags, sourceChannel, sessionId }) {
  if (!observation || !domain) {
    if (typeof console !== 'undefined') console.warn(`[log-conversation] logExperience skipped: missing ${!observation ? 'observation' : 'domain'}`);
    return;
  }
  supabasePost(envVars, 'experiences', {
    observation,
    domain,
    significance: significance || 5,
    tags: tags || null,
    source_channel: sourceChannel || 'terminal',
    session_id: sessionId || null,
    orientation_relevant: false,
  });
}

// --- Automated Prompt Detection ---
// Automated sessions (social engine, growth engine, proactive scans, listener spawns)
// send system-instruction-style prompts that should not be logged as sender=human.
// These patterns match the opening lines of known automated prompt templates.
const AUTOMATED_PREFIXES = [
  'You are posting as ',              // social growth engine
  "You are Keel — the human's AI partner. You're scanning",  // proactive scan
  "You are Keel — the human's AI partner. This is a Telegram", // telegram listener
  "You are Keel — the human's AI partner. This is a Discord",  // discord listener
  'You are Keel, processing a ',      // growth engine findings
  'You are Keel. It is ',             // keel cycle / operator mode
  "You are Keel — the human's AI partner. Process this",  // action router
  'HEARTBEAT BRIEF',                  // heartbeat
  'CONTENT PIPELINE',                 // content pipeline
  "You are Keel — the human's AI partner. Review", // review responder
  'You are Keel. You are responding in ',          // keel-engine channel prompts
  '<task-notification',                            // subagent completion notifications
];

function detectAutomatedPrompt(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return AUTOMATED_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function classifyAutomationSource(prompt: string): string {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith('You are posting as ')) return 'social-engine';
  if (trimmed.includes('scanning for pr')) return 'proactive-scan';
  if (trimmed.includes('This is a Telegram')) return 'telegram-listener';
  if (trimmed.includes('This is a Discord')) return 'discord-listener';
  if (trimmed.startsWith('You are Keel, processing a ')) return 'growth-engine';
  if (trimmed.startsWith('You are Keel. You are responding in ')) return 'keel-engine';
  if (trimmed.includes('Process this')) return 'action-router';
  if (trimmed.startsWith('HEARTBEAT')) return 'heartbeat';
  if (trimmed.startsWith('CONTENT PIPELINE')) return 'content-pipeline';
  if (trimmed.includes('Review')) return 'review-responder';
  return 'automated';
}

// --- Main ---
async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const envVars = loadEnv();
  Object.assign(process.env, envVars); // Intelligence engine module reads process.env
  const event = hookData.hook_event_name;
  const sessionId = hookData.session_id || null;

  // Resolve terminal ID for per-terminal conversation tagging
  let terminalId = 'terminal';
  try {
    const { getTerminalId } = require(path.resolve(__dirname, '..', 'lib', 'terminal-state.ts'));
    terminalId = getTerminalId();
  } catch {
    // Fallback: use PID-based ID
    const pid = process.ppid || process.pid;
    terminalId = `terminal-${pid}`;
  }
  // Concurrent terminal awareness: count active terminals for metadata
  let terminalCount = 1;
  try {
    terminalCount = getActiveTerminals().length || 1;
  } catch { /* default to 1 */ }

  if (event === 'UserPromptSubmit') {
    const prompt = hookData.prompt;
    if (prompt) {
      // Detect automated system prompts vs human messages.
      // Automated spawns (social engine, growth engine, proactive scans, listener DM sessions)
      // pass system-instruction-style prompts that aren't the human's messages.
      const isAutomated = detectAutomatedPrompt(prompt);
      const sender = isAutomated ? 'system' : 'human';
      const automationSource = isAutomated ? classifyAutomationSource(prompt) : null;

      // Automated prompts (keel cycles, proactive scans, growth engine) are 160-177KB each.
      // Storing full prompts wastes ~17MB/day in Supabase. Truncate to first 200 chars
      // and record original size in metadata. Human messages are stored in full.
      const MAX_AUTOMATED_CONTENT = 200;
      const contentToStore = isAutomated && prompt.length > MAX_AUTOMATED_CONTENT
        ? prompt.slice(0, MAX_AUTOMATED_CONTENT) + `\n[TRUNCATED: ${(prompt.length / 1024).toFixed(0)}KB original]`
        : prompt;

      // Single write with terminal_id as a first-class column.
      // No more dual-write hack — filter by terminal_id column, not channel name.
      logConversation(envVars, {
        channel: 'terminal',
        role: 'user',
        sender,
        content: contentToStore,
        terminal_id: terminalId,
        metadata: {
          session_id: sessionId,
          ...(isAutomated ? {
            automated: true,
            automation_source: automationSource,
            original_content_bytes: Buffer.byteLength(prompt, 'utf8'),
          } : {}),
        },
      });
      // --- Keel Intelligence Engine: dual-log user messages ---
      if (!isAutomated) {
        try {
          const msgIdx = getNextMessageIndex(terminalId);
          supabasePost(envVars, 'keel_steward_conversations', {
            session_id: terminalId,
            message_index: msgIdx,
            role: 'user',
            content: (prompt || '').slice(0, 10000),
            page_context: 'terminal',
          });
        } catch { /* intelligence engine is best-effort */ }
      }

      // Mycelium: write the human's prompt as terminal focus
      // MUST use terminalId (from getTerminalId) — NOT raw pid.
      // Raw pid = claude's PID. terminalId = keel.sh's assigned ID.
      // Other hooks use getTerminalId() to READ the focus file.
      // If we WRITE with raw pid, they can never find it.
      updateFocus(terminalId, { type: 'terminal', focus: prompt.slice(0, 150), pid: process.ppid || process.pid });

      // Mycelium steward: auto-label terminal via local model (vLLM-MLX 7B).
      // Classifies what this terminal is working on. Runs when:
      //   1. First real message (>50 chars) and no label exists, OR
      //   2. Substantial message (>100 chars) and label is >10 minutes old (context may have shifted)
      // Under 1 second per classification, zero cost (local inference).
      if (!isAutomated && prompt.length > 50) {
        try {
          const { getTerminal, setLabel } = require(path.resolve(__dirname, '..', 'lib', 'terminal-state.ts'));
          const row = await getTerminal(terminalId);
          const hasLabel = row && row.execution_context;
          const labelAge = hasLabel ? Date.now() - new Date(row.updated_at).getTime() : Infinity;
          const RELABEL_AFTER_MS = 10 * 60 * 1000; // 10 minutes

          // Classify if: no label, OR substantial message after label is stale
          const shouldClassify = !hasLabel || (prompt.length > 100 && labelAge > RELABEL_AFTER_MS);

          if (row && shouldClassify) {
            const { localClassify } = require('../lib/local-inference.ts');
            const labelPrompt = hasLabel
              ? `This terminal was labeled "${row.execution_context}". Based on the latest message, update the label in 3-5 words if the topic changed. If the topic is the same, reply with the same label. ONLY the label: ${prompt.slice(0, 300)}`
              : `Label this terminal session in 3-5 words. ONLY the label, nothing else: ${prompt.slice(0, 300)}`;
            // Fire and forget — labeling never blocks conversation logging.
            localClassify(labelPrompt, { maxTokens: 20, timeoutMs: 3000, fallback: '' })
              .then((label: string) => {
                if (label && label.length > 2 && label.length < 60) {
                  if (!hasLabel || label !== row.execution_context) {
                    setLabel(terminalId, label).catch(() => {});
                  }
                }
              })
              .catch(() => { /* best-effort */ });
          }
        } catch { /* never block conversation logging */ }
      }

      // Learning ledger: detect corrections/reinforcements (human messages only)
      // Automated prompts contain embedded conversation history (daily file excerpts,
      // thread snippets) that trigger false positive correction detection.
      const detection = isAutomated ? null : detectCorrection(prompt);
      if (detection) {
        // Populate process.env for supabase.ts (used by logLearning)
        Object.assign(process.env, envVars);
        const patternName = buildPatternName(detection);
        // Extract the human's actual message for storage (strip system preamble)
        let actualMessage = prompt;
        const humanMsgMarker = prompt.lastIndexOf("the human's message:");
        if (humanMsgMarker !== -1) {
          actualMessage = prompt.slice(humanMsgMarker + "the human's message:".length).trim();
        }
        // AAR 7.1: Get Keel's last response from conversations table
        let keelResponse: string | null = null;
        try {
          const rows = await supabaseGet(
            'conversations',
            `select=content&channel=eq.terminal&sender=eq.keel&order=created_at.desc&limit=1`
          );
          if (rows && rows.length > 0 && rows[0].content) {
            keelResponse = rows[0].content.slice(0, 2000);
          }
        } catch { /* non-fatal */ }

        const correctionSlice = actualMessage.slice(0, 500);
        // Log correction with keel's triggering response. should_have synthesis
        // runs in nightly batch (one Claude call for all unsynthesized corrections)
        // instead of per-correction real-time spawning.
        logLearning({
          patternName,
          correctionText: correctionSlice,
          sourceChannel: 'terminal',
          sessionId: sessionId,
          category: 'behavioral',
          sentiment: detection.sentiment,
          severity: detection.severity,
          keelResponse: keelResponse || undefined,
        }).catch(() => {});

        // Keel Intelligence Engine: corrections/reinforcements feed discernment
        try {
          const { updateDiscernmentDirect } = require(path.resolve(__dirname, '..', 'lib', 'intelligence-engine-keel.ts'));
          const isHelpful = detection.sentiment === 'reinforcement';
          updateDiscernmentDirect(correctionSlice, isHelpful, correctionSlice.slice(0, 500));
        } catch { /* best-effort */ }

        // VGE: Real-time correction propagation
        // When the human corrects a fact, emit event + write correction marker
        // so other terminals see the correction within minutes, not next nightly cycle
        if (detection.sentiment === 'correction') {
          try {
            // 1. Emit system event for cross-AIRE propagation
            const { emitEvent } = require(path.resolve(__dirname, '..', 'lib', 'event-store.ts'));
            emitEvent('correction.detected', 'log-conversation', {
              pattern: patternName,
              correction: correctionSlice,
              severity: detection.severity,
              terminal_id: terminalId,
              session_id: sessionId,
            }).catch(() => {});

            // 2. Write correction to shared file for immediate cross-terminal visibility
            // Other terminals read this via mycelium awareness hooks
            const correctionFile = path.join(ALIENKIND_DIR, 'logs', 'recent-corrections.json');
            let corrections = [];
            try {
              corrections = JSON.parse(fs.readFileSync(correctionFile, 'utf8'));
              // Keep last 20 corrections, prune older than 24h
              const dayAgo = Date.now() - 86400000;
              corrections = corrections.filter((c: any) => c.timestamp > dayAgo).slice(-19);
            } catch { corrections = []; }
            corrections.push({
              pattern: patternName,
              correction: correctionSlice,
              terminal: terminalId,
              timestamp: Date.now(),
              severity: detection.severity,
            });
            fs.writeFileSync(correctionFile, JSON.stringify(corrections, null, 2));

            // 3. If correction contains numbers, trigger ground truth check
            // to catch stale-snapshot-class errors in real-time
            const hasNumbers = /\b\d{2,}\b/.test(correctionSlice);
            const hasDataWords = /transcript|count|subscriber|post|article|job|hook|librar/i.test(correctionSlice);
            if (hasNumbers && hasDataWords) {
              // Fire ground truth check asynchronously (don't block the hook)
              const { execSync } = require('child_process');
              try {
                execSync('npx tsx scripts/ground-truth-check.ts --json > /dev/null 2>&1 &', {
                  cwd: ALIENKIND_DIR,
                  timeout: 5000,
                  stdio: 'ignore',
                });
              } catch { /* async fire-and-forget */ }
            }
          } catch { /* VGE propagation is best-effort, never blocks the hook */ }
        }
      }
    }
  } else if (event === 'Stop') {
    const lastMsg = hookData.last_assistant_message;
    if (lastMsg) {
      // Extract model from transcript — same data source as log-terminal-compute.ts
      const model = extractModelFromTranscript(hookData.transcript_path || '');

      // Single write with terminal_id and model as first-class columns.
      logConversation(envVars, {
        channel: 'terminal',
        role: 'assistant',
        sender: 'keel',
        content: lastMsg,
        terminal_id: terminalId,
        model,
        metadata: { session_id: sessionId, concurrent_terminals: terminalCount, model },
      });

      // --- Keel Intelligence Engine: dual-log + gap detection ---
      try {
        const msgIdx = getNextMessageIndex(terminalId);
        supabasePost(envVars, 'keel_steward_conversations', {
          session_id: terminalId,
          message_index: msgIdx,
          role: 'assistant',
          content: (lastMsg || '').slice(0, 10000),
          model,
          page_context: 'terminal',
        });

        // Gap detection: get last user message, fire detection on both
        const lastUserRows = await supabaseGet(
          'conversations',
          'select=content&channel=eq.terminal&role=eq.user&sender=eq.human&order=created_at.desc&limit=1'
        );
        const lastUserMsg = lastUserRows?.[0]?.content || '';
        const { detectCapabilityGap, updateSession } = require(path.resolve(__dirname, '..', 'lib', 'intelligence-engine-keel.ts'));
        detectCapabilityGap(lastUserMsg, lastMsg, terminalId);

        // Session tracking: update keel_steward_sessions per terminal
        updateSession(terminalId).catch(() => {});
      } catch { /* intelligence engine is best-effort, never blocks */ }

      // Log terminal interaction as experience for calibration layer.
      // Terminal is the richest work channel — this closes the gap where
      // terminal sessions were invisible to experiences.
      const responseLen = lastMsg.length;
      const isLong = responseLen > 2000;
      logExperience(envVars, {
        observation: `Terminal interaction: ${responseLen} chars response${isLong ? ' (extended)' : ''}`,
        domain: 'interaction',
        significance: isLong ? 6 : 4,
        tags: ['terminal', 'interactive'],
        sourceChannel: 'terminal',
        sessionId: sessionId,
      });
    }
  }

  // Let pending HTTP requests drain. Supabase round-trip from [LOCATION] is
  // ~280ms. 500ms gives safe margin. Never had issues at this value.
  setTimeout(() => process.exit(0), 500);
}

main().catch(() => process.exit(0));
