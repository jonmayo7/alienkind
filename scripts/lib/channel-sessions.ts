/**
 * Channel Sessions — Supabase-backed persistent session management for all listener channels.
 *
 * Single source of truth for session state across Telegram, Discord, War Room,
 * and any future conversational channel. Each channel maintains one active
 * session that accumulates context across messages. Daily rotation prevents
 * context exhaustion. Message cap triggers rotation when a session gets too long.
 *
 * All sessions stored in `channel_sessions` Supabase table (migration 089).
 *
 * Readers: telegram-bot.ts, discord-engine.ts, war-room.ts, daemon.ts (future)
 * Writers: this module (via Supabase REST)
 */

const crypto = require('crypto');
const { supabaseGet, supabasePost, supabasePatch } = require('./supabase.ts');

// Lowered from 50 → 25 after RCA 2026-04-14: war room sessions with long messages
// exceeded 1M context when combined with 70 injected history messages + identity kernel.
// 25 messages of implicit --resume context + 50 injected = manageable. Token-based
// budgeting is the real fix but message count is the immediate prevention.
const SESSION_MAX_MESSAGES = 25;

type LogFn = (level: string, msg: string) => void;

interface ChannelSession {
  sessionId: string;
  isResume: boolean;
}

// In-memory cache per process to avoid hitting Supabase on every message
const sessionCache = new Map<string, { sessionId: string; date: string; messageCount: number }>();

async function getChannelSession(channel: string, log: LogFn): Promise<ChannelSession> {
  const today = new Date().toISOString().slice(0, 10);
  const cached = sessionCache.get(channel);

  // Check in-memory cache first — always resume if we have a cached session
  if (cached && cached.date === today && cached.messageCount < SESSION_MAX_MESSAGES) {
    return { sessionId: cached.sessionId, isResume: true };
  }

  // Check Supabase for active session
  try {
    const rows = await supabaseGet('channel_sessions', `select=id,session_id,session_date,message_count&channel=eq.${channel}&active=eq.true&limit=1`);

    if (rows && rows.length > 0) {
      const row = rows[0];
      if (row.session_date === today && row.message_count < SESSION_MAX_MESSAGES) {
        // Valid active session — cache it.
        // Only resume if the session has been used at least once (message_count > 0).
        // A session with message_count=0 was created in Supabase but never passed to
        // Claude CLI as --session-id. Resuming it fails ("No conversation found").
        // RCA 2026-04-14: force-rotated session → new row created → message_count=0 →
        // next call tried to resume → Claude: "No conversation found" → dead session loop.
        const shouldResume = row.message_count > 0;
        sessionCache.set(channel, { sessionId: row.session_id, date: today, messageCount: row.message_count });
        log('INFO', `[sessions] ${channel}: ${shouldResume ? 'resuming' : 'starting'} session ${row.session_id} (${row.message_count} messages)`);
        return { sessionId: row.session_id, isResume: shouldResume };
      }

      // Stale or exhausted — rotate
      await supabasePatch('channel_sessions', `id=eq.${row.id}`, { active: false, rotated_at: new Date().toISOString() });
      log('INFO', `[sessions] ${channel}: rotated stale session ${row.session_id} (date: ${row.session_date}, messages: ${row.message_count})`);
    }
  } catch (err: any) {
    log('WARN', `[sessions] Supabase read failed: ${err.message} — creating new session`);
  }

  // Create new session
  const newSessionId = crypto.randomUUID();
  try {
    await supabasePost('channel_sessions', {
      channel,
      session_id: newSessionId,
      session_date: today,
      message_count: 0,
      active: true,
    });
  } catch (err: any) {
    log('WARN', `[sessions] Supabase write failed: ${err.message} — session will still work (stateless fallback)`);
  }

  sessionCache.set(channel, { sessionId: newSessionId, date: today, messageCount: 0 });
  log('INFO', `[sessions] ${channel}: new session ${newSessionId}`);
  return { sessionId: newSessionId, isResume: false };
}

async function recordSessionMessage(channel: string, log: LogFn): Promise<void> {
  const cached = sessionCache.get(channel);
  if (cached) {
    cached.messageCount++;
  }

  try {
    const rows = await supabaseGet('channel_sessions', `select=id,message_count&channel=eq.${channel}&active=eq.true&limit=1`);
    if (rows && rows.length > 0) {
      await supabasePatch('channel_sessions', `id=eq.${rows[0].id}`, {
        message_count: rows[0].message_count + 1,
        last_used_at: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    log('WARN', `[sessions] Failed to record message: ${err.message}`);
  }
}

/**
 * Force-invalidate a channel's session (context exhaustion, dead session, etc.).
 * Clears in-memory cache and deactivates in Supabase so next getChannelSession creates fresh.
 */
async function invalidateChannelSession(channel: string, reason: string, log: LogFn): Promise<void> {
  sessionCache.delete(channel);
  try {
    const rows = await supabaseGet('channel_sessions', `select=id,session_id&channel=eq.${channel}&active=eq.true&limit=1`);
    if (rows && rows.length > 0) {
      await supabasePatch('channel_sessions', `id=eq.${rows[0].id}`, { active: false, rotated_at: new Date().toISOString() });
      log('INFO', `[sessions] ${channel}: invalidated session ${rows[0].session_id} — ${reason}`);
    }
  } catch (err: any) {
    log('WARN', `[sessions] Failed to invalidate: ${err.message}`);
  }
}

module.exports = { getChannelSession, recordSessionMessage, invalidateChannelSession, SESSION_MAX_MESSAGES };
