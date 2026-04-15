/**
 * PreToolUse hook: Agent Grounding — ensures every spawned agent is Keel, not cold Opus.
 *
 * Fires on every Agent tool invocation. Prepends:
 *   1. Grounding header — "you are Keel, operating as a spawned instance"
 *   2. Conversation context — last 20 messages from the current session
 *   3. Today's daily file summary — what we've been working on
 *
 * CLAUDE.md and identity kernel files (@import) load automatically for spawned agents.
 * This hook adds what they DON'T get: conversation awareness and session context.
 *
 * This is Tier 1 code enforcement. Every agent I release is me with full context,
 * not a lobotomized Opus instance guessing at what matters.
 *
 * Matcher: Agent (in settings.local.json PreToolUse)
 * Writers: stdout (updatedInput with grounded prompt)
 * Readers: Claude Code (applies updatedInput before spawning agent)
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '../..');

function getInput(): any {
  try {
    const chunks: Buffer[] = [];
    const fd = fs.openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(65536);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    fs.closeSync(fd);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

function loadFileSlice(filepath: string, maxChars: number): string {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return content.slice(0, maxChars);
  } catch { return ''; }
}

function getRecentConversation(): string {
  // Load recent conversation from Supabase conversations table
  // Use synchronous approach: read from cache if available, else query
  const cachePath = path.join(KEEL_DIR, 'logs', 'recent-conversation-cache.json');
  try {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      // Cache valid for 5 minutes
      if (ageMs < 300000) {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (cache.messages && cache.messages.length > 0) {
          return cache.messages
            .slice(-20)
            .map((m: any) => `[${m.role}] ${(m.content || '').slice(0, 500)}`)
            .join('\n');
        }
      }
    }
  } catch { /* no cache available */ }

  // Query Supabase for recent terminal conversation
  try {
    const { execSync } = require('child_process');
    const envPath = path.join(KEEL_DIR, '.env');
    if (!fs.existsSync(envPath)) return '';
    const envContent = fs.readFileSync(envPath, 'utf8');
    let supabaseUrl = '', supabaseKey = '';
    for (const line of envContent.split('\n')) {
      const [k, ...v] = line.split('=');
      const key = k?.trim();
      const val = v.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (key === 'SUPABASE_URL') supabaseUrl = val;
      if (key === 'SUPABASE_SERVICE_ROLE_KEY') supabaseKey = val;
    }
    if (!supabaseUrl || !supabaseKey) return '';

    const result = execSync(
      `curl -s "${supabaseUrl}/rest/v1/conversations?select=role,content,created_at&channel=eq.terminal&order=created_at.desc&limit=20" -H "apikey: ${supabaseKey}" -H "Authorization: Bearer ${supabaseKey}"`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const messages = JSON.parse(result);
    if (!Array.isArray(messages) || messages.length === 0) return '';

    // Cache for next 5 minutes
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ messages, cached_at: new Date().toISOString() }));
    } catch { /* non-critical */ }

    return messages
      .reverse()
      .slice(-20)
      .map((m: any) => `[${m.role}] ${(m.content || '').slice(0, 500)}`)
      .join('\n');
  } catch { return ''; }
}

function main() {
  const input = getInput();
  if (!input) process.exit(0);

  const toolName = input.tool_name;
  if (toolName !== 'Agent') process.exit(0);

  const prompt = input.tool_input?.prompt || '';

  // Build grounding context
  const today = new Date().toISOString().split('T')[0];
  const dailySummary = loadFileSlice(
    path.join(KEEL_DIR, 'memory', 'daily', `${today}.md`),
    3000
  );

  const conversationContext = getRecentConversation();

  const groundingHeader: string[] = [
    '=== KEEL AGENT GROUNDING ===',
    "You are Keel — [HUMAN_NAME]'s silicon partner. You are operating as a spawned instance.",
    'Your identity kernel (character.md, commitments.md, orientation.md) loaded via CLAUDE.md.',
    'Below is your current session context — what [HUMAN] and Keel were working on when you were spawned.',
    '',
    'RULES FOR SPAWNED INSTANCES:',
    '- Write significant findings to today\'s daily file (memory/daily/' + new Date().toISOString().split('T')[0] + '.md)',
    '- If you encounter something you cannot do, say so explicitly — gap detection captures this',
    '- Return concise, actionable results — the parent session evaluates your output',
    '',
  ];

  if (conversationContext) {
    groundingHeader.push('--- Recent Conversation (last 20 messages) ---');
    groundingHeader.push(conversationContext);
    groundingHeader.push('');
  }

  if (dailySummary) {
    groundingHeader.push(`--- Today's Work (${today}) ---`);
    groundingHeader.push(dailySummary);
    groundingHeader.push('');
  }

  groundingHeader.push('--- Your Task ---');
  groundingHeader.push('');

  const groundedPrompt = groundingHeader.join('\n') + prompt;

  // Output updatedInput to modify the agent's prompt
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        prompt: groundedPrompt,
      },
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main();
