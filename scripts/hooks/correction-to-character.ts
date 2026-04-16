#!/usr/bin/env node

/**
 * Correction-to-Character — Stop hook.
 *
 * Reads recent-corrections.json (written by log-conversation.ts on
 * UserPromptSubmit) and appends new behavioral directives to
 * identity/character.md under an "Active corrections" section.
 *
 * This closes the gap between "correction logged" and "correction
 * becomes identity." Without this hook, corrections only survive in
 * the daily memory file — which gets replaced tomorrow. With it,
 * corrections land in the identity kernel and load on every boot.
 *
 * Design:
 *   - Only processes corrections from the CURRENT session
 *   - Only severity >= 5 (clear behavioral directives, not noise)
 *   - Deduplicates against existing character.md content
 *   - Appends to "## Active corrections" section (creates if missing)
 *   - Never blocks, never crashes — exit 0 always
 *   - Works without Supabase (reads local files only)
 *
 * The nightly identity-sync (daemon) handles the deeper work:
 *   - Pattern detection across multiple days
 *   - Promoting active corrections to proper sections
 *   - Removing corrections that became internalized
 *
 * Fires on: Stop
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHARACTER_FILE = path.join(ROOT, 'identity', 'character.md');
const CORRECTIONS_FILE = path.join(ROOT, 'logs', 'recent-corrections.json');
const SECTION_HEADER = '## Active corrections';
const SEVERITY_THRESHOLD = 5;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || '';
  if (!sessionId) process.exit(0);

  // Only run on session end or periodically (every 5th response)
  const responseCount = hookData.stop_response_count || 0;
  const isSessionEnd = hookData.stop_hook_reason === 'session_end' ||
    hookData.stop_reason === 'session_end' ||
    hookData.stop_hook_reason === 'user_exit';
  const isPeriodic = responseCount > 0 && responseCount % 5 === 0;
  if (!isSessionEnd && !isPeriodic) process.exit(0);

  // Read recent corrections
  let corrections = [];
  try {
    corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  } catch { process.exit(0); }

  if (!corrections.length) process.exit(0);

  // Filter: current session, high severity, corrections only (not reinforcements)
  const sessionCorrections = corrections.filter((c) =>
    c.severity >= SEVERITY_THRESHOLD &&
    // If terminal ID matches, it's from this session context
    // (recent-corrections.json doesn't store session_id, but terminal does)
    c.timestamp > Date.now() - 3600000 // within last hour as safety bound
  );

  if (!sessionCorrections.length) process.exit(0);

  // Read current character.md
  let characterContent = '';
  try {
    characterContent = fs.readFileSync(CHARACTER_FILE, 'utf8');
  } catch { process.exit(0); } // character.md doesn't exist yet

  // Check if it's still the template (has "## How to write this file")
  const isTemplate = characterContent.includes('## How to write this file');

  // Extract existing correction texts to dedup
  const existingLower = characterContent.toLowerCase();

  // Filter out corrections already present in character.md
  const newCorrections = sessionCorrections.filter((c) => {
    // Normalize: take the core directive, strip common prefixes
    const text = c.correction.toLowerCase()
      .replace(/^(no[,.\s!]+|stop\s+|don't\s+|never\s+)/i, '')
      .trim()
      .slice(0, 80); // first 80 chars for matching
    // Check if any substantial substring is already in character.md
    return text.length > 10 && !existingLower.includes(text.slice(0, 40));
  });

  if (!newCorrections.length) process.exit(0);

  // Build correction entries
  const today = new Date().toISOString().split('T')[0];
  const entries = newCorrections.map((c) => {
    // Clean up the correction text for character.md
    let text = c.correction.trim();
    // Remove trailing periods for consistency, then add one
    text = text.replace(/[.]+$/, '');
    return `- ${text}. _(${today})_`;
  });

  // Find or create the "Active corrections" section
  const sectionIndex = characterContent.indexOf(SECTION_HEADER);

  let updated;
  if (sectionIndex !== -1) {
    // Section exists — find the end of it (next ## or EOF)
    const afterHeader = sectionIndex + SECTION_HEADER.length;
    const nextSection = characterContent.indexOf('\n## ', afterHeader + 1);
    const insertPoint = nextSection !== -1 ? nextSection : characterContent.length;

    // Get existing section content to append to
    const sectionContent = characterContent.slice(afterHeader, insertPoint);
    const newSection = sectionContent.trimEnd() + '\n' + entries.join('\n') + '\n';
    updated = characterContent.slice(0, afterHeader) + newSection +
      (nextSection !== -1 ? characterContent.slice(insertPoint) : '');
  } else {
    // Section doesn't exist — append it
    const sectionBlock = [
      '',
      '---',
      '',
      SECTION_HEADER,
      '',
      '_Behavioral directives from your partnership. As these become internalized, move them to the appropriate section above and remove them from here._',
      '',
      ...entries,
      '',
    ].join('\n');

    updated = characterContent.trimEnd() + '\n' + sectionBlock;
  }

  // Write updated character.md
  try {
    fs.writeFileSync(CHARACTER_FILE, updated, 'utf8');
    console.log(`CORRECTION→CHARACTER: ${entries.length} correction(s) written to identity/character.md`);
  } catch { /* never crash */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
