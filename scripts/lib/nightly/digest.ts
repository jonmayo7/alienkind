/**
 * Nightly Digest Phase — Consolidates phase summaries, persists to Supabase
 *
 * Waits for identity-sync to complete, merges cross-midnight files,
 * builds structured Telegram report, persists to nightly_digests table.
 */
const { LOG_DIR, DIGEST_FILE, DATE, TIME, fs, path, log, now } = require('./shared.ts');
const { resolveConfig } = require('../portable.ts');
const PARTNER_NAME = resolveConfig('name', 'Partner');

async function runDigest() {
  log('=== Nightly Digest Starting ===');

  let digestFile = DIGEST_FILE;
  let crossMidnightMerge = false;
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  const yesterdayFile = path.join(LOG_DIR, `nightly-digest-${yesterdayDate}.txt`);

  if (now.getHours() < 5) {
    const todayExists = fs.existsSync(DIGEST_FILE);
    const yesterdayExists = fs.existsSync(yesterdayFile);
    if (yesterdayExists && todayExists) {
      crossMidnightMerge = true;
      log(`Cross-midnight: merging yesterday (${yesterdayDate}) + today (${DATE}) digest files`);
    } else if (yesterdayExists && !todayExists) {
      digestFile = yesterdayFile;
      log(`Cross-midnight: using yesterday's digest file (${yesterdayDate})`);
    }
  }

  if (!crossMidnightMerge && !fs.existsSync(digestFile)) {
    log('No digest file — nothing to send');
    return;
  }

  const readDigestContent = (): string => {
    if (crossMidnightMerge) {
      const parts: string[] = [];
      if (fs.existsSync(yesterdayFile)) parts.push(fs.readFileSync(yesterdayFile, 'utf-8').trim());
      if (fs.existsSync(DIGEST_FILE)) parts.push(fs.readFileSync(DIGEST_FILE, 'utf-8').trim());
      return parts.join('\n\n');
    }
    return fs.readFileSync(digestFile, 'utf-8');
  };

  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 30 * 1000;
  const waitStart = Date.now();
  const requiredSections = ['analysis', 'identity-sync'];
  while (Date.now() - waitStart < maxWaitMs) {
    const currentContent = readDigestContent();
    const missing = requiredSections.filter(s => !currentContent.includes(`[${s}]`));
    if (missing.length === 0) {
      log('All required phase sections found in digest file');
      break;
    }
    log(`Waiting for phase sections: ${missing.join(', ')}... (${Math.round((Date.now() - waitStart) / 1000)}s elapsed)`);
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  const finalContent = readDigestContent();
  const stillMissing = requiredSections.filter(s => !finalContent.includes(`[${s}]`));
  if (stillMissing.length > 0) {
    log(`WARN: Phase sections not found after ${Math.round((Date.now() - waitStart) / 1000)}s: ${stillMissing.join(', ')} — proceeding without them`);
  }

  const raw = readDigestContent().trim();
  if (!raw) {
    log('Digest file empty — nothing to send');
    return;
  }

  const sections: Record<string, string> = {};
  const sectionRegex = /\[(\w[\w-]*)\]\n([\s\S]*?)(?=\n\[|\n*$)/g;
  let match;
  while ((match = sectionRegex.exec(raw)) !== null) {
    sections[match[1]] = match[2].trim();
  }

  const phaseLabels: Record<string, string> = {
    immune: 'Security & Infrastructure',
    debrief: 'Channel Intelligence',
    analysis: 'Self-Analysis & Patterns',
    'identity-sync': 'Identity Evolution',
    weekly: 'Weekly Review',
  };

  const lines: string[] = [`**${PARTNER_NAME} Nightly Digest — ${DATE}**`, ''];
  const requiredPhases = ['immune', 'analysis', 'identity-sync'];
  const isFridayNight = new Date().getDay() === 6;
  if (isFridayNight) requiredPhases.push('weekly');
  const missingPhases = requiredPhases.filter(p => !sections[p]);
  if (missingPhases.length > 0) {
    lines.push(`⚠️ Missing phases: ${missingPhases.join(', ')}`, '');
  }

  const phaseOrder = ['immune', 'debrief', 'analysis', 'identity-sync', 'weekly'];
  for (const phase of phaseOrder) {
    if (sections[phase]) {
      const label = phaseLabels[phase] || phase;
      lines.push(`**${label}:**`);
      const highlights = sections[phase].split('\n').filter(l => l.trim()).slice(0, 3);
      for (const h of highlights) {
        lines.push(`  ${h.trim()}`);
      }
      lines.push('');
    }
  }

  const telegramMsg = lines.join('\n').trim();

  try {
    const { supabasePost } = require('../supabase.ts');
    await supabasePost('nightly_digests', {
      digest_date: DATE,
      sections,
      telegram_message: telegramMsg,
    });
    log('Digest persisted to Supabase');

    const { supabaseGet } = require('../supabase.ts');
    const readBack = await supabaseGet('nightly_digests', `digest_date=eq.${DATE}&select=digest_date,sections&limit=1`);
    if (readBack && readBack.length > 0 && readBack[0].sections) {
      const sectionCount = Object.keys(readBack[0].sections).length;
      log(`Digest read-back: CONFIRMED (${sectionCount} sections for ${DATE})`);
    } else {
      log('WARN: Digest read-back: row not found after write — persistence gap');
    }
  } catch (err: any) {
    log(`WARN: Failed to persist digest: ${err.message}`);
  }

  log(`Digest complete — ${telegramMsg.length} chars saved to Supabase (not sent to Telegram)`);
  try { fs.unlinkSync(digestFile); } catch { /* ok */ }
  if (crossMidnightMerge) {
    try { fs.unlinkSync(yesterdayFile); } catch { /* ok */ }
    try { fs.unlinkSync(DIGEST_FILE); } catch { /* ok */ }
  }
  log('=== Nightly Digest Complete ===');
}

module.exports = { runDigest };
