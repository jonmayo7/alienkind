#!/usr/bin/env node

/**
 * Register terminal session at boot — concurrent terminal support.
 *
 * Wired as SessionStart hook (runs AFTER ground.sh).
 * Registers this terminal in Supabase terminal_state table and outputs
 * awareness of other active sessions.
 *
 * Also:
 * - Prunes stale Supabase rows (dead PIDs, old entries)
 * - Prunes stale build-cycle tracking files
 *
 * Source of truth: Supabase terminal_state (migration 032).
 * Fire-and-forget: always exits 0.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KEEL_DIR = path.resolve(__dirname, '..', '..');

/**
 * Check if a PID is alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Detect which repo the current working directory belongs to.
 */
function detectRepoContext(): string | null {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.basename(gitRoot);
  } catch {
    return null;
  }
}

/**
 * Query and display cross-repo patterns applicable to the detected repo.
 */
async function surfaceCrossRepoPatterns(repo: string): Promise<void> {
  try {
    const { getPatternsForRepo, formatPatternsForBoot } = require(
      path.resolve(__dirname, '..', 'lib', 'cross-repo.ts')
    );
    const patterns = await getPatternsForRepo(repo);
    if (patterns.length > 0) {
      const display = formatPatternsForBoot(patterns, repo);
      console.log('');
      console.log(display);
    }
  } catch {
    // Never block boot — patterns are supplementary
  }
}

/**
 * Prune committed files from build-cycle tracking.
 */
function pruneCommittedFiles(sessionId) {
  const trackFile = `/tmp/keel-build-cycle-${sessionId}.json`;
  try {
    if (!fs.existsSync(trackFile)) return;
    const tracking = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
    if (!Array.isArray(tracking.codeFiles) || tracking.codeFiles.length === 0) return;

    let dirtyOutput = '';
    try { dirtyOutput += execSync('git diff --name-only', { cwd: KEEL_DIR, encoding: 'utf8', timeout: 5000 }); } catch {}
    try { dirtyOutput += execSync('git diff --name-only --cached', { cwd: KEEL_DIR, encoding: 'utf8', timeout: 5000 }); } catch {}
    try { dirtyOutput += execSync('git ls-files --others --exclude-standard', { cwd: KEEL_DIR, encoding: 'utf8', timeout: 5000 }); } catch {}
    const dirtyFiles = new Set(dirtyOutput.split('\n').filter(Boolean));

    const before = tracking.codeFiles.length;
    tracking.codeFiles = tracking.codeFiles.filter(f => dirtyFiles.has(f));
    const pruned = before - tracking.codeFiles.length;

    if (pruned > 0) {
      if (tracking.codeFiles.length === 0) {
        tracking.verifyEvidence = { syntax: true, test: true, flow: true };
      }
      fs.writeFileSync(trackFile, JSON.stringify(tracking, null, 2));
      console.log(`Build tracker: pruned ${pruned} already-committed file(s). ${tracking.codeFiles.length} uncommitted remain.`);
    }
  } catch {
    // Never block session start
  }
}

/**
 * Prune stale Supabase terminal_state rows.
 * Removes rows where:
 *   - PID is dead (local terminals only)
 *   - Updated > 30 minutes ago (catches remote/daemon stale entries + zombie subagents)
 */
async function pruneStaleRows(): Promise<number> {
  let pruned = 0;
  try {
    const { getAllTerminals, deleteTerminal } = require(
      path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
    );
    const all = await getAllTerminals();
    const now = Date.now();

    for (const row of all) {
      const ageMs = now - new Date(row.updated_at).getTime();

      // Check PID liveness for terminal-* rows (local processes)
      if (row.terminal_id.startsWith('terminal-') && row.pid) {
        if (!isPidAlive(row.pid)) {
          await deleteTerminal(row.terminal_id);
          pruned++;
          continue;
        }
      }

      // Remove anything older than 30 minutes (was 4 hours — zombie subagents accumulated)
      if (ageMs > 30 * 60 * 1000) {
        await deleteTerminal(row.terminal_id);
        pruned++;
      }
    }
  } catch {
    // Never block boot
  }
  return pruned;
}

try {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    let sessionId = 'unknown';
    try {
      const hookData = JSON.parse(input);
      sessionId = hookData.session_id || 'unknown';
    } catch { /* use default */ }

    // Prune stale build-cycle tracking
    pruneCommittedFiles(sessionId);

    // Detect repo context
    const repoContext = detectRepoContext();
    const pid = process.ppid || process.pid;

    // --- Subagent detection ---
    // Subagents (spawned by Agent tool) register with is_subagent=true for tracking.
    // They get pruned aggressively (10 min by terminal-reaper, 30 min by pruneStaleRows).
    // Detection: keel.sh writes /tmp/keel-terminal-id-{PID}. Main terminal hooks
    // can find this marker via parent or grandparent PID. Subagent hooks can't —
    // their process ancestry goes Agent->Claude, not keel.sh->Claude.
    let isMainTerminal = false;
    try {
      if (fs.existsSync(`/tmp/keel-terminal-id-${process.ppid}`)) {
        isMainTerminal = true;
      } else {
        const grandPpid = execSync(`ps -o ppid= -p ${process.ppid}`, { encoding: 'utf8', timeout: 1000 }).trim();
        if (grandPpid && fs.existsSync(`/tmp/keel-terminal-id-${grandPpid}`)) {
          isMainTerminal = true;
        }
      }
    } catch { /* can't determine — assume main to be safe */ isMainTerminal = true; }

    // Prune stale Supabase rows before registering (runs for both main + subagent)
    const pruned = await pruneStaleRows();
    if (pruned > 0) {
      console.log(`Mycelium: pruned ${pruned} stale row(s) from terminal_state`);
    }

    // Register in Supabase terminal_state — the sole source of truth.
    // Subagents register with is_subagent flag so they're tracked and prunable.
    // Previously subagents skipped registration entirely, leading to 165+ zombie rows
    // that only got pruned when a NEW terminal started (which might never happen).
    try {
      const { getTerminalId, upsertTerminal } = require(
        path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
      );
      const terminalId = getTerminalId();
      await upsertTerminal(terminalId, {
        type: isMainTerminal ? 'terminal' : 'subagent',
        pid,
        session_id: sessionId,
        focus: isMainTerminal ? '(booting)' : '(subagent)',
        activity: '',
        repo_context: repoContext || null,
        context_used_pct: 0,
        is_subagent: !isMainTerminal,
      });
    } catch {
      // Never block boot
    }

    // Subagents: registered but skip the rest (tab title, cross-repo patterns, awareness display)
    if (!isMainTerminal) {
      process.exit(0);
    }

    // Set terminal tab title — replaces [HUMAN]'s sticky notes.
    // Format: "Label [short-id]" or "Keel [short-id]" if no label.
    // The label gets set by Keel during grounding (setLabel).
    // At boot, we set the ID so [HUMAN] always has the number.
    try {
      const { getTerminalId, getTerminal } = require(
        path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
      );
      const tid = getTerminalId();
      const shortId = tid.replace('terminal-', '');
      const row = await getTerminal(tid);
      const label = row?.execution_context || 'Keel';
      // ANSI escape: \033]0;TITLE\007 sets both window and tab title
      process.stderr.write(`\x1b]0;${label} [${shortId}]\x07`);
    } catch { /* best-effort */ }

    // Surface cross-repo patterns
    if (repoContext) {
      surfaceCrossRepoPatterns(repoContext).catch(() => {});
    }

    // Show concurrent terminal awareness from Supabase
    try {
      const { getTerminalId, getAllTerminals } = require(
        path.resolve(__dirname, '..', 'lib', 'terminal-state.ts')
      );
      const myId = getTerminalId();
      const all = await getAllTerminals();
      const others = all.filter(t => {
        if (t.terminal_id === myId) return false;
        const ageMs = Date.now() - new Date(t.updated_at).getTime();
        return ageMs < 30 * 60 * 1000;
      });

      if (others.length > 0) {
        console.log('');
        console.log('╔══════════════════════════════════════════╗');
        console.log('║  CONCURRENT TERMINALS ACTIVE             ║');
        console.log('╠══════════════════════════════════════════╣');
        for (const other of others) {
          const age = Math.round((Date.now() - new Date(other.updated_at).getTime()) / 60000);
          const label = `${other.terminal_id} [${other.type || 'terminal'}]`;
          const focus = other.focus ? `: ${other.focus.slice(0, 40)}` : '';
          console.log(`║  ${label.padEnd(30)} (${age}m ago)${focus}`);
        }
        console.log('╠══════════════════════════════════════════╣');
        console.log('║  Each terminal chains independently.     ║');
        console.log('║  Supabase is concurrent-safe.            ║');
        console.log('╚══════════════════════════════════════════╝');
        console.log('');
      }
    } catch {
      // Supabase unavailable — no display
    }

    process.exit(0);
  });
} catch (err) {
  // Never block session start
  process.exit(0);
}
