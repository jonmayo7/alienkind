#!/usr/bin/env node
/**
 * PostToolUse hook (Edit, Write): Data flow verification.
 *
 * When a script that writes to Supabase is modified, checks that the same
 * table has a confirmed reader somewhere in the codebase. Warns if data
 * is being written to a table with no consumer — a "data graveyard."
 *
 * Root cause: the learning ledger shipped with should_have synthesis
 * (writer) but no boot injection (reader). Data sat in Supabase for 9
 * days while the morning brief reported 100/100 based on broken metrics.
 *
 * Wired: 2026-03-19. [HUMAN]-directed after discovering the learning ledger
 * evolution loop was never closed.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');

// Read hook input
let input;
try {
  input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
} catch {
  process.exit(0); // Can't parse → don't block
}

const filePath = input.tool_input?.file_path || input.tool_input?.content?.file_path || '';
if (!filePath) process.exit(0);

// Only check scripts that could write to Supabase
const relPath = filePath.replace(ALIENKIND_DIR + '/', '');
if (!relPath.startsWith('scripts/')) process.exit(0);
if (relPath.includes('/tests/')) process.exit(0);

// Read the file being edited
let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch {
  process.exit(0);
}

// Find Supabase table writes in this file
const writePatterns = [
  /supabasePost\(\s*['"](\w+)['"]/g,
  /supabasePatch\(\s*['"](\w+)['"]/g,
];

const tablesWritten = new Set<string>();
for (const pattern of writePatterns) {
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tablesWritten.add(match[1]);
  }
}

if (tablesWritten.size === 0) process.exit(0);

// For each table written, check if there's a reader somewhere in the codebase
const orphanedTables: string[] = [];

for (const table of tablesWritten) {
  try {
    // Search for supabaseGet or supabaseCount references to this table
    const result = execSync(
      `grep -rl "supabaseGet.*['\\"]${table}['\\"]\\|supabaseCount.*['\\"]${table}['\\"]\\|/rest/v1/${table}" scripts/ --include="*.ts" --include="*.js" 2>/dev/null | grep -v "tests/" | grep -v "${relPath}"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (!result) {
      orphanedTables.push(table);
    }
  } catch {
    // grep returns exit 1 when no matches — that means orphaned
    orphanedTables.push(table);
  }
}

if (orphanedTables.length > 0) {
  console.error(`DATA FLOW WARNING: ${relPath} writes to ${orphanedTables.length} table(s) with no confirmed reader:`);
  for (const table of orphanedTables) {
    console.error(`  → ${table} — no supabaseGet/supabaseCount found outside this file and tests`);
  }
  console.error('Every write needs a reader. Is this data going to a graveyard?');
  console.error('If a reader exists (ground.sh curl, external app), this warning is safe to ignore.');
  // Exit 0 — warning only, don't block. The commit gate handles the hard stop.
}

process.exit(0);
