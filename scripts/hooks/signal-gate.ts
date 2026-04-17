#!/usr/bin/env node

/**
 * PreToolUse hook: blocks tool execution when a blocking signal is pending.
 *
 * Two signal tiers:
 *   1. Awareness (signal_type != 'blocking') — shown in mycelium-awareness hook,
 *      non-blocking. Terminal sees it and continues.
 *   2. Blocking (signal_type == 'blocking') — this hook fires. Terminal pauses,
 *      displays the signal content, auto-acknowledges after display so the NEXT
 *      tool call proceeds. One pause per blocking signal.
 *
 * Flow:
 *   Terminal A emits blocking signal to Terminal B →
 *   Terminal B's next tool call hits this hook →
 *   Hook displays signal content and exits with code 1 (BLOCKED) →
 *   Hook auto-acknowledges the signal →
 *   Terminal B's next tool call proceeds normally.
 *
 * Wiring: PreToolUse on Bash|Edit|Write|Agent (same matcher as compaction-gate-enforce)
 */

const path = require('path');
const fs = require('fs');

/**
 * Detect if this hook is running in the main interactive terminal
 * vs a subagent spawned by the Agent tool.
 *
 * Main terminal: keel.sh (wrote marker) → claude → hook
 * Subagent:      claude → Agent subprocess → hook (no keel.sh marker in ancestry)
 *
 * Blocking signals should only be consumed by the main terminal
 * where [HUMAN] can actually see them — not eaten by background subagents.
 */
function isMainTerminalContext(): boolean {
  try {
    const { execSync } = require('child_process');
    const ppid = process.ppid;
    // Check if parent wrote a terminal ID marker (direct hook from claude, claude's parent is keel.sh)
    if (fs.existsSync(`/tmp/alienkind-terminal-id-${ppid}`)) return true;
    // Check grandparent (hook → claude → keel.sh)
    const grandPpid = execSync(`ps -o ppid= -p ${ppid}`, { encoding: 'utf8', timeout: 1000 }).trim();
    if (grandPpid && fs.existsSync(`/tmp/alienkind-terminal-id-${grandPpid}`)) return true;
  } catch { /* can't determine */ }
  return false;
}

async function main() {
  try {
    // Skip blocking signal handling in subagent context.
    // Subagents were consuming signals before [HUMAN] could see them.
    if (!isMainTerminalContext()) {
      process.exit(0);
    }

    const { getTerminalId } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
    );
    const { getUnreadSignals, acknowledgeSignals } = require(
      path.resolve(__dirname, '..', 'lib', 'event-bus.ts')
    );

    const myId = getTerminalId();

    // Check for unacknowledged blocking signals directed at this terminal (or broadcast)
    const blockingSignals = await getUnreadSignals(myId, {
      type: 'blocking',
      limit: 5,
    });

    if (blockingSignals.length === 0) {
      // No blocking signals — proceed normally
      process.exit(0);
    }

    // Display the blocking signal(s)
    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║  BLOCKING SIGNAL — PAUSE AND READ                          ║',
      '╠══════════════════════════════════════════════════════════════╣',
    ];

    for (const sig of blockingSignals) {
      const age = Date.now() - new Date(sig.created_at || '').getTime();
      const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` :
                     age < 3600000 ? `${Math.round(age / 60000)}m ago` :
                     `${Math.round(age / 3600000)}h ago`;

      const senderName = sig.payload?.sender_label || sig.from_node;
      lines.push(`║  From: ${senderName} (${ageStr})`);
      lines.push(`║  Trail: ${sig.trail}`);
      lines.push('║');

      // Display payload content
      const payload = sig.payload || {};
      if (payload.summary) {
        lines.push(`║  ${payload.summary}`);
      }
      if (payload.message) {
        lines.push(`║  ${payload.message}`);
      }
      if (payload.question) {
        lines.push(`║  QUESTION: ${payload.question}`);
      }
      if (payload.action_required) {
        lines.push(`║  ACTION REQUIRED: ${payload.action_required}`);
      }
      if (payload.details) {
        if (Array.isArray(payload.details)) {
          for (const d of payload.details.slice(0, 5)) {
            lines.push(`║    - ${d}`);
          }
        } else {
          lines.push(`║  ${payload.details}`);
        }
      }
      lines.push('║');
    }

    lines.push('║  This signal has been acknowledged. Your next action will proceed.');
    lines.push('║  Address the signal content before continuing your work.');
    lines.push('╚══════════════════════════════════════════════════════════════╝');

    // Auto-acknowledge after display — next tool call will proceed
    const ids = blockingSignals.map((s: any) => s.id).filter(Boolean);
    if (ids.length > 0) {
      await acknowledgeSignals(ids, myId);
    }

    // Output the signal content
    console.error(lines.join('\n'));

    // Exit 1 = BLOCKED. Claude Code will show the message and pause.
    process.exit(1);

  } catch (e: any) {
    // Signal gate is non-critical — if it fails, don't block work
    process.exit(0);
  }
}

main();
