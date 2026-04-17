/**
 * Nightly Weekly Phase — End-of-week strategic review (Saturdays only)
 *
 * The weekly review provides a strategic 7-day vantage point. It gathers
 * the week's daily files, reflects on what shipped vs what was planned,
 * stress-tests one assumption, and writes a comprehensive summary.
 *
 * Structure: gather -> reflect -> write.
 * - Gather: read this week's daily files + memory search for context
 * - Reflect: what shipped, what regressed, what assumption to test
 * - Write: sections to daily file + summary to notification outbox
 */
const {
  ALIENKIND_DIR, LOG_DIR, DATE, TIME,
  fs, path,
  log, sendTelegram, formatAlert, appendToDigest,
  attemptGrowthCycle, buildAwarenessContext,
  writeConsciousnessFromOutput,
  getSupabaseContext, searchMemory,
  NIGHTLY, MODELS, ALLOWED_TOOLS_WEEKLY,
  now,
} = require('./shared.ts');

function buildWeeklyPrompt() {
  return `This is the end-of-week strategic review. Look at the week as a whole, not just today.

1. WEEKLY PROGRESS REVIEW: Read memory/daily/ files from this week. Summarize:
   - What shipped this week (features, fixes, infrastructure changes)
   - What was planned but did not ship — why?
   - Capability growth: what can the organism do now that it could not last week?
   - Operational health: daemon job success rates, self-heal activations, circulation volume
   Write to daily memory under '## Weekly Progress Review'.

2. SESSION STATE CURATION: Daily files + structured-state.json are the canonical state documents.
   - Update phase status for anything that shipped or changed
   - Update operational state with new capabilities or services
   - Flag any strategic direction changes from the human

3. SKILL REVIEW: Assess each skill in the skills/ directory:
   - Which skills were actively used this week?
   - Which were not touched? Should any be retired or enhanced?
   - Any crystallization candidates from the patterns table?
   Write to daily memory under '## Weekly Skill Review'.

4. ASSUMPTION STRESS-TEST: Pick ONE architecture principle, configuration threshold, or strategic decision that has been in place for 2+ weeks and has not been questioned.
   - State the assumption clearly
   - What evidence originally supported it?
   - Does that evidence still hold? Has anything changed?
   - What would make this assumption wrong? Is there any sign of that?
   - If it survives: note that it was tested and held. If it cracks: flag it with specific evidence.
   Write to daily memory under '## Weekly Assumption Audit'.

5. WEEKLY SUMMARY: Write a comprehensive '## Weekly Summary' section in today's daily memory file.

NOTIFICATION SUMMARY: Write your weekly review to the outbox file at: ${path.join(LOG_DIR, `telegram-outbox-weekly-${DATE}.txt`)}
Write what matters, at whatever length it takes.
The parent script will append verification lines. Do NOT use curl to send messages directly.
${buildAwarenessContext({ selfNodeId: 'daemon' })}`;
}

function verifyWeekly() {
  const lines: string[] = [];
  const dailyFile = path.join(ALIENKIND_DIR, 'memory', 'daily', `${DATE}.md`);
  try {
    const content = fs.readFileSync(dailyFile, 'utf-8');
    lines.push(`Weekly Progress Review: ${content.includes('## Weekly Progress Review') ? 'written' : 'missing'}`);
    lines.push(`Weekly Skill Review: ${content.includes('## Weekly Skill Review') ? 'written' : 'missing'}`);
    lines.push(`Weekly Summary: ${content.includes('## Weekly Summary') ? 'written' : 'missing'}`);
    lines.push(`Weekly Assumption Audit: ${content.includes('## Weekly Assumption Audit') ? 'written' : 'missing'}`);
  } catch {
    lines.push('Daily file: ERROR');
  }
  return lines;
}

async function runWeekly() {
  if (now.getDay() !== 6) {
    log('Weekly review: not Saturday — skipping');
    console.log('Weekly review: not Saturday — skipping');
    return;
  }

  log('=== Nightly Weekly Review Starting ===');
  const outboxFile = path.join(LOG_DIR, `telegram-outbox-weekly-${DATE}.txt`);

  let memoryContext = '';
  try {
    const results = await searchMemory('weekly progress skills review patterns shipped', { limit: 5, fileTypes: ['daily'] });
    if (results.length > 0) {
      memoryContext = '\n\nMEMORY SEARCH CONTEXT (recent indexed memories, ranked by relevance + recency):\n' +
        results.map(r => `[${r.file_date || 'undated'}] ${r.heading || ''}: ${r.content.slice(0, 300)}`).join('\n');
      log(`Memory search: ${results.length} relevant chunks found`);
    }
  } catch (e: any) {
    log(`WARN: Memory search failed: ${e.message}`);
  }

  const promptText = buildWeeklyPrompt() + getSupabaseContext() + memoryContext;

  const result: any = await attemptGrowthCycle({
    promptText,
    maxTurns: NIGHTLY.weekly.maxTurns,
    overallTimeout: NIGHTLY.weekly.overallTimeout,
    noOutputTimeout: NIGHTLY.weekly.noOutputTimeout,
    allowedTools: ALLOWED_TOOLS_WEEKLY,
    outboxFile,
    jobName: 'nightly-weekly',
    model: MODELS.reasoning,
  });

  if (!result.success) {
    sendTelegram(formatAlert({ severity: 'heads-up', source: 'weekly review', summary: 'failed', nextStep: 'daemon will retry automatically' }));
    process.exitCode = 1;
    return;
  }

  writeConsciousnessFromOutput({ mode: 'weekly', stdout: result.stdout || '', log });
  const verifyLines = verifyWeekly();
  const claudeSummary = result.outboxContent || 'Weekly review completed (no outbox written)';
  const telegramMsg = `${claudeSummary}\n---\n${verifyLines.join('\n')}`;
  appendToDigest('weekly', telegramMsg);
  try { if (fs.existsSync(outboxFile)) fs.unlinkSync(outboxFile); } catch { /* ok */ }
  log('=== Nightly Weekly Review Complete ===');
}

module.exports = { runWeekly, buildWeeklyPrompt, verifyWeekly };
