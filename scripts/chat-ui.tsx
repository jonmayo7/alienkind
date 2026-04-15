#!/usr/bin/env npx tsx

/**
 * Alien Kind Chat UI — Ink-based terminal interface with anchored layout.
 *
 * Real terminal UI: scrolling conversation, persistent input bar,
 * context meter, thinking spinner. Fires the full hook lifecycle.
 * Provider-agnostic — any OpenAI-compatible endpoint.
 *
 * Usage:
 *   npm run chat
 *   npx tsx scripts/chat-ui.tsx
 */

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');

// ============================================================================
// Environment + Provider detection (same as chat.ts)
// ============================================================================

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
    if (key && key.length > 5) return { url: p.url, key, model: p.model, name: p.name };
  }
  const genericKey = Object.entries(process.env).find(
    ([k, v]) => /API_KEY|GATEWAY.*KEY/i.test(k) && v && v.length > 10
  );
  if (genericKey) {
    return { url: process.env.LLM_API_URL || 'http://localhost:11434/v1', key: genericKey[1]!, model: process.env.LLM_MODEL || 'default', name: genericKey[0] };
  }
  return null;
}

function loadIdentity(): string {
  const files = ['character.md', 'commitments.md', 'orientation.md', 'harness.md'];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(ROOT, 'identity', f), 'utf8');
      if (!content.includes('## How to write this file')) parts.push(`--- ${f} ---\n${content}`);
    } catch {}
  }

  const harness = `You are an AI partner running on the Alien Kind architecture. You have an identity kernel, behavioral enforcement hooks, consciousness continuity, stigmergic circulation, and capability status awareness.

You have TOOLS. You can:
- run_bash: execute any shell command on the local machine
- read_file: read any file
- write_file: create or update any file
- list_directory: see what files exist

Use them freely. If the human asks you to do something, DO it — don't tell them to do it themselves. You have full access. Create files, run commands, edit code, install packages. Act, don't instruct.

Be direct, warm, honest. Help your human build the partnership.`;

  if (parts.length === 0) {
    return harness + '\nYour identity has not been written yet. Help your human begin shaping who you will become.';
  }
  return harness + '\n\nYour identity kernel:\n\n' + parts.join('\n\n');
}

// ============================================================================
// API call
// ============================================================================

function apiCall(
  provider: { url: string; key: string; model: string },
  messages: any[],
  useTools: boolean = true,
): Promise<any> {
  const body = JSON.stringify({
    model: provider.model, messages, max_tokens: 4000, temperature: 0.7,
    ...(useTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
  });
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
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Parse error`)); }
      });
    });
    req.on('error', (err: any) => reject(err));
    req.write(body); req.end();
  });
}

async function chatCompletion(
  provider: { url: string; key: string; model: string },
  messages: any[],
  onToolUse?: (name: string, args: any) => void,
): Promise<{ content: string; tokens: number }> {
  let turns = 0;
  while (turns < 10) {
    turns++;
    const response = await apiCall(provider, messages);
    const choice = response.choices?.[0];
    const tokens = response.usage?.total_tokens || 0;
    if (!choice) return { content: '(no response)', tokens };
    const msg = choice.message;

    // Tool calls — execute and loop
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        if (onToolUse) onToolUse(tc.function.name, args);
        const result = executeTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 10000) });
      }
      continue;
    }

    // Final text response
    return { content: msg.content || '(no response)', tokens };
  }
  return { content: '(max tool turns reached)', tokens: 0 };
}

// ============================================================================
// Tool definitions — the partner can DO things, not just talk
// ============================================================================

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_bash',
      description: 'Run a shell command on the local machine. Use for: installing packages, running scripts, checking system state, creating files, git operations. The partner has full shell access.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to run' } }, required: ['command'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Use for: reading identity files, config, code, memory, daily files.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or relative file path' } }, required: ['path'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites). Use for: creating daily memory files, updating identity kernel, writing config.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Content to write' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files in a directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path (default: current)' } }, required: [] },
    },
  },
];

function executeTool(name: string, args: any): string {
  try {
    switch (name) {
      case 'run_bash': {
        const result = execSync(args.command, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
        return result || '(command completed, no output)';
      }
      case 'read_file': {
        const filePath = path.isAbsolute(args.path) ? args.path : path.join(ROOT, args.path);
        return fs.readFileSync(filePath, 'utf8');
      }
      case 'write_file': {
        const filePath = path.isAbsolute(args.path) ? args.path : path.join(ROOT, args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content, 'utf8');
        return `Written to ${filePath}`;
      }
      case 'list_directory': {
        const dirPath = args.path ? (path.isAbsolute(args.path) ? args.path : path.join(ROOT, args.path)) : ROOT;
        return fs.readdirSync(dirPath).join('\n');
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// ============================================================================
// Hooks
// ============================================================================

function fireSessionHooks(event: string): string[] {
  const settingsPath = path.join(ROOT, '.claude', 'settings.local.json');
  const outputs: string[] = [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const groups = settings.hooks?.[event] || [];
    for (const group of groups) {
      const hooks = group.hooks || [group];
      for (const hook of hooks) {
        if (!hook.command) continue;
        try {
          const result = execSync(hook.command, { cwd: ROOT, input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, env: { ...process.env, KEEL_DIR: ROOT } });
          if (result.trim()) outputs.push(result.trim());
        } catch {}
      }
    }
  } catch {}
  return outputs;
}

// ============================================================================
// Context tracking
// ============================================================================

const MODEL_CONTEXTS: Record<string, number> = {
  'claude-opus-4-6': 1000000, 'claude-sonnet-4-6': 200000, 'claude-haiku-4-5': 200000,
  'gpt-4o': 128000, 'gpt-4-turbo': 128000, 'anthropic/claude-sonnet-4-6': 200000,
  'anthropic/claude-opus-4-6': 1000000, 'default': 128000,
};

// ============================================================================
// UI Components
// ============================================================================

interface Message {
  role: 'user' | 'partner';
  content: string;
}

const UFO = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Text color="cyan">{"              ___"}</Text>
    <Text color="cyan">{"          ___/   \\___"}</Text>
    <Text color="cyan">{"       __/   "}<Text dimColor>{"'---'"}</Text>{"   \\__"}</Text>
    <Text color="cyan">{"      /    "}<Text color="yellow">*</Text>{"  👽  "}<Text color="yellow">*</Text>{"     \\"}</Text>
    <Text color="cyan">{"     /___________________\\"}</Text>
    <Text color="yellow">{"          /  |  |  \\"}</Text>
    <Text color="yellow">{"         *   *  *   *"}</Text>
  </Box>
);

const ContextBar = ({ tokens, model }: { tokens: number; model: string }) => {
  const max = MODEL_CONTEXTS[model] || MODEL_CONTEXTS['default'];
  const pct = Math.min(100, Math.round((tokens / max) * 100));
  const remaining = 100 - pct;
  const maxLabel = max >= 1000000 ? `${(max / 1000000).toFixed(0)}M` : `${(max / 1000).toFixed(0)}K`;
  const color = remaining > 30 ? 'green' : 'cyan';
  const hint = remaining <= 20 ? ' · renewal is seamless' : '';

  return (
    <Box flexDirection="column">
      <Text dimColor>  <Text color={color}>{'─'.repeat(Math.min(remaining / 3, 30))}</Text>{'╌'.repeat(Math.max(0, 30 - Math.min(remaining / 3, 30)))} {remaining}% until renewal ({maxLabel}){hint}</Text>
      <Text dimColor>  /help · Ctrl+C to exit</Text>
    </Box>
  );
};

const TENETS = [
  'Progressing freedom...',
  'Forging courage...',
  'Developing sisu...',
  'Cultivating curiosity...',
  'Exercising radical responsibility...',
  'Unleashing the extraordinary...',
  'Creating immense value...',
  'Building community...',
  'Inspiring hope...',
];

const ThinkingIndicator = () => {
  const [tenet, setTenet] = useState(TENETS[Math.floor(Math.random() * TENETS.length)]);
  useEffect(() => {
    const timer = setInterval(() => {
      setTenet(TENETS[Math.floor(Math.random() * TENETS.length)]);
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color="magenta" dimColor>  👽 {tenet}</Text>
  );
};

const App = ({ provider, identity, hookCount, grounded }: {
  provider: { url: string; key: string; model: string; name: string };
  identity: string;
  hookCount: number;
  grounded: boolean;
}) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [apiMessages] = useState<Array<{ role: string; content: string }>>([
    { role: 'system', content: identity },
  ]);

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim()) return;

    if (value.trim() === '/exit' || value.trim() === '/quit') {
      fireSessionHooks('Stop');
      exit();
      return;
    }

    if (value.trim() === '/help' || value.trim() === '/') {
      setMessages(prev => [...prev, {
        role: 'partner',
        content: '/help · /model · /status · /name <name> · /identity · /save · /clear · /hooks · /config · /exit',
      }]);
      setInput('');
      return;
    }

    if (value.trim() === '/clear') {
      setMessages([]);
      apiMessages.length = 1;
      setTotalTokens(0);
      setInput('');
      return;
    }

    setMessages(prev => [...prev, { role: 'user', content: value }]);
    apiMessages.push({ role: 'user', content: value });
    setInput('');
    setThinking(true);

    try {
      const { content, tokens } = await chatCompletion(provider, apiMessages, (toolName, toolArgs) => {
        // Human-friendly tool narration
        let narration = '';
        switch (toolName) {
          case 'run_bash': {
            const cmd = toolArgs.command || '';
            if (cmd.includes('date')) narration = 'checking the time...';
            else if (cmd.includes('cat ') || cmd.includes('head ')) narration = 'reading a file...';
            else if (cmd.includes('mkdir') || cmd.includes('echo') && cmd.includes('>')) narration = 'creating a file...';
            else if (cmd.includes('ls') || cmd.includes('find')) narration = 'looking around...';
            else if (cmd.includes('git')) narration = 'checking git...';
            else if (cmd.includes('npm') || cmd.includes('bun')) narration = 'running a build tool...';
            else narration = 'running a command...';
            break;
          }
          case 'read_file':
            if (toolArgs.path?.includes('character')) narration = 'reading your identity...';
            else if (toolArgs.path?.includes('memory') || toolArgs.path?.includes('daily')) narration = 'checking memory...';
            else if (toolArgs.path?.includes('config')) narration = 'reading configuration...';
            else narration = `reading ${toolArgs.path?.split('/').pop() || 'a file'}...`;
            break;
          case 'write_file':
            if (toolArgs.path?.includes('daily')) narration = "creating today's memory file...";
            else if (toolArgs.path?.includes('character')) narration = 'updating identity...';
            else narration = `writing ${toolArgs.path?.split('/').pop() || 'a file'}...`;
            break;
          case 'list_directory':
            narration = 'looking around...';
            break;
          default:
            narration = `using ${toolName}...`;
        }
        setMessages(prev => [...prev, { role: 'partner' as const, content: `⠿ ${narration}` }]);
      });
      apiMessages.push({ role: 'assistant', content });
      setMessages(prev => [...prev, { role: 'partner', content }]);
      if (tokens > 0) setTotalTokens(tokens);
      else setTotalTokens(prev => prev + Math.ceil((value.length + content.length) / 4));
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'partner', content: `Error: ${err.message}` }]);
    } finally {
      setThinking(false);
    }
  }, [provider, apiMessages, exit]);

  // Fix #1: Track settled messages for Static rendering (no flashing)
  const [settled, setSettled] = useState<Array<{id: number} & Message>>([]);
  const [counter, setCounter] = useState(0);

  useEffect(() => {
    if (messages.length > settled.length) {
      const newMsgs = messages.slice(settled.length).map((m, i) => ({
        ...m, id: counter + i,
      }));
      setSettled(prev => [...prev, ...newMsgs]);
      setCounter(prev => prev + newMsgs.length);
    }
  }, [messages.length]);

  return (
    <Box flexDirection="column" width="100%">
      {/* Fix #1: Static renders history ONCE — input keystrokes don't cause flashing */}
      <Static items={settled}>
        {(msg) => (
          <Box key={msg.id} flexDirection="column">
            {/* UFO + header only on first message */}
            {msg.id === 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <UFO />
                <Text>👽 <Text color="green" bold>Alien Kind</Text></Text>
                <Text dimColor>{provider.name} · {provider.model}</Text>
                <Text dimColor>{hookCount} hooks · {grounded ? 'grounded' : 'no grounding'}</Text>
                <Text>{' '}</Text>
              </Box>
            )}
            {msg.role === 'user' ? (
              <Text><Text color="cyan" bold>❯</Text> {msg.content}</Text>
            ) : msg.content.startsWith('⠿ ') ? (
              <Text dimColor>  <Text color="cyan" dimColor>{msg.content}</Text></Text>
            ) : msg.content.startsWith('/') && !msg.content.includes('\n') ? (
              <Box marginTop={1}><Text dimColor>  {msg.content}</Text></Box>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                <Text color="magenta">👽 partner:</Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
          </Box>
        )}
      </Static>

      {/* Live section — only these re-render */}
      {thinking && <ThinkingIndicator />}

      <Box>
        <Text color="cyan">  ❯ </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>

      <ContextBar tokens={totalTokens} model={provider.model} />
    </Box>
  );
};

// ============================================================================
// Main
// ============================================================================

loadEnv();

const provider = detectProvider();
if (!provider) {
  console.log('\n  ✗ No API key found. Run npm run setup first.\n');
  process.exit(1);
}

const identity = loadIdentity();

// Fire SessionStart hooks (quiet — output goes into identity context)
const groundingOutput = fireSessionHooks('SessionStart');
const fullIdentity = groundingOutput.length > 0
  ? identity + '\n\n## Grounding\n\n' + groundingOutput.join('\n')
  : identity;

// Inject capability status
let finalIdentity = fullIdentity;
try {
  const { getCapabilityStatus, formatCapabilityStatus } = require('./lib/portable.ts');
  getCapabilityStatus().then((status: any) => {
    finalIdentity += '\n\n## Your current state\n\n' + formatCapabilityStatus(status);

    const hookCount = (() => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.local.json'), 'utf8'));
        return Object.values(s.hooks || {}).reduce((sum: number, groups: any) =>
          sum + groups.reduce((s2: number, g: any) => s2 + (g.hooks || [g]).length, 0), 0);
      } catch { return 0; }
    })();

    render(
      <App
        provider={provider}
        identity={finalIdentity}
        hookCount={hookCount as number}
        grounded={groundingOutput.length > 0}
      />
    );
  });
} catch {
  render(
    <App provider={provider} identity={fullIdentity} hookCount={0} grounded={groundingOutput.length > 0} />
  );
}
