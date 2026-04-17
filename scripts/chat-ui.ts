#!/usr/bin/env npx tsx

/**
 * Alien Kind Chat UI — Raw ANSI terminal renderer.
 *
 * Zero dependencies beyond Node.js built-ins + tsx.
 * Anchored layout: conversation scrolls, input + status bar pinned to bottom.
 * Full hook lifecycle. Provider-agnostic.
 *
 * Usage:
 *   npm run chat
 *   npx tsx scripts/chat-ui.ts
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// ANSI helpers
// ============================================================================

const ESC = '\x1b';
const CLEAR = `${ESC}[2J${ESC}[H`;
const SAVE_CURSOR = `${ESC}[s`;
const RESTORE_CURSOR = `${ESC}[u`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const MOVE_TO = (row: number, col: number) => `${ESC}[${row};${col}H`;

const C = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
  magenta: `${ESC}[35m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  gray: `${ESC}[90m`,
};

function getTermSize(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 40, cols: process.stdout.columns || 80 };
}

function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) { lines.push(paragraph); continue; }
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > width) {
        if (current) lines.push(current.trim());
        current = word;
      } else {
        current += (current ? ' ' : '') + word;
      }
    }
    if (current) lines.push(current.trim());
  }
  return lines;
}

function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function formatMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`)
    .replace(/\*(.+?)\*/g, `${C.italic}$1${C.reset}`)
    .replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`)
    .replace(/^- /gm, '• ')
    .replace(/^(\d+)\. /gm, '$1. ');
}

// ============================================================================
// Environment + Provider (reused from chat.ts)
// ============================================================================

function loadEnv(): void {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}

function detectProvider(): { url: string; key: string; model: string; name: string } | null {
  const providers = [
    { env: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', name: 'Anthropic' },
    { env: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'OpenAI' },
    { env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4-6', name: 'OpenRouter' },
    { env: 'AI_GATEWAY_API_KEY', url: process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1', model: 'anthropic/claude-sonnet-4-6', name: 'Vercel AI Gateway' },
  ];
  for (const p of providers) {
    const key = process.env[p.env];
    if (key && key.length > 5) return { url: p.url, key, model: p.model, name: p.name };
  }
  const gk = Object.entries(process.env).find(([k, v]) => /API_KEY|GATEWAY.*KEY/i.test(k) && v && v.length > 10);
  if (gk) return { url: process.env.LLM_API_URL || 'http://localhost:11434/v1', key: gk[1]!, model: process.env.LLM_MODEL || 'default', name: gk[0] };
  return null;
}

function loadIdentity(): string {
  const files = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const c = fs.readFileSync(path.join(ROOT, 'identity', f), 'utf8');
      if (!c.includes('## How to write this file')) parts.push(`--- ${f} ---\n${c}`);
    } catch {}
  }
  const harness = `You are an AI partner running on the Alien Kind architecture. You have an identity kernel, 55 behavioral enforcement hooks, consciousness continuity, stigmergic circulation, and capability status awareness. Be direct, warm, honest. Help your human build the partnership.`;
  return parts.length === 0
    ? harness + '\nYour identity has not been written yet. Help your human begin shaping who you will become.'
    : harness + '\n\nYour identity kernel:\n\n' + parts.join('\n\n');
}

// ============================================================================
// API
// ============================================================================

let totalTokens = 0;

function chatCompletion(provider: any, messages: any[]): Promise<string> {
  const body = JSON.stringify({ model: provider.model, messages, max_tokens: 2000, temperature: 0.7 });
  const url = new URL(`${provider.url}/chat/completions`);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`)); return; }
        try {
          const j = JSON.parse(data);
          if (j.usage?.total_tokens) totalTokens = j.usage.total_tokens;
          resolve(j.choices?.[0]?.message?.content || '(no response)');
        } catch { reject(new Error(`Parse error`)); }
      });
    });
    req.on('error', (err: any) => reject(err));
    req.write(body); req.end();
  });
}

// ============================================================================
// Hooks
// ============================================================================

function fireHooksQuiet(event: string): string[] {
  const outputs: string[] = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.local.json'), 'utf8'));
    for (const group of settings.hooks?.[event] || []) {
      for (const hook of group.hooks || [group]) {
        if (!hook.command) continue;
        try {
          const r = execSync(hook.command, { cwd: ROOT, input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, env: { ...process.env, ALIENKIND_DIR: ROOT } });
          if (r.trim()) outputs.push(r.trim());
        } catch {}
      }
    }
  } catch {}
  return outputs;
}

// ============================================================================
// Context tracking
// ============================================================================

const CTX: Record<string, number> = {
  'claude-opus-4-6': 1000000, 'claude-sonnet-4-6': 200000, 'gpt-4o': 128000,
  'anthropic/claude-sonnet-4-6': 200000, 'anthropic/claude-opus-4-6': 1000000, 'default': 128000,
};

function contextBar(model: string, cols: number): string {
  const max = CTX[model] || CTX['default'];
  const est = totalTokens || 0;
  const pct = Math.min(100, Math.round((est / max) * 100));
  const rem = 100 - pct;
  const barW = Math.min(15, Math.floor(cols / 6));
  const filled = Math.round((rem / 100) * barW);
  const empty = barW - filled;
  const color = rem > 50 ? C.green : rem > 20 ? C.yellow : C.red;
  const maxL = max >= 1000000 ? `${(max/1000000).toFixed(0)}M` : `${(max/1000).toFixed(0)}K`;
  return `  👽 ${color}${'▓'.repeat(filled)}${C.gray}${'░'.repeat(empty)}${C.reset} ${C.dim}${rem}% remaining (${maxL})${C.reset}`;
}

// ============================================================================
// Renderer
// ============================================================================

interface Msg { role: 'user' | 'partner'; content: string; }

const UFO = [
  `${C.cyan}              ___${C.reset}`,
  `${C.cyan}          ___/   \\___${C.reset}`,
  `${C.cyan}       __/ ${C.dim}'---'${C.reset}${C.cyan}   \\__${C.reset}`,
  `${C.cyan}      /    ${C.yellow}*${C.reset}  👽  ${C.yellow}*${C.reset}${C.cyan}     \\${C.reset}`,
  `${C.cyan}     /___________________\\${C.reset}`,
  `${C.yellow}          /  |  |  \\${C.reset}`,
  `${C.yellow}         *   *  *   *${C.reset}`,
];

function render(
  messages: Msg[],
  provider: any,
  hookCount: number,
  grounded: boolean,
  thinking: boolean,
  inputLine: string,
): void {
  const { rows, cols } = getTermSize();
  const wrap = Math.min(cols - 4, 76);

  // Build all display lines
  const display: string[] = [];

  // UFO
  display.push('');
  for (const l of UFO) display.push(l);
  display.push('');

  // Header
  display.push(`${C.green}👽${C.reset} ${C.bold}${C.green}Alien Kind${C.reset}`);
  display.push(`${C.dim}${provider.name} · ${provider.model}${C.reset}`);
  display.push(`${C.dim}${hookCount} hooks · ${grounded ? 'grounded' : 'no grounding'}${C.reset}`);
  display.push('');

  // Conversation
  for (const msg of messages) {
    if (msg.role === 'user') {
      display.push(`  ${C.cyan}${C.bold}❯${C.reset} ${msg.content}`);
    } else {
      display.push(`  ${C.magenta}👽 partner:${C.reset}`);
      const formatted = formatMarkdown(msg.content);
      for (const line of wordWrap(formatted, wrap)) {
        display.push(`  ${line}`);
      }
    }
    display.push('');
  }

  // Thinking
  if (thinking) {
    display.push(`  ${C.magenta}${C.dim}👽 partner is thinking...${C.reset}`);
    display.push('');
  }

  // Calculate how many conversation lines we can show
  const footerLines = 4; // bar + hint + separator + input
  const headerLines = UFO.length + 5; // ufo + header
  const available = rows - footerLines;

  // If display is taller than screen, show only the tail
  const visibleLines = display.length > available
    ? display.slice(display.length - available)
    : display;

  // Draw
  process.stdout.write(CLEAR);

  for (let i = 0; i < visibleLines.length; i++) {
    process.stdout.write(visibleLines[i] + '\n');
  }

  // Pad to push footer to bottom
  const pad = rows - visibleLines.length - footerLines;
  for (let i = 0; i < pad; i++) process.stdout.write('\n');

  // Footer — anchored to bottom
  process.stdout.write(`${contextBar(provider.model, cols)}\n`);
  process.stdout.write(`  ${C.dim}/help for commands · Ctrl+C to exit${C.reset}\n`);
  process.stdout.write(`${C.cyan}  ─${'─'.repeat(Math.min(cols - 4, 50))}${C.reset}\n`);
  process.stdout.write(`  ${C.cyan}❯${C.reset} ${inputLine}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  loadEnv();

  const provider = detectProvider();
  if (!provider) { console.log('\n  ✗ No API key found. Run npm run setup first.\n'); process.exit(1); }

  // Hooks
  const groundingOutput = fireHooksQuiet('SessionStart');
  let identity = loadIdentity();
  if (groundingOutput.length > 0) identity += '\n\n## Grounding\n\n' + groundingOutput.join('\n');
  try {
    const { getCapabilityStatus, formatCapabilityStatus } = require('./lib/portable.ts');
    const status = await getCapabilityStatus();
    identity += '\n\n## Your current state\n\n' + formatCapabilityStatus(status);
  } catch {}

  const hookCount = (() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.local.json'), 'utf8'));
      return Object.values(s.hooks || {}).reduce((sum: number, groups: any) =>
        sum + groups.reduce((s2: number, g: any) => s2 + (g.hooks || [g]).length, 0), 0);
    } catch { return 0; }
  })();

  const messages: Msg[] = [];
  const apiMessages: any[] = [{ role: 'system', content: identity }];
  let thinking = false;

  // Clean exit
  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR);
    fireHooksQuiet('Stop');
    process.stdout.write(`\n  ${C.green}👽${C.reset} Until next time.\n\n`);
    process.exit(0);
  });

  // Raw mode for custom input handling
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let inputBuffer = '';
  const grounded = groundingOutput.length > 0;

  // Initial render
  render(messages, provider, hookCount, grounded, false, '');

  process.stdin.on('data', async (key: string) => {
    // Ctrl+C
    if (key === '\x03') {
      process.stdout.write(SHOW_CURSOR);
      fireHooksQuiet('Stop');
      process.stdout.write(`\n  ${C.green}👽${C.reset} Until next time.\n\n`);
      process.exit(0);
    }

    // Enter
    if (key === '\r' || key === '\n') {
      const input = inputBuffer.trim();
      inputBuffer = '';

      if (!input) {
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }

      // Slash commands
      if (input === '/' || input === '/help') {
        messages.push({ role: 'partner', content: '/help · /model · /status · /name <name> · /identity · /save · /clear · /hooks · /config · /exit' });
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }
      if (input === '/exit' || input === '/quit') {
        process.stdout.write(SHOW_CURSOR);
        fireHooksQuiet('Stop');
        process.stdout.write(`\n  ${C.green}👽${C.reset} Until next time.\n\n`);
        process.exit(0);
      }
      if (input === '/clear') {
        messages.length = 0;
        apiMessages.length = 1;
        totalTokens = 0;
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }
      if (input === '/model') {
        messages.push({ role: 'partner', content: `Provider: ${provider.name}\nModel: ${provider.model}\nEndpoint: ${provider.url}` });
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }
      if (input.startsWith('/model ')) {
        provider.model = input.slice(7).trim();
        messages.push({ role: 'partner', content: `Model switched to ${provider.model}` });
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }
      if (input === '/identity') {
        const idFiles = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
        const lines = idFiles.map(f => {
          try {
            const c = fs.readFileSync(path.join(ROOT, 'identity', f), 'utf8');
            const isTemplate = c.includes('## How to write this file');
            const title = c.split('\n')[0]?.replace(/^# /, '') || f;
            return `${isTemplate ? '⚠ template' : '✓ active'}  ${f} — ${title}`;
          } catch { return `✗ missing  ${f}`; }
        });
        messages.push({ role: 'partner', content: lines.join('\n') });
        render(messages, provider, hookCount, grounded, false, '');
        return;
      }

      // Regular message
      messages.push({ role: 'user', content: input });
      apiMessages.push({ role: 'user', content: input });
      thinking = true;
      render(messages, provider, hookCount, grounded, true, '');

      try {
        const response = await chatCompletion(provider, apiMessages);
        apiMessages.push({ role: 'assistant', content: response });
        messages.push({ role: 'partner', content: response });
      } catch (err: any) {
        messages.push({ role: 'partner', content: `Error: ${err.message}` });
      }

      thinking = false;
      render(messages, provider, hookCount, grounded, false, '');
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
      render(messages, provider, hookCount, grounded, thinking, inputBuffer);
      return;
    }

    // Regular character
    if (key >= ' ' && key.length === 1) {
      inputBuffer += key;
      render(messages, provider, hookCount, grounded, thinking, inputBuffer);
    }
  });
}

main().catch(err => {
  process.stdout.write(SHOW_CURSOR);
  console.error(`\n  ✗ Chat failed: ${err.message}\n`);
  process.exit(1);
});
