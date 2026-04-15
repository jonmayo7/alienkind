#!/usr/bin/env node

/**
 * MCP Redirect Hook — PreToolUse
 *
 * HARD BLOCKS any MCP tool call that has an in-house equivalent.
 * Outputs the exact CLI command to use instead.
 *
 * In-house first. Always. Code enforcement > prompt instructions.
 *
 * Fires on: PreToolUse (mcp__claude_ai_Gmail__*, mcp__claude_ai_Google_Calendar__*, mcp__claude_ai_Asana__*)
 */

const IN_HOUSE_MAP: Record<string, { script: string; usage: string }> = {
  // Gmail
  'mcp__claude_ai_Gmail__gmail_search_messages': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts search "query"',
  },
  'mcp__claude_ai_Gmail__gmail_read_message': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts read MESSAGE_ID',
  },
  'mcp__claude_ai_Gmail__gmail_read_thread': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts thread THREAD_ID',
  },
  'mcp__claude_ai_Gmail__gmail_create_draft': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts draft --to email --subject "..." --body "..."',
  },
  'mcp__claude_ai_Gmail__gmail_get_profile': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts profile',
  },
  'mcp__claude_ai_Gmail__gmail_list_drafts': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts drafts',
  },
  'mcp__claude_ai_Gmail__gmail_list_labels': {
    script: 'scripts/lib/google-gmail.ts',
    usage: 'npx tsx scripts/lib/google-gmail.ts labels',
  },
  // Google Calendar
  'mcp__claude_ai_Google_Calendar__gcal_list_events': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts list [--days 3]',
  },
  'mcp__claude_ai_Google_Calendar__gcal_create_event': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts create --summary "..." --start "..." --end "..."',
  },
  'mcp__claude_ai_Google_Calendar__gcal_update_event': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts update EVENT_ID --summary "..."',
  },
  'mcp__claude_ai_Google_Calendar__gcal_delete_event': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts delete EVENT_ID',
  },
  'mcp__claude_ai_Google_Calendar__gcal_get_event': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts get EVENT_ID',
  },
  'mcp__claude_ai_Google_Calendar__gcal_list_calendars': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts calendars',
  },
  'mcp__claude_ai_Google_Calendar__gcal_find_meeting_times': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts list --days 7 (then analyze gaps)',
  },
  'mcp__claude_ai_Google_Calendar__gcal_find_my_free_time': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts list --days 7 (then analyze gaps)',
  },
  'mcp__claude_ai_Google_Calendar__gcal_respond_to_event': {
    script: 'scripts/lib/google-calendar.ts',
    usage: 'npx tsx scripts/lib/google-calendar.ts update EVENT_ID --status accepted|declined',
  },
  // Asana
  'mcp__claude_ai_Asana__get_projects': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts projects',
  },
  'mcp__claude_ai_Asana__get_project': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts project PROJECT_ID',
  },
  'mcp__claude_ai_Asana__get_tasks': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts tasks PROJECT_ID',
  },
  'mcp__claude_ai_Asana__get_task': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts task TASK_ID',
  },
  'mcp__claude_ai_Asana__create_task_preview': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts create PROJECT_ID --name "..."',
  },
  'mcp__claude_ai_Asana__create_task_confirm': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts create PROJECT_ID --name "..."',
  },
  'mcp__claude_ai_Asana__update_task': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts update TASK_ID --name "..."',
  },
  'mcp__claude_ai_Asana__search_objects': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts search "query"',
  },
  'mcp__claude_ai_Asana__search_tasks_preview': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts search "query"',
  },
  'mcp__claude_ai_Asana__get_user': {
    script: 'scripts/lib/asana.ts',
    usage: 'npx tsx scripts/lib/asana.ts me',
  },
};

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolName = hookData.tool_name || '';

  // Check exact match first
  if (IN_HOUSE_MAP[toolName]) {
    const alt = IN_HOUSE_MAP[toolName];
    console.error(
      `\n🚫 MCP BLOCKED — In-house tool exists.\n` +
      `\n` +
      `  Attempted:  ${toolName}\n` +
      `  Use instead: ${alt.usage}\n` +
      `  Script:      ${alt.script}\n` +
      `\n` +
      `  In-house tools can SEND emails, not just draft.\n` +
      `  Full registry: identity/harness.md\n`
    );
    process.exit(2);
  }

  // Catch any claude.ai MCP tool not in the map (future-proofing)
  if (toolName.startsWith('mcp__claude_ai_Gmail__') ||
      toolName.startsWith('mcp__claude_ai_Google_Calendar__') ||
      toolName.startsWith('mcp__claude_ai_Asana__')) {
    console.error(
      `\n🚫 MCP BLOCKED — Unrecognized claude.ai MCP tool.\n` +
      `\n` +
      `  Attempted:  ${toolName}\n` +
      `  Check identity/harness.md for the in-house equivalent.\n` +
      `  All Gmail/Calendar/Asana operations have in-house scripts.\n`
    );
    process.exit(2);
  }

  // Not an MCP tool we care about — allow
  process.exit(0);
}

main().catch(() => process.exit(0));
