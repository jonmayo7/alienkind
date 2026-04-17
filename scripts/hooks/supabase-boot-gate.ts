#!/usr/bin/env node

/**
 * Supabase Boot Gate — SessionStart hook.
 *
 * Queries first-class Supabase tables at boot and writes a marker file
 * so the compaction gate can verify the data was consumed.
 *
 * First-class boot queries:
 *   1. conversations — recent cross-channel conversation thread
 *   2. daily_events — today's structured events
 *   3. terminal_state — mycelium (who else is awake, what they're doing)
 *
 * Marker file: /tmp/alienkind-supabase-boot-{sessionId}.json
 *   { conversations: boolean, daily_events: boolean, terminal_state: boolean, queriedAt: string }
 *
 * If Supabase is unreachable, marker is written with false values.
 * The compaction gate checks this marker alongside identity kernel file reads.
 *
 * Fires on: SessionStart (AFTER ground.sh — ground.sh outputs the data,
 *           this hook verifies the queries succeeded)
 */

const fs = require('fs');
const path = require('path');

// Infrastructure dep — degrade gracefully on a fresh fork
let TIMEZONE: string;
try {
  TIMEZONE = require('../lib/constants.ts').TIMEZONE;
} catch {
  TIMEZONE = '${TZ:-UTC}';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const sessionId = hookData.session_id || 'unknown';
  if (sessionId === 'unknown') process.exit(0);

  const markerFile = `/tmp/alienkind-supabase-boot-${sessionId}.json`;

  // Load env for Supabase
  const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
  try {
    const { loadEnv } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'shared.ts'));
    const env = loadEnv();
    Object.assign(process.env, env);
  } catch {}

  const marker = {
    conversations: false,
    daily_events: false,
    terminal_state: false,
    queriedAt: new Date().toISOString(),
    sessionId,
  };

  // Query 1: conversations (recent 10)
  try {
    const { supabaseGet } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));
    const rows = await supabaseGet('conversations',
      'select=id&order=created_at.desc&limit=1',
      { timeout: 5000 }
    );
    marker.conversations = Array.isArray(rows);
  } catch (e) {
    // Supabase unavailable — marker stays false
  }

  // Query 2: daily_events (today)
  try {
    const { supabaseGet } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
    const rows = await supabaseGet('daily_events',
      `event_date=eq.${today}&select=id&limit=1`,
      { timeout: 5000 }
    );
    // Table might be empty but query succeeded = true
    marker.daily_events = Array.isArray(rows);
  } catch (e) {
    // Table might not exist yet (pre-migration) — that's OK, mark as true
    // to avoid blocking boot before migration runs
    const errMsg = (e && e.message) || '';
    if (errMsg.includes('404') || errMsg.includes('relation') || errMsg.includes('does not exist')) {
      // Table doesn't exist yet — don't block boot
      marker.daily_events = true;
    }
    // Otherwise (network error, auth error) — stays false
  }

  // Query 3: terminal_state (mycelium — who else is awake)
  try {
    const { supabaseGet } = require(path.join(ALIENKIND_DIR, 'scripts', 'lib', 'supabase.ts'));
    const rows = await supabaseGet('terminal_state',
      'select=terminal_id,type,focus&limit=1',
      { timeout: 5000 }
    );
    marker.terminal_state = Array.isArray(rows);
  } catch (e) {
    // Supabase unavailable — marker stays false
  }

  // Write marker
  try {
    fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2));
  } catch {}

  // Report status
  const allGood = marker.conversations && marker.daily_events && marker.terminal_state;
  if (allGood) {
    // Silent success — don't clutter boot output
  } else {
    const missing = [];
    if (!marker.conversations) missing.push('conversations');
    if (!marker.daily_events) missing.push('daily_events');
    if (!marker.terminal_state) missing.push('terminal_state (mycelium)');
    console.error(`[supabase-boot-gate] WARNING: Failed to query: ${missing.join(', ')}. Boot may be incomplete.`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
