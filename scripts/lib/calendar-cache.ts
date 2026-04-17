// @alienkind-core
/**
 * Calendar cache — shared read/write for today's calendar events.
 *
 * Writers: heartbeat.js (hourly pulse, via the interactive session writing
 *          the file), daemon calendar-sync job (future)
 * Readers: awareness-pulse.ts hook, ground.sh, nightly-cycle.js, any session
 *
 * File: logs/calendar-cache.json (atomic writes)
 */

const fs = require('fs');
const path = require('path');
const { TIMEZONE } = require('./constants.ts');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const CACHE_FILE = path.join(ALIENKIND_DIR, 'logs', 'calendar-cache.json');
const MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours — stale after this

interface CalendarEvent {
  time: string;
  title: string;
  end?: string;
}

interface CalendarCache {
  date: string;
  updatedAt: string;
  events: CalendarEvent[];
}

/**
 * Write today's calendar events to cache.
 */
function writeCalendarCache(events: CalendarEvent[]): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const cache: CalendarCache = {
    date,
    updatedAt: now.toISOString(),
    events: events || [],
  };
  const tmpFile = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpFile, CACHE_FILE);
}

/**
 * Read today's calendar events from cache.
 * Returns null if cache is missing, stale, or from a different day.
 */
function readCalendarCache(): CalendarCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cache: CalendarCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

    // Wrong day
    if ((cache.date || '').slice(0, 10) !== todayStr) return null;

    // Too stale
    const age = now.getTime() - new Date(cache.updatedAt).getTime();
    if (age > MAX_AGE_MS) return null;

    return cache;
  } catch {
    return null;
  }
}

module.exports = { writeCalendarCache, readCalendarCache, CACHE_FILE };
