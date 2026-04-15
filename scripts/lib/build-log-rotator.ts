/**
 * BUILD_LOG Rotator — Token-budgeted archival
 *
 * Keeps BUILD_LOG.md under a configurable line ceiling by moving
 * oldest ## sections to BUILD_LOG_ARCHIVE.md. Preserves the header
 * (lines before the first ## section) and appends archived sections
 * at the END of the archive file (chronological order).
 *
 * Designed to run nightly as part of the immune infrastructure phase,
 * but also callable manually:
 *   node scripts/lib/build-log-rotator.ts [--dry-run]
 *
 * When historical context is needed, Keel reads BUILD_LOG_ARCHIVE.md
 * on demand — zero information loss, just not preloaded at boot.
 */

const fs = require('fs');
const path = require('path');

const KEEL_DIR = path.resolve(__dirname, '../..');
const BUILD_LOG = path.join(KEEL_DIR, 'BUILD_LOG.md');
const ARCHIVE = path.join(KEEL_DIR, 'memory', 'BUILD_LOG_ARCHIVE.md');

// Budget: ~300 lines ≈ 6K tokens ≈ 0.6% of 1M context
const MAX_LINES = 300;

interface Section {
  header: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

interface RotateResult {
  rotated: boolean;
  sectionsArchived: number;
  linesBefore: number;
  linesAfter: number;
  archivedHeaders: string[];
}

/**
 * Parse BUILD_LOG.md into header (pre-first-section content) and ## sections.
 */
function parseBuildLog(content: string): { header: string[]; sections: Section[] } {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let headerEnd = 0;

  // Find all ## section boundaries
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionStarts.push(i);
    }
  }

  if (sectionStarts.length === 0) {
    return { header: lines, sections: [] };
  }

  headerEnd = sectionStarts[0];
  const header = lines.slice(0, headerEnd);

  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i];
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : lines.length;
    sections.push({
      header: lines[start],
      startLine: start,
      endLine: end,
      lines: lines.slice(start, end),
    });
  }

  return { header, sections };
}

/**
 * Rotate BUILD_LOG.md: move oldest sections to archive until under MAX_LINES.
 */
function rotateBuildLog(options: { dryRun?: boolean; maxLines?: number; log?: (msg: string) => void } = {}): RotateResult {
  const { dryRun = false, maxLines = MAX_LINES, log = console.log } = options;

  if (!fs.existsSync(BUILD_LOG)) {
    log('BUILD_LOG.md not found — nothing to rotate');
    return { rotated: false, sectionsArchived: 0, linesBefore: 0, linesAfter: 0, archivedHeaders: [] };
  }

  const content = fs.readFileSync(BUILD_LOG, 'utf-8');
  const totalLines = content.split('\n').length;

  if (totalLines <= maxLines) {
    log(`BUILD_LOG.md is ${totalLines} lines (under ${maxLines} ceiling) — no rotation needed`);
    return { rotated: false, sectionsArchived: 0, linesBefore: totalLines, linesAfter: totalLines, archivedHeaders: [] };
  }

  const { header, sections } = parseBuildLog(content);

  if (sections.length <= 1) {
    log('BUILD_LOG.md has only one section — cannot rotate further');
    return { rotated: false, sectionsArchived: 0, linesBefore: totalLines, linesAfter: totalLines, archivedHeaders: [] };
  }

  // Archive oldest sections (from the end of the array, since newest are first)
  // until remaining content is under the ceiling
  const toArchive: Section[] = [];
  let remainingLines = totalLines;

  // Work from the oldest (last) section backwards
  for (let i = sections.length - 1; i >= 1; i--) {
    if (remainingLines <= maxLines) break;
    toArchive.unshift(sections[i]); // prepend to maintain order
    remainingLines -= sections[i].lines.length;
  }

  if (toArchive.length === 0) {
    log('No sections eligible for archival (would leave less than 1 section)');
    return { rotated: false, sectionsArchived: 0, linesBefore: totalLines, linesAfter: totalLines, archivedHeaders: [] };
  }

  const archivedHeaders = toArchive.map(s => s.header);

  if (dryRun) {
    log(`DRY RUN: Would archive ${toArchive.length} sections (${totalLines - remainingLines} lines)`);
    archivedHeaders.forEach(h => log(`  → ${h}`));
    log(`BUILD_LOG.md: ${totalLines} → ${remainingLines} lines`);
    return { rotated: false, sectionsArchived: toArchive.length, linesBefore: totalLines, linesAfter: remainingLines, archivedHeaders };
  }

  // Build archive content
  const archiveAddition = toArchive.map(s => s.lines.join('\n')).join('\n');

  // Read existing archive (or create)
  let existingArchive = '';
  if (fs.existsSync(ARCHIVE)) {
    existingArchive = fs.readFileSync(ARCHIVE, 'utf-8');
  } else {
    existingArchive = '# BUILD LOG ARCHIVE\n\n_Rotated automatically by build-log-rotator.ts. Active BUILD_LOG.md carries recent entries. This file has everything else._\n\n---\n';
  }

  // Append archived sections to end of archive (chronological)
  const newArchive = existingArchive.trimEnd() + '\n\n' + archiveAddition.trim() + '\n';

  // Rebuild BUILD_LOG with header + remaining sections
  const keptSections = sections.filter(s => !toArchive.includes(s));
  const newBuildLog = header.join('\n') + keptSections.map(s => s.lines.join('\n')).join('\n') + '\n';

  // Write archive first (safer — if this fails, BUILD_LOG is untouched)
  const archiveTmp = ARCHIVE + '.tmp';
  fs.writeFileSync(archiveTmp, newArchive);
  fs.renameSync(archiveTmp, ARCHIVE);

  // Then write trimmed BUILD_LOG
  const buildLogTmp = BUILD_LOG + '.tmp';
  fs.writeFileSync(buildLogTmp, newBuildLog);
  fs.renameSync(buildLogTmp, BUILD_LOG);

  const linesAfter = newBuildLog.split('\n').length;
  log(`BUILD_LOG rotated: ${totalLines} → ${linesAfter} lines (${toArchive.length} sections archived)`);
  archivedHeaders.forEach(h => log(`  archived: ${h}`));

  return { rotated: true, sectionsArchived: toArchive.length, linesBefore: totalLines, linesAfter, archivedHeaders };
}

// CLI mode
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const result = rotateBuildLog({ dryRun });
  if (result.rotated) {
    console.log(`\nDone. ${result.sectionsArchived} sections moved to archive.`);
  }
}

module.exports = { rotateBuildLog, parseBuildLog, MAX_LINES };
