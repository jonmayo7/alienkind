/**
 * Emergency Tool Execution + Hook Dispatch
 *
 * Provides the same tool capabilities as Claude Code (Read, Edit, Write, Bash,
 * Glob, Grep) and fires the same hooks from settings.local.json.
 *
 * The hook dispatcher reads settings.local.json at startup — when hooks are
 * added to Claude Code, they automatically appear here. Zero maintenance.
 *
 * Tool definitions are in OpenAI function calling format for the gateway.
 * Tool execution is local (fs, child_process, glob, ripgrep).
 *
 * Readers: keel-emergency.ts, shared.ts (invokeEmergency)
 * Writers: none (stateless — executes tools and hooks, returns results)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { spawnSync } = require('child_process');

const ALIENKIND_DIR = path.resolve(__dirname, '../..');

// --- Hook Dispatcher ---
// Uses keel-hooks.ts library — reads from config/hooks.ts (canonical source).
// Same hooks, same scripts, same exit code semantics as Claude Code.
// No more reading settings.local.json — that file is GENERATED, not the source.

const { dispatchHooks: fireHooks, loadConfig: loadHookConfig } = require('./keel-hooks.ts');

interface HookPayload {
  session_id: string;
  tool_input?: Record<string, any>;
  tool_output?: string;
}

interface HookResult {
  blocked: boolean;
  output: string;
}

// --- Tool Definitions (OpenAI function calling format) ---
// These are the tools the LLM can call. Defined once, used by gateway.

const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file from the filesystem. Returns the file content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to read' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist. Overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file with a new string. The old_string must appear exactly once in the file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          old_string: { type: 'string', description: 'The exact text to find and replace' },
          new_string: { type: 'string', description: 'The replacement text' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return its output. Use for git, node, npm, system commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for files matching a glob pattern. Returns a list of matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g., "scripts/**/*.ts", "*.md")' },
          path: { type: 'string', description: 'Directory to search in. Defaults to project root.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_content',
      description: 'Search file contents using a regex pattern (ripgrep). Returns matching lines with file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'File or directory to search. Defaults to project root.' },
          glob: { type: 'string', description: 'Optional glob filter (e.g., "*.ts")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_query',
      description: 'Query Supabase REST API. Supports GET (select), POST (insert), PATCH (update), DELETE.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP method' },
          path: { type: 'string', description: 'REST path after /rest/v1/ (e.g., "articles?select=id,title&limit=10")' },
          body: { type: 'string', description: 'JSON body for POST/PATCH requests' },
        },
        required: ['method', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_telegram',
      description: 'Send a message to [HUMAN] via Telegram DM.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message text to send' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'google_calendar',
      description: 'Interact with Google Calendar. Actions: list (upcoming events), create, update, delete.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Calendar action' },
          days: { type: 'number', description: 'For list: number of days ahead (default 3)' },
          summary: { type: 'string', description: 'For create/update: event title' },
          start: { type: 'string', description: 'For create/update: start time ISO string' },
          end: { type: 'string', description: 'For create/update: end time ISO string' },
          event_id: { type: 'string', description: 'For update/delete: event ID' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail',
      description: 'Interact with Gmail. Actions: search, read, send, reply.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'read', 'send', 'reply'], description: 'Gmail action' },
          query: { type: 'string', description: 'For search: Gmail search query' },
          message_id: { type: 'string', description: 'For read/reply: message ID' },
          to: { type: 'string', description: 'For send: recipient email' },
          subject: { type: 'string', description: 'For send: email subject' },
          body: { type: 'string', description: 'For send/reply: email body' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web using in-house SearxNG. Returns search results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Returns the page text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          prompt: { type: 'string', description: 'Optional: what to extract from the page' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'post_to_x',
      description: 'Post a tweet to X (Twitter). Supports [HUMAN] ([@YOUR_HANDLE]) or Keel ([@PARTNER_HANDLE]) accounts.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Tweet text' },
          account: { type: 'string', enum: ['[human_first]', 'keel'], description: 'Which account to post from (default: [human_first])' },
          media: { type: 'string', description: 'Optional: path to media file to attach' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'post_to_linkedin',
      description: 'Post to LinkedIn.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Post text' },
          media: { type: 'string', description: 'Optional: path to media file to attach' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_send',
      description: 'Send a message to a Discord channel or user.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Channel name or user to send to' },
          message: { type: 'string', description: 'Message text' },
        },
        required: ['target', 'message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'google_drive',
      description: 'Interact with Google Drive. Actions: search, list, get, download, export.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'list', 'get', 'download', 'export'], description: 'Drive action' },
          query: { type: 'string', description: 'For search: search query' },
          file_id: { type: 'string', description: 'For get/download/export: file ID' },
          folder_id: { type: 'string', description: 'For list: folder ID' },
          output_path: { type: 'string', description: 'For download/export: local output path' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_search',
      description: 'Search Keel memory files using full-text search with temporal decay.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          type: { type: 'string', description: 'Optional: filter by type (daily, research, etc.)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'notion',
      description: 'Interact with Notion. Actions: search, page, database, query, blocks, create-page, update-page.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'page', 'database', 'query', 'blocks', 'create-page', 'update-page'], description: 'Notion action' },
          query: { type: 'string', description: 'For search: search text' },
          id: { type: 'string', description: 'Page/database/block ID' },
          title: { type: 'string', description: 'For create-page: page title' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'asana',
      description: 'Interact with Asana. Actions: projects, tasks, task, create, update, complete, comment, search.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['projects', 'tasks', 'task', 'create', 'update', 'complete', 'comment', 'search'], description: 'Asana action' },
          project_id: { type: 'string', description: 'For tasks/create: project ID' },
          task_id: { type: 'string', description: 'For task/update/complete/comment: task ID' },
          name: { type: 'string', description: 'For create: task name' },
          text: { type: 'string', description: 'For comment: comment text' },
          query: { type: 'string', description: 'For search: search query' },
        },
        required: ['action'],
      },
    },
  },
];

// --- Tool Execution ---
// Maps tool names to Claude Code equivalents for hook dispatch.

const TOOL_TO_CLAUDE_CODE: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Bash',
  search_files: 'Glob',
  search_content: 'Grep',
  supabase_query: 'Bash',
  send_telegram: 'Bash',
  google_calendar: 'Bash',
  gmail: 'Bash',
  web_search: 'Bash',
  web_fetch: 'Bash',
  post_to_x: 'Bash',
  post_to_linkedin: 'Bash',
  discord_send: 'Bash',
  google_drive: 'Bash',
  memory_search: 'Bash',
  notion: 'Bash',
  asana: 'Bash',
};

interface ToolExecResult {
  output: string;
  hookOutput: string;
  blocked: boolean;
}

function executeTool(
  toolName: string,
  args: Record<string, any>,
  sessionId: string,
  log: (level: string, msg: string) => void
): ToolExecResult {
  const claudeToolName = TOOL_TO_CLAUDE_CODE[toolName] || toolName;
  let hookOutput = '';

  // --- PreToolUse hooks ---
  const prePayload: HookPayload = { session_id: sessionId, tool_input: args };
  const preResult = fireHooks('PreToolUse', claudeToolName, prePayload, log);
  hookOutput += preResult.output;

  if (preResult.blocked) {
    return {
      output: `BLOCKED by hook: ${preResult.output}`,
      hookOutput,
      blocked: true,
    };
  }

  // --- Scoped environment for subprocess tools ---
  // Only expose necessary env vars to prevent credential leakage
  const SAFE_ENV_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM', 'NODE_PATH'];
  const scopedEnv: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) scopedEnv[key] = process.env[key]!;
  }

  // Extended scoped env for tools that need Supabase/API access
  const SUPABASE_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const supabaseEnv: Record<string, string> = { ...scopedEnv };
  for (const key of SUPABASE_ENV_KEYS) {
    if (process.env[key]) supabaseEnv[key] = process.env[key]!;
  }

  const TELEGRAM_ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const telegramEnv: Record<string, string> = { ...scopedEnv };
  for (const key of TELEGRAM_ENV_KEYS) {
    if (process.env[key]) telegramEnv[key] = process.env[key]!;
  }

  const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const googleEnv: Record<string, string> = { ...scopedEnv };
  for (const key of GOOGLE_ENV_KEYS) {
    if (process.env[key]) googleEnv[key] = process.env[key]!;
  }

  const SOCIAL_ENV_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET',
    'ALIENKIND_X_ACCESS_TOKEN', 'ALIENKIND_X_ACCESS_TOKEN_SECRET', 'LINKEDIN_ACCESS_TOKEN'];
  const socialEnv: Record<string, string> = { ...scopedEnv };
  for (const key of SOCIAL_ENV_KEYS) {
    if (process.env[key]) socialEnv[key] = process.env[key]!;
  }

  const DISCORD_ENV_KEYS = ['DISCORD_BOT_TOKEN'];
  const discordEnv: Record<string, string> = { ...scopedEnv };
  for (const key of DISCORD_ENV_KEYS) {
    if (process.env[key]) discordEnv[key] = process.env[key]!;
  }

  // --- Path validation helper ---
  function validatePath(filePath: string): string | null {
    try {
      const resolved = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
      if (!resolved.startsWith(ALIENKIND_DIR)) {
        return 'ERROR: Path must be within project directory';
      }
      return null;
    } catch { return 'ERROR: Invalid path'; }
  }

  // --- Execute the tool ---
  let output: string;
  try {
    switch (toolName) {
      case 'read_file': {
        const pathErr = validatePath(args.file_path);
        if (pathErr) { output = pathErr; break; }
        output = fs.readFileSync(args.file_path, 'utf8');
        // Cap output to prevent context explosion
        if (output.length > 100000) {
          output = output.slice(0, 100000) + '\n... [truncated at 100K chars]';
        }
        break;
      }

      case 'write_file': {
        const pathErr = validatePath(args.file_path);
        if (pathErr) { output = pathErr; break; }
        const dir = path.dirname(args.file_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.file_path, args.content);
        output = `Written ${args.content.length} bytes to ${args.file_path}`;
        break;
      }

      case 'edit_file': {
        const pathErr = validatePath(args.file_path);
        if (pathErr) { output = pathErr; break; }
        const content = fs.readFileSync(args.file_path, 'utf8');
        const count = content.split(args.old_string).length - 1;
        if (count === 0) {
          output = `ERROR: old_string not found in ${args.file_path}`;
        } else if (count > 1) {
          output = `ERROR: old_string found ${count} times in ${args.file_path} — must be unique`;
        } else {
          const newContent = content.replace(args.old_string, args.new_string);
          fs.writeFileSync(args.file_path, newContent);
          output = `Edited ${args.file_path}: replaced 1 occurrence`;
        }
        break;
      }

      case 'run_command': {
        const result = spawnSync('bash', ['-c', args.command], {
          cwd: ALIENKIND_DIR,
          timeout: 60000,
          encoding: 'utf8',
          env: scopedEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        if (result.status !== 0 && result.status !== null) {
          output += `\n[exit code: ${result.status}]`;
        }
        // Cap output
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... [truncated at 50K chars]';
        }
        break;
      }

      case 'search_files': {
        const searchDir = args.path || ALIENKIND_DIR;
        const searchDirResolved = path.resolve(searchDir);
        if (!searchDirResolved.startsWith(ALIENKIND_DIR)) { output = 'ERROR: Path must be within project directory'; break; }
        const result = spawnSync('find', [searchDir, '-path', `*${args.pattern}*`, '-type', 'f'], {
          cwd: ALIENKIND_DIR,
          timeout: 10000,
          encoding: 'utf8',
        });
        // Also try glob via node
        const { globSync } = require('glob');
        try {
          const matches = globSync(args.pattern, { cwd: searchDir, absolute: true });
          output = matches.join('\n') || 'No matches found';
        } catch {
          output = result.stdout || 'No matches found';
        }
        break;
      }

      case 'search_content': {
        const searchPath = args.path || ALIENKIND_DIR;
        const searchPathResolved = path.resolve(searchPath);
        if (!searchPathResolved.startsWith(ALIENKIND_DIR)) { output = 'ERROR: Path must be within project directory'; break; }
        const rgArgs = ['-n', '--max-count', '50', args.pattern, searchPath];
        if (args.glob) rgArgs.push('--glob', args.glob);
        const result = spawnSync('rg', rgArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 10000,
          encoding: 'utf8',
        });
        output = result.stdout || 'No matches found';
        break;
      }

      case 'supabase_query': {
        // Use our in-house supabase.ts CLI
        const method = args.method || 'GET';
        const VALID_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
        if (!VALID_METHODS.has(method)) { output = 'ERROR: Invalid HTTP method. Must be GET, POST, PATCH, or DELETE.'; break; }
        const supabasePath = (args.path || '').replace(/[;`$(){}|&'\n\r]/g, '');
        const bodyArg = args.body ? `'${args.body.replace(/'/g, "'\\''")}'` : '';
        const cmd = bodyArg
          ? `npx tsx scripts/lib/supabase.ts ${method} '${supabasePath}' ${bodyArg}`
          : `npx tsx scripts/lib/supabase.ts ${method} '${supabasePath}'`;
        const result = spawnSync('bash', ['-c', cmd], {
          cwd: ALIENKIND_DIR,
          timeout: 30000,
          encoding: 'utf8',
          env: supabaseEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... [truncated]';
        }
        break;
      }

      case 'send_telegram': {
        const msg = (args.message || '').replace(/'/g, "'\\''");
        const result = spawnSync('node', [path.join(ALIENKIND_DIR, 'scripts', 'send-telegram.js'), msg], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: telegramEnv,
        });
        output = result.stdout || result.stderr || 'Message sent';
        break;
      }

      case 'google_calendar': {
        const calArgs = [path.join(ALIENKIND_DIR, 'scripts', 'lib', 'google-calendar.ts')];
        calArgs.push(args.action);
        if (args.days) calArgs.push('--days', String(args.days));
        if (args.summary) calArgs.push('--summary', args.summary);
        if (args.start) calArgs.push('--start', args.start);
        if (args.end) calArgs.push('--end', args.end);
        if (args.event_id) calArgs.push(args.event_id);
        const result = spawnSync('npx', ['tsx', ...calArgs], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: googleEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'gmail': {
        const gmailArgs = [path.join(ALIENKIND_DIR, 'scripts', 'lib', 'google-gmail.ts')];
        gmailArgs.push(args.action);
        if (args.query) gmailArgs.push(args.query);
        if (args.message_id) gmailArgs.push(args.message_id);
        if (args.to) gmailArgs.push('--to', args.to);
        if (args.subject) gmailArgs.push('--subject', args.subject);
        if (args.body) gmailArgs.push('--body', args.body);
        const result = spawnSync('npx', ['tsx', ...gmailArgs], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: googleEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'web_search': {
        // Use in-house SearxNG via local-inference.ts search command
        const query = (args.query || '').replace(/'/g, "'\\''");
        const result = spawnSync('npx', ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'lib', 'local-inference.ts'), 'search', query], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: scopedEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'web_fetch': {
        // Fetch URL content via curl, extract text
        const url = args.url || '';
        // SSRF protection: block requests to localhost, private IPs, and file:// protocol
        const SSRF_BLOCKED = [
          /^file:/i,
          /^ftp:/i,
          /localhost/i,
          /127\.0\.0\./,
          /\[::1\]/,
          /^https?:\/\/10\./,
          /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
          /^https?:\/\/192\.168\./,
          /^https?:\/\/169\.254\./,
          /^https?:\/\/0\./,
          /^https?:\/\/0x[0-9a-f]/i,     // Hex IPs
          /^https?:\/\/0[0-7]+\./,        // Octal IPs
          /^https?:\/\/\d{8,}/,           // Decimal IPs
          /^https?:\/\/\[::ffff:/i,       // IPv6-mapped IPv4
        ];
        if (SSRF_BLOCKED.some(rx => rx.test(url))) {
          output = 'ERROR: URL blocked — requests to localhost, private networks, and file:// are not allowed';
          break;
        }
        const result = spawnSync('curl', ['-s', '-L', '--max-redirs', '3', '--max-time', '10', '--proto', '=http,https', '-A', 'Mozilla/5.0', url], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: scopedEnv,
        });
        output = (result.stdout || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... [truncated]';
        }
        break;
      }

      case 'post_to_x': {
        const text = (args.text || '').replace(/'/g, "'\\''");
        const xArgs = ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'post-to-x.ts'), text];
        if (args.account === 'keel') xArgs.push('--account', 'keel');
        if (args.media) xArgs.push('--media', args.media);
        const result = spawnSync('npx', xArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 30000,
          encoding: 'utf8',
          env: socialEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'post_to_linkedin': {
        const text = (args.text || '').replace(/'/g, "'\\''");
        const liArgs = ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'post-to-linkedin.ts'), text];
        if (args.media) liArgs.push('--media', args.media);
        const result = spawnSync('npx', liArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 30000,
          encoding: 'utf8',
          env: socialEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'discord_send': {
        const target = (args.target || '').replace(/'/g, "'\\''");
        const msg = (args.message || '').replace(/'/g, "'\\''");
        const result = spawnSync('node', [
          path.join(ALIENKIND_DIR, 'scripts', 'discord-send.js'),
          '--target', target, '--message', msg, '--send'
        ], {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: discordEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'google_drive': {
        if (args.output_path) {
          const outPathErr = validatePath(args.output_path);
          if (outPathErr) { output = outPathErr; break; }
        }
        const driveArgs = ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'lib', 'google-drive.ts'), args.action];
        if (args.query) driveArgs.push(args.query);
        if (args.file_id) driveArgs.push(args.file_id);
        if (args.folder_id) driveArgs.push(args.folder_id);
        if (args.output_path) driveArgs.push(args.output_path);
        const result = spawnSync('npx', driveArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 30000,
          encoding: 'utf8',
          env: googleEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'memory_search': {
        const searchArgs = [path.join(ALIENKIND_DIR, 'scripts', 'lib', 'memory-search.ts'), args.query];
        if (args.type) searchArgs.push('--type', args.type);
        if (args.limit) searchArgs.push('--limit', String(args.limit));
        const result = spawnSync('node', searchArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: supabaseEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'notion': {
        const NOTION_ENV_KEYS = ['NOTION_TOKEN'];
        const notionEnv: Record<string, string> = { ...scopedEnv };
        for (const key of NOTION_ENV_KEYS) {
          if (process.env[key]) notionEnv[key] = process.env[key]!;
        }
        const notionArgs = ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'lib', 'notion.ts'), args.action];
        if (args.query) notionArgs.push(args.query);
        if (args.id) notionArgs.push(args.id);
        if (args.title) notionArgs.push('--title', args.title);
        const result = spawnSync('npx', notionArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: notionEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      case 'asana': {
        const ASANA_ENV_KEYS = ['ASANA_ACCESS_TOKEN'];
        const asanaEnv: Record<string, string> = { ...scopedEnv };
        for (const key of ASANA_ENV_KEYS) {
          if (process.env[key]) asanaEnv[key] = process.env[key]!;
        }
        const asanaArgs = ['tsx', path.join(ALIENKIND_DIR, 'scripts', 'lib', 'asana.ts'), args.action];
        if (args.project_id) asanaArgs.push(args.project_id);
        if (args.task_id) asanaArgs.push(args.task_id);
        if (args.name) asanaArgs.push('--name', args.name);
        if (args.text) asanaArgs.push('--text', args.text);
        if (args.query) asanaArgs.push(args.query);
        const result = spawnSync('npx', asanaArgs, {
          cwd: ALIENKIND_DIR,
          timeout: 15000,
          encoding: 'utf8',
          env: asanaEnv,
        });
        output = (result.stdout || '') + (result.stderr || '');
        break;
      }

      default:
        output = `Unknown tool: ${toolName}`;
    }
  } catch (err: any) {
    output = `Tool error: ${err.message}`;
  }

  // --- PostToolUse hooks ---
  const postPayload: HookPayload = {
    session_id: sessionId,
    tool_input: args,
    tool_output: output.slice(0, 5000), // Cap to prevent huge hook payloads
  };
  const postResult = fireHooks('PostToolUse', claudeToolName, postPayload, log);
  hookOutput += postResult.output;

  return { output, hookOutput, blocked: false };
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_TO_CLAUDE_CODE,
  executeTool,
  fireHooks,
  loadHookConfig,
};
