#!/usr/bin/env node

/**
 * Remember Guard — UserPromptSubmit hook.
 *
 * Detects when [HUMAN] asks Keel to remember something and outputs
 * an advisory reminder to write it to a file immediately.
 *
 * From CLAUDE.md: "If [HUMAN] says remember something, write it to a file NOW"
 *
 * Parasites onto UserPromptSubmit (same event as log-conversation.ts).
 * Advisory only — outputs reminder, does not block.
 *
 * Fires on: UserPromptSubmit (every [HUMAN] prompt)
 * Output: advisory reminder when remember-patterns detected
 * Cost: <5ms (regex scan on string)
 */

// Patterns that indicate [HUMAN] wants something remembered
const REMEMBER_PATTERNS = [
  /\bremember\s+(this|that)\b/i,
  /\bdon'?t forget\b/i,
  /\bkeep in mind\b/i,
  /\bmake (a )?note\b/i,
  /\bwrite (this|that) down\b/i,
  /\blog (this|that)\b/i,
  /\bcapture (this|that)\b/i,
  /\bsave (this|that)\b/i,
  /\bremember:?\s+/i,
  /\bfrom now on\b/i,
  /\balways\s+(do|use|remember|check)\b/i,
  /\bnever\s+(do|use|forget)\b/i,
];

// Anti-patterns — questions about remembering, not requests to remember
const ANTI_PATTERNS = [
  /\bdo you remember\b/i,
  /\bcan you remember\b/i,
  /\bwhat do you remember\b/i,
  /\bremember when\b/i,
  /\bremember how\b/i,
];

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const rawPrompt = hookData.prompt || '';
  if (!rawPrompt || rawPrompt.length < 10) process.exit(0);

  // Extract [HUMAN]'s actual message — Telegram wraps it after "[HUMAN]'s message:"
  // Terminal prompts are [HUMAN]'s direct input. Extract the relevant part only.
  const humanMessageMatch = rawPrompt.match(/[HUMAN]'s message:\s*([\s\S]+)$/i);
  const prompt = humanMessageMatch ? humanMessageMatch[1].trim() : rawPrompt;

  // Skip if extracted message is too short (e.g., "yes", "go")
  if (prompt.length < 10) process.exit(0);

  // Check anti-patterns first — if [HUMAN] is asking about memory, not requesting it
  for (const anti of ANTI_PATTERNS) {
    if (anti.test(prompt)) process.exit(0);
  }

  // Check for remember patterns
  for (const pattern of REMEMBER_PATTERNS) {
    if (pattern.test(prompt)) {
      console.log(
        'REMEMBER GUARD — [HUMAN] asked you to remember something.\n' +
        'Write it to today\'s daily file or the appropriate memory file NOW.\n' +
        'CLAUDE.md: "If [HUMAN] says remember something, write it to a file NOW — no mental notes."'
      );
      process.exit(0);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
