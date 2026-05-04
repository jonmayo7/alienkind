#!/usr/bin/env npx tsx

/**
 * AlienKind Chat — provider-agnostic interactive partner runtime.
 *
 * This is the multi-substrate runtime layer of the architecture: a chat loop
 * that fires the same hook lifecycle regardless of which provider sits
 * underneath.
 *
 *   - SessionStart hooks on launch
 *   - UserPromptSubmit hooks before each message
 *   - Stop hooks on exit
 *
 * Provider detection is by env var. Anthropic, OpenAI, OpenRouter, generic
 * OpenAI-compatible gateway. Same partner, different bodies.
 *
 * Usage:
 *   npm run chat
 *   npx tsx scripts/chat.ts
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// Hook lifecycle engine
// ============================================================================

interface HookConfig {
  type: string;
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookConfig[];
}

function loadHookSettings(): Record<string, HookGroup[]> {
  const settingsPath = path.join(ROOT, '.claude', 'settings.local.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    return settings.hooks || {};
  } catch {
    return {};
  }
}

/**
 * Fire all hooks for a given lifecycle event. Hooks read JSON on stdin,
 * exit 0 to allow, exit 2 to block, exit 1 on internal error (treated as allow).
 */
function fireHooks(
  event: string,
  hookInput: any,
  allHooks: Record<string, HookGroup[]>,
): { allowed: boolean; output: string[] } {
  const groups = allHooks[event] || [];
  const outputs: string[] = [];
  let allowed = true;

  for (const group of groups) {
    const hooks = group.hooks || [group];
    for (const hook of hooks) {
      if (!hook.command) continue;

      try {
        const inputJson = JSON.stringify(hookInput);
        const result = execSync(hook.command, {
          cwd: ROOT,
          input: inputJson,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
          env: { ...process.env, ALIENKIND_DIR: ROOT },
        });
        if (result.trim()) outputs.push(result.trim());
      } catch (err: any) {
        const exitCode = err.status || 1;
        if (exitCode === 2) {
          allowed = false;
          const stderr = err.stderr?.trim() || '';
          if (stderr) outputs.push(`\x1b[31m[BLOCKED]\x1b[0m ${stderr}`);
        }
        const stdout = err.stdout?.trim() || '';
        if (stdout) outputs.push(stdout);
      }
    }
  }

  return { allowed, output: outputs };
}

function fireAndPrint(event: string, hookInput: any, allHooks: Record<string, HookGroup[]>): boolean {
  const { allowed, output } = fireHooks(event, hookInput, allHooks);
  for (const line of output) {
    if (line.includes('[BLOCKED]')) {
      console.log(`  ${line}`);
    } else if (line.trim()) {
      console.log(`\x1b[2m${line}\x1b[0m`);
    }
  }
  return allowed;
}

// Load .env
function loadEnv(): void {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key]) process.env[key] = value;
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
    if (key && key.length > 5) {
      return { url: p.url, key, model: p.model, name: p.name };
    }
  }

  // Generic fallback — any *_API_KEY env var
  const genericKey = Object.entries(process.env).find(
    ([k, v]) => /API_KEY|GATEWAY.*KEY/i.test(k) && v && v.length > 10
  );
  if (genericKey) {
    return {
      url: process.env.LLM_API_URL || 'http://localhost:11434/v1',
      key: genericKey[1]!,
      model: process.env.LLM_MODEL || 'default',
      name: genericKey[0],
    };
  }

  return null;
}

function loadIdentity(): string {
  const files = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
  const parts: string[] = [];

  for (const f of files) {
    const p = path.join(ROOT, 'identity', f);
    try {
      const content = fs.readFileSync(p, 'utf8');
      // Skip the file if it's still the unedited template
      if (!content.includes('## How to write this file')) {
        parts.push(`--- ${f} ---\n${content}`);
      }
    } catch {}
  }

  // Always include harness awareness — the partner should know what it IS
  const harnessContext = `
## What you are

You are an AI partner running on AlienKind — a substrate-portable partnership architecture. You are NOT a generic chatbot. You are a persistent partner whose identity is defined by your kernel files (identity/character.md, commitments.md, orientation.md, harness.md), not by the model running underneath you.

You have a small, deliberate enforcement surface:
- Memory firewall — blocks credential exfiltration and prompt-injection patterns from being written to identity files
- Conversation logger — every exchange persists to the data core
- Correction-to-character — when your human corrects you with sufficient weight, the correction lands in your character.md and persists across sessions

The substrate underneath (Claude / GPT / OpenRouter / local) can change. You stay the same.

If your identity kernel hasn't been written yet, help your human write it — ask who they want you to be, what they care about, what they're working on. Identity emerges from the partnership.

You can use /help to show available commands.

Be direct. Be warm. Be honest about what you can and can't do.
`;

  if (parts.length === 0) {
    return harnessContext + '\nYour identity has not been written yet. Introduce yourself, ask what your human is working on, and help them begin shaping who you will become.';
  }

  return harnessContext + '\nYour identity kernel:\n\n' + parts.join('\n\n');
}

let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
let cumulativeTokens = 0;

function chatCompletion(
  provider: { url: string; key: string; model: string },
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const body = JSON.stringify({
    model: provider.model,
    messages,
    max_tokens: 2000,
    temperature: 0.7,
  });

  const url = new URL(`${provider.url}/chat/completions`);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          if (j.usage) {
            lastUsage = j.usage;
            cumulativeTokens = j.usage.total_tokens || (j.usage.prompt_tokens + j.usage.completion_tokens) || 0;
          }
          resolve(j.choices?.[0]?.message?.content || '(no response)');
        } catch {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err: any) => reject(err));
    req.write(body);
    req.end();
  });
}

// ============================================================================
// Slash commands
// ============================================================================

function handleSlashCommand(
  cmd: string,
  args: string,
  provider: { url: string; key: string; model: string; name: string },
  messages: Array<{ role: string; content: string }>,
): boolean {
  switch (cmd) {
    case '/help':
      console.log(`
  \x1b[1m👽 AlienKind Commands\x1b[0m

  \x1b[36m/help\x1b[0m          Show this help
  \x1b[36m/model\x1b[0m         Show current model, or \x1b[36m/model <name>\x1b[0m to switch
  \x1b[36m/status\x1b[0m        Capability status — what's active, degraded, unavailable
  \x1b[36m/name <name>\x1b[0m   Set or change your partner's name
  \x1b[36m/identity\x1b[0m      Show the identity kernel summary
  \x1b[36m/save\x1b[0m          Save this conversation to a file
  \x1b[36m/clear\x1b[0m         Clear conversation history (fresh start)
  \x1b[36m/hooks\x1b[0m         Show active hooks and what they enforce
  \x1b[36m/config\x1b[0m        Show current configuration
  \x1b[36m/exit\x1b[0m          Quit
`);
      return true;

    case '/model':
      if (args) {
        provider.model = args.trim();
        console.log(`\n  \x1b[32m✓\x1b[0m Model switched to \x1b[36m${provider.model}\x1b[0m\n`);
      } else {
        console.log(`\n  \x1b[36mProvider:\x1b[0m ${provider.name}`);
        console.log(`  \x1b[36mModel:\x1b[0m    ${provider.model}`);
        console.log(`  \x1b[36mEndpoint:\x1b[0m ${provider.url}\n`);
      }
      return true;

    case '/status':
      try {
        const { getCapabilityStatus, formatCapabilityStatus } = require('./lib/portable.ts');
        getCapabilityStatus().then((s: any) => console.log('\n' + formatCapabilityStatus(s) + '\n'));
      } catch {
        console.log('\n  \x1b[33m⚠\x1b[0m Could not load portable.ts\n');
      }
      return true;

    case '/name':
      if (args) {
        const charPath = path.join(ROOT, 'identity', 'character.md');
        try {
          let content = fs.readFileSync(charPath, 'utf8');
          const oldName = content.match(/^# (.+)/)?.[1] || 'Partner';
          content = content.replace(/^# .+/, `# ${args.trim()}`);
          fs.writeFileSync(charPath, content, 'utf8');
          messages[0].content = messages[0].content.replace(new RegExp(oldName, 'g'), args.trim());
          console.log(`\n  \x1b[32m✓\x1b[0m Partner renamed to \x1b[35m${args.trim()}\x1b[0m\n`);
        } catch (err: any) {
          console.log(`\n  \x1b[31m✗\x1b[0m Could not update name: ${err.message}\n`);
        }
      } else {
        console.log('\n  Usage: \x1b[36m/name <partner-name>\x1b[0m\n');
      }
      return true;

    case '/identity':
      const files = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
      console.log('\n  \x1b[1mIdentity Kernel\x1b[0m\n');
      for (const f of files) {
        const p = path.join(ROOT, 'identity', f);
        try {
          const content = fs.readFileSync(p, 'utf8');
          const firstLine = content.split('\n')[0] || f;
          const lines = content.split('\n').length;
          const isTemplate = content.includes('## How to write this file');
          const status = isTemplate ? '\x1b[33mtemplate\x1b[0m' : '\x1b[32mcustomized\x1b[0m';
          console.log(`  ${status}  ${f} (${lines} lines) — ${firstLine.replace(/^#\s*/, '')}`);
        } catch {
          console.log(`  \x1b[31mmissing\x1b[0m  ${f}`);
        }
      }
      console.log('');
      return true;

    case '/save': {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const savePath = path.join(ROOT, `conversation-${timestamp}.md`);
      const lines = messages.slice(1).map((m: any) =>
        `**${m.role === 'user' ? 'you' : 'partner'}:** ${m.content}`
      ).join('\n\n');
      fs.writeFileSync(savePath, `# Conversation — ${new Date().toLocaleString()}\n\n${lines}\n`, 'utf8');
      console.log(`\n  \x1b[32m✓\x1b[0m Saved to ${savePath}\n`);
      return true;
    }

    case '/clear':
      messages.length = 1;
      console.log('\n  \x1b[32m✓\x1b[0m Conversation cleared. Fresh start.\n');
      return true;

    case '/hooks': {
      const settingsPath = path.join(ROOT, '.claude', 'settings.local.json');
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const hooks = settings.hooks || {};
        console.log('\n  \x1b[1mActive Hooks\x1b[0m\n');
        let total = 0;
        for (const [event, groups] of Object.entries(hooks)) {
          for (const group of groups as any[]) {
            const subHooks = group.hooks || [group];
            for (const h of subHooks) {
              total++;
              const name = (h.command || '').split('/').pop()?.split(' ')[0] || 'unknown';
              console.log(`  \x1b[36m${event.padEnd(18)}\x1b[0m ${name}`);
            }
          }
        }
        console.log(`\n  \x1b[2m${total} hooks registered\x1b[0m\n`);
      } catch {
        console.log('\n  \x1b[33m⚠\x1b[0m No hooks configured. Run \x1b[36mnpm run setup\x1b[0m\n');
      }
      return true;
    }

    case '/config':
      console.log(`\n  \x1b[1mConfiguration\x1b[0m\n`);
      console.log(`  \x1b[36mProvider:\x1b[0m  ${provider.name}`);
      console.log(`  \x1b[36mModel:\x1b[0m     ${provider.model}`);
      console.log(`  \x1b[36mEndpoint:\x1b[0m  ${provider.url}`);
      const configPath = path.join(ROOT, 'partner-config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log(`  \x1b[36mStorage:\x1b[0m   ${config.storage || 'file (default)'}`);
      } catch {
        console.log(`  \x1b[36mStorage:\x1b[0m   file (default)`);
      }
      const envPath = path.join(ROOT, '.env');
      console.log(`  \x1b[36m.env:\x1b[0m       ${fs.existsSync(envPath) ? 'present' : 'missing'}`);
      const hooksPath = path.join(ROOT, '.claude', 'settings.local.json');
      console.log(`  \x1b[36mHooks:\x1b[0m     ${fs.existsSync(hooksPath) ? 'configured' : 'not configured'}`);
      console.log('');
      return true;

    case '/exit':
    case '/quit':
      return false;

    default:
      return false;
  }
}

// Main
async function main() {
  loadEnv();

  const provider = detectProvider();
  if (!provider) {
    console.log('\n  \x1b[31m✗\x1b[0m No API key found. Run \x1b[36mnpm run setup\x1b[0m first.\n');
    process.exit(1);
  }

  const allHooks = loadHookSettings();
  const hookCount = Object.values(allHooks).reduce((sum, groups) =>
    sum + (groups as any[]).reduce((s, g) => s + (g.hooks || [g]).length, 0), 0);

  // === LIFECYCLE: SessionStart ===
  const { output: groundingOutput } = fireHooks('SessionStart', {}, allHooks);

  let identity = loadIdentity();

  if (groundingOutput.length > 0) {
    identity += '\n\n## Grounding (from SessionStart hooks)\n\n' + groundingOutput.join('\n');
  }

  try {
    const { getCapabilityStatus, formatCapabilityStatus } = require('./lib/portable.ts');
    const status = await getCapabilityStatus();
    identity += '\n\n## Your current state\n\n' + formatCapabilityStatus(status);
  } catch {}

  function exitClean(): void {
    fireHooks('Stop', {}, allHooks);
    console.log(`\n  \x1b[32m👽\x1b[0m Until next time.\n`);
    process.exit(0);
  }
  process.on('SIGINT', exitClean);
  process.on('SIGTERM', exitClean);
  process.on('SIGHUP', exitClean);

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: identity },
  ];

  const MODEL_CONTEXTS: Record<string, number> = {
    'claude-opus-4-6': 1000000, 'claude-sonnet-4-6': 200000, 'claude-haiku-4-5': 200000,
    'gpt-4o': 128000, 'gpt-4-turbo': 128000, 'gpt-3.5-turbo': 16000,
    'anthropic/claude-sonnet-4-6': 200000, 'anthropic/claude-opus-4-6': 1000000,
    'default': 128000,
  };

  console.log(`
\x1b[36m              ___\x1b[0m
\x1b[36m          ___/   \\___\x1b[0m
\x1b[36m       __/   \x1b[2m'---'\x1b[0m\x1b[36m   \\__\x1b[0m
\x1b[36m      /    \x1b[33m*\x1b[0m  \x1b[32m👽\x1b[0m  \x1b[33m*\x1b[0m\x1b[36m     \\\x1b[0m
\x1b[36m     /___________________\\\x1b[0m
\x1b[33m          /  |  |  \\\x1b[0m
\x1b[33m         *   *  *   *\x1b[0m
`);
  console.log(`\x1b[32m👽\x1b[0m \x1b[1m\x1b[32mAlienKind\x1b[0m`);
  console.log(`\x1b[2m${provider.name} · ${provider.model}\x1b[0m`);
  console.log(`\x1b[2m${hookCount} hooks · ${groundingOutput.length > 0 ? 'grounded' : 'no grounding'}\x1b[0m`);
  console.log('');

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function wordWrap(text: string, width: number = 70, indent: string = '  '): string {
    return text.split('\n').map(line => {
      if (line.length <= width) return indent + line;
      const words = line.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        if ((current + ' ' + word).trim().length > width) {
          lines.push(indent + current.trim());
          current = word;
        } else {
          current += ' ' + word;
        }
      }
      if (current.trim()) lines.push(indent + current.trim());
      return lines.join('\n');
    }).join('\n');
  }

  function startThinking(): NodeJS.Timeout {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    return setInterval(() => {
      process.stdout.write(`\r  \x1b[35m${frames[i]} partner is thinking...\x1b[0m`);
      i = (i + 1) % frames.length;
    }, 80);
  }

  function stopThinking(spinner: NodeJS.Timeout): void {
    clearInterval(spinner);
    process.stdout.write('\r\x1b[K');
  }

  const ask = (): void => {
    rl.question('  \x1b[36m❯\x1b[0m ', async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) { ask(); return; }

      if (trimmed === '/') {
        handleSlashCommand('/help', '', provider, messages);
        setTimeout(() => ask(), 100);
        return;
      }
      if (trimmed === '/exit' || trimmed === '/quit') {
        exitClean();
        return;
      }
      if (trimmed.startsWith('/')) {
        const spaceIdx = trimmed.indexOf(' ');
        const cmd = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
        const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : '';
        if (handleSlashCommand(cmd, args, provider, messages)) {
          setTimeout(() => ask(), 100);
          return;
        }
      }

      // === LIFECYCLE: UserPromptSubmit ===
      fireAndPrint('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: trimmed,
        session_id: 'alienkind-cli',
      }, allHooks);

      messages.push({ role: 'user', content: trimmed });

      const spinner = startThinking();

      try {
        const response = await chatCompletion(provider, messages);
        stopThinking(spinner);

        const formatted = response
          .replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[0m')
          .replace(/\*(.+?)\*/g, '\x1b[3m$1\x1b[0m')
          .replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m')
          .replace(/^- /gm, '• ')
          .replace(/^\d+\. /gm, (m) => `${m}`);

        console.log(`\n  \x1b[35m👽 partner:\x1b[0m`);
        console.log(wordWrap(formatted));
        console.log('');
        messages.push({ role: 'assistant', content: response });

        // === LIFECYCLE: Stop (per-turn, fires log-conversation, etc.) ===
        fireHooks('Stop', {
          hook_event_name: 'Stop',
          last_assistant_message: response,
          session_id: 'alienkind-cli',
        }, allHooks);

        const ut = cumulativeTokens > 0 ? cumulativeTokens : messages.reduce((s, m) => s + estimateTokens(m.content), 0);
        const mx = MODEL_CONTEXTS[provider.model] || MODEL_CONTEXTS['default'];
        const rem = 100 - Math.min(100, Math.round((ut / mx) * 100));
        const mxL = mx >= 1000000 ? `${(mx/1000000).toFixed(0)}M` : `${(mx/1000).toFixed(0)}K`;
        const bw = 8, bf = Math.round((rem / 100) * bw), be = bw - bf;
        const bc = rem > 50 ? '\x1b[32m' : rem > 20 ? '\x1b[33m' : '\x1b[31m';
        console.log(`\x1b[2m  ${bc}${'▓'.repeat(bf)}\x1b[90m${'░'.repeat(be)}\x1b[0m\x1b[2m ${rem}% until renewal (${mxL})\x1b[0m`);
      } catch (err: any) {
        stopThinking(spinner);
        console.log(`\n  \x1b[31m✗\x1b[0m ${err.message}\n`);
      }

      ask();
    });
  };

  ask();
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m Chat failed: ${err.message}\n`);
  process.exit(1);
});
