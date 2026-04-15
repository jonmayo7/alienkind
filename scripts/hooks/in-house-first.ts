#!/usr/bin/env node
/**
 * PreToolUse hook (WebFetch, WebSearch): In-house first enforcement.
 *
 * When fetching from a domain we have in-house tools for, warns to use
 * the owned tool instead. Prevents reaching for external workarounds
 * when the capability already exists in scripts/.
 *
 * Root cause: Tried WebFetch + bearer token + guessed function names
 * to read an X tweet before checking post-to-x.ts exports. Had full
 * OAuth read/write access the entire time. (2026-03-19)
 *
 * Wired: 2026-03-19. [HUMAN]: "how do we fix this?"
 */

const fs = require('fs');

// Domain → in-house tool mapping
const IN_HOUSE_TOOLS: Record<string, string> = {
  'x.com': 'scripts/post-to-x.ts (OAuth 1.0a: postTweet, getMentions, lookupUserByUsername, followUser, sendDirectMessage, uploadMedia)',
  'twitter.com': 'scripts/post-to-x.ts (same as x.com)',
  'api.x.com': 'scripts/post-to-x.ts (full API access via OAuth 1.0a)',
  'api.twitter.com': 'scripts/post-to-x.ts (full API access via OAuth 1.0a)',
  'linkedin.com': 'scripts/post-to-linkedin.ts (OAuth 2.0: post, status, delete)',
  'api.linkedin.com': 'scripts/post-to-linkedin.ts (OAuth 2.0)',
  'calendar.google.com': 'scripts/lib/google-calendar.ts (list, create, update, delete events)',
  'gmail.googleapis.com': 'scripts/lib/google-gmail.ts (search, read, send, draft, reply, thread)',
  'mail.google.com': 'scripts/lib/google-gmail.ts (search, read, send, draft, reply, thread)',
  'drive.google.com': 'scripts/lib/google-drive.ts (search, list, get, download, export)',
  'docs.google.com': 'scripts/lib/google-drive.ts (export as text/plain)',
  'notion.so': 'scripts/lib/notion.ts (search, getPage, queryDatabase, createPage, updatePage)',
  'api.notion.com': 'scripts/lib/notion.ts (full API access)',
  'app.asana.com': 'scripts/lib/asana.ts (projects, tasks, create, update, complete, comment, search)',
  'discord.com': 'scripts/lib/discord-api.ts (sendMessage, fetchMessages)',
  'api.telegram.org': 'scripts/lib/telegram.ts (sendTelegram, sendDocument)',
};

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const url = hookData.tool_input?.url || '';
  if (!url) process.exit(0);

  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.replace(/^www\./, '');

    const tool = IN_HOUSE_TOOLS[host];
    if (tool) {
      console.error(`IN-HOUSE FIRST: You have owned tools for ${host}`);
      console.error(`  → ${tool}`);
      console.error(`Run: Object.keys(require('./${tool.split(' ')[0]}')) to see available functions.`);
      console.error(`Use in-house tools first. Ghost (browser) or SearxNG (search) for anything else.`);
      // Warning only — don't block. The tool might legitimately need the web version.
    }
  } catch {
    // Invalid URL — let WebFetch handle the error
  }

  process.exit(0);
}

main();
