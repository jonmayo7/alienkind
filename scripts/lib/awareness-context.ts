/**
 * Awareness Context — shared context builder for all Keel processes.
 *
 * Reads calendar cache + consciousness entries + current time and returns
 * a formatted string suitable for injection into any Claude prompt.
 *
 * Mycelium awareness (active terminals) is NOT included here — it's provided by:
 *   - Terminal sessions: hooks/mycelium-awareness.ts (UserPromptSubmit) +
 *     hooks/awareness-pulse.ts (PostToolUse) — both read Supabase async
 *   - Boot: ground.sh reads Supabase terminal_state via curl
 *   - Non-terminal scripts that need it: call getAllTerminals() directly
 *
 * This function remains SYNCHRONOUS for backward compatibility with all callers
 * (nightly-cycle, discord-listener, telegram-listener, operator, heartbeat,
 * morning-brief) which embed it directly in template literals.
 *
 * Source of truth for terminals: Supabase terminal_state (migration 032).
 */

const fs = require('fs');
const path = require('path');
const { TIMEZONE } = require('./constants.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CALENDAR_PATH = path.join(ALIENKIND_DIR, 'logs', 'calendar-cache.json');

interface AwarenessOptions {
  selfPid?: number;
  selfNodeId?: string;
  staleHours?: number;
}

interface CalendarEvent {
  time: string;
  title: string;
  end?: string;
}

interface CalendarCache {
  date: string;
  updatedAt: string;
  events: CalendarEvent[];
}

/**
 * Build awareness context string for prompt injection.
 * SYNC — reads local files only. Mycelium comes from hooks/ground.sh.
 */
function buildAwarenessContext({ selfPid, selfNodeId, staleHours = 2 }: AwarenessOptions = {}): string {
  const sections: string[] = [];
  const now = new Date();

  // --- Time ---
  const timeStr = now.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
  sections.push(`Current time: ${timeStr} CST`);

  // --- Calendar: today's events ---
  try {
    if (fs.existsSync(CALENDAR_PATH)) {
      const cache: CalendarCache = JSON.parse(fs.readFileSync(CALENDAR_PATH, 'utf8'));
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

      if ((cache.date || '').slice(0, 10) === todayStr && cache.events) {
        if (cache.events.length > 0) {
          const eventLines = cache.events.map((e: CalendarEvent) =>
            `  - ${e.time} — ${e.title}${e.end ? ` (until ${e.end})` : ''}`
          );
          sections.push(`Today's calendar:\n${eventLines.join('\n')}`);
        } else {
          sections.push('Today\'s calendar: no events');
        }
      }
    }
  } catch { /* non-critical */ }

  // --- Consciousness: what other instances are experiencing ---
  try {
    const consciousnessPath = path.join(ALIENKIND_DIR, 'logs', 'consciousness-recent.json');
    if (fs.existsSync(consciousnessPath)) {
      const entries = JSON.parse(fs.readFileSync(consciousnessPath, 'utf8'));
      const staleMs = staleHours * 60 * 60 * 1000;
      if (Array.isArray(entries) && entries.length > 0) {
        const entryLines: string[] = [];
        for (const entry of entries.slice(0, 5)) {
          const age = now.getTime() - new Date(entry.created_at).getTime();
          if (age > staleMs) continue;
          const timeAgo = Math.round(age / 60000);
          const mode = entry.mode || 'unknown';
          const thread = entry.active_thread ? entry.active_thread.slice(0, 80) : '';
          const attended = Array.isArray(entry.attended_to) ? entry.attended_to.slice(0, 2).join('; ') : '';
          const unresolvedList = Array.isArray(entry.unresolved) ? entry.unresolved.slice(0, 2).join('; ') : '';

          let line = `  - [${mode}, ${timeAgo}m ago]`;
          if (thread) line += ` thread: ${thread}`;
          if (attended) line += ` | attended: ${attended}`;
          if (unresolvedList) line += ` | unresolved: ${unresolvedList}`;
          entryLines.push(line);
        }
        if (entryLines.length > 0) {
          sections.push(`Consciousness thread (recent):\n${entryLines.join('\n')}`);
        }
      }
    }
  } catch { /* non-critical */ }

  // --- Open external threads (from thread-scanner cache) ---
  try {
    const threadsPath = path.join(ALIENKIND_DIR, 'logs', 'open-threads-cache.txt');
    if (fs.existsSync(threadsPath)) {
      const threadsSummary = fs.readFileSync(threadsPath, 'utf8').trim();
      if (threadsSummary) {
        // Only include if cache is less than 2 hours old
        const stat = fs.statSync(threadsPath);
        const cacheAge = now.getTime() - stat.mtimeMs;
        if (cacheAge < 2 * 60 * 60 * 1000) {
          sections.push(threadsSummary);
        }
      }
    }
  } catch { /* non-critical */ }

  if (sections.length === 0) return '';

  return `\nAWARENESS CONTEXT (auto-injected — do not re-fetch this data):\n${sections.join('\n')}\n`;
}

module.exports = { buildAwarenessContext };
