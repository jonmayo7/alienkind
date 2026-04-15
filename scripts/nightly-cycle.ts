#!/usr/bin/env node
const { TIMEZONE } = require('./lib/constants.ts');
process.env.TZ = TIMEZONE;

/**
 * Keel Nightly Cycle — AIRE Loop Evening Sequence (Orchestrator)
 *
 * One script, six modes: --job immune|debrief|weekly|analysis|identity-sync|digest
 *
 * SEQUENCE (Analysis + Identity Sync LAST — they consume everything before them):
 * 11:00 PM  nightly-immune        → Security + infrastructure
 * 11:10 PM  nightly-debrief       → Discord channel debriefs
 * 11:20 PM  nightly-weekly        → Strategic 7-day review (Saturdays only)
 * 11:35 PM  nightly-analysis      → Growth reflection + partnership evolution
 * 11:55 PM  nightly-identity-sync → Identity evolution (FINAL act)
 * 12:10 AM  nightly-digest        → Consolidation
 *
 * Phase implementations in scripts/lib/nightly/:
 *   shared.ts       — config, state, utilities shared by all phases
 *   immune.ts       — security, backup, infrastructure
 *   debrief.ts      — Discord/Telegram channel intelligence
 *   analysis.ts     — growth reflection, pattern analysis
 *   identity-sync.ts — identity kernel evolution
 *   weekly.ts       — end-of-week strategic review
 *   digest.ts       — consolidation + Supabase persistence
 *
 * Usage:
 *   npx tsx scripts/nightly-cycle.ts --job immune
 *   npx tsx scripts/nightly-cycle.ts --job analysis
 *   npx tsx scripts/nightly-cycle.ts --job identity-sync
 *   npx tsx scripts/nightly-cycle.ts --job weekly
 *   npx tsx scripts/nightly-cycle.ts --job digest
 *   npx tsx scripts/nightly-cycle.ts --job immune --dry-run
 */

// ─── Shared foundation (config, env, utilities) ───
const { log, getSupabaseContext } = require('./lib/nightly/shared.ts');

// ─── Phase modules ───
const { runImmune, buildImmunePrompt } = require('./lib/nightly/immune.ts');
const { runDebrief } = require('./lib/nightly/debrief.ts');
const { runAnalysis, buildAnalysisPrompt } = require('./lib/nightly/analysis.ts');
const { runIdentitySync, buildIdentitySyncPrompt } = require('./lib/nightly/identity-sync.ts');
const { runWeekly, buildWeeklyPrompt } = require('./lib/nightly/weekly.ts');
const { runDigest } = require('./lib/nightly/digest.ts');

// ─── CLI parsing ───
const DRY_RUN = process.argv.includes('--dry-run');
const jobIdx = process.argv.indexOf('--job');
const JOB_MODE = jobIdx !== -1 ? process.argv[jobIdx + 1] : null;
const VALID_JOBS = ['immune', 'debrief', 'analysis', 'identity-sync', 'weekly', 'digest'];

if (JOB_MODE && !VALID_JOBS.includes(JOB_MODE)) {
  console.error(`Invalid --job value: ${JOB_MODE}. Must be one of: ${VALID_JOBS.join(', ')}`);
  process.exit(1);
}

// ─── Main routing ───
async function main() {
  if (DRY_RUN && JOB_MODE) {
    let prompt;
    if (JOB_MODE === 'immune') prompt = buildImmunePrompt();
    else if (JOB_MODE === 'analysis') prompt = buildAnalysisPrompt() + getSupabaseContext();
    else if (JOB_MODE === 'identity-sync') prompt = buildIdentitySyncPrompt();
    else if (JOB_MODE === 'weekly') prompt = buildWeeklyPrompt() + getSupabaseContext();
    console.log(`=== DRY RUN: ${JOB_MODE} prompt (${prompt.length} chars) ===\n`);
    console.log(prompt);
    return;
  }

  if (JOB_MODE === 'immune') return runImmune();
  if (JOB_MODE === 'debrief') return runDebrief();
  if (JOB_MODE === 'analysis') return runAnalysis();
  if (JOB_MODE === 'identity-sync') return runIdentitySync();
  if (JOB_MODE === 'weekly') return runWeekly();
  if (JOB_MODE === 'digest') return runDigest();

  log(`ERROR: No --job flag provided. Use: node scripts/nightly-cycle.ts --job immune|analysis|identity-sync|weekly`);
  process.exitCode = 1;
}

if (require.main === module) {
  const { sendTelegram, formatAlert } = require('./lib/nightly/shared.ts');
  main().then(() => {
    process.exit(process.exitCode || 0);
  }).catch((err) => {
    log(`FATAL: ${err.message}`);
    sendTelegram(formatAlert({ severity: 'action', source: 'nightly cycle', summary: 'FATAL error', detail: err.message.slice(0, 300), nextStep: 'check nightly-cycle logs — cycle stopped' }));
    process.exit(1);
  });
}
