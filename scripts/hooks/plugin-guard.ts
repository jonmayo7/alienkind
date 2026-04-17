#!/usr/bin/env node
/**
 * PreToolUse hook (Edit, Write, Bash): blocks changes to Claude Code plugin
 * configuration without the human's explicit approval.
 *
 * Root cause motivation: a past incident where a Telegram plugin was
 * enabled during research, left in settings.json, auto-installed on a
 * separate host days later, and competed with our in-house telegram-listener
 * for the bot token — killing outbound Telegram delivery for hours.
 *
 * Blocks:
 *   - Writes to ~/.claude/settings.json that modify enabledPlugins
 *   - Bash commands containing "plugin install" or "plugin enable"
 *   - Writes to ~/.claude/plugins/ or ~/.claude/channels/
 *
 * This is a HARD BLOCK (exit 2). the human must explicitly approve plugin changes.
 * In-house integrations (scripts/lib/) are the standard. Plugins are external
 * dependencies that break substrate independence.
 *
 * Wired: PreToolUse on Edit|Write|Bash
 */

const path = require('path');
const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData: any;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || hookData.input || {};

  // --- Check Edit/Write targeting plugin config files ---
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    const content = toolInput.content || toolInput.new_string || '';

    // Block writes to plugin directories
    if (filePath.includes('.claude/plugins/') || filePath.includes('.claude/channels/')) {
      console.error([
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  PLUGIN GUARD — HARD BLOCK                                  ║',
        '╠══════════════════════════════════════════════════════════════╣',
        '║  Writes to plugin/channel directories require the human\'s        ║',
        '║  explicit approval. In-house integrations (scripts/lib/)    ║',
        '║  are the standard. Plugins break substrate independence.    ║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n'));
      process.exit(2);
    }

    // Block enabledPlugins changes in settings.json
    if (filePath.includes('.claude/settings') && content.includes('enabledPlugins')) {
      console.error([
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  PLUGIN GUARD — HARD BLOCK                                  ║',
        '╠══════════════════════════════════════════════════════════════╣',
        '║  Modifying enabledPlugins in settings.json requires the human\'s  ║',
        '║  explicit approval. A plugin conflict killed Telegram       ║',
        '║  delivery for 5+ hours on 2026-03-28.                      ║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n'));
      process.exit(2);
    }
  }

  // --- Check Bash for plugin install commands ---
  if (toolName === 'Bash') {
    const command = toolInput.command || '';
    if (/\/plugin\s+install|\/plugin\s+enable|enabledPlugins/i.test(command)) {
      console.error([
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  PLUGIN GUARD — HARD BLOCK                                  ║',
        '╠══════════════════════════════════════════════════════════════╣',
        '║  Plugin installation/enabling requires the human\'s explicit      ║',
        '║  approval. In-house integrations are the standard.          ║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n'));
      process.exit(2);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
