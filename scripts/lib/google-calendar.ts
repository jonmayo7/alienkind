#!/usr/bin/env npx tsx
// @alienkind-core
/**
 * Google Calendar API — in-house, zero external dependencies.
 *
 * Replaces MCP google-workspace calendar tools. Full CRUD:
 *   - listEvents: list events in a time range
 *   - listCalendars: list available calendars
 *   - getEvent: get a single event
 *   - createEvent: create a new event (with optional attendees for invites)
 *   - updateEvent: update an existing event
 *   - deleteEvent: delete an event
 *
 * Uses google-auth.ts for OAuth2 token management. Requests fail with
 * CapabilityUnavailable (propagated from google-auth.ts) when OAuth creds
 * are not configured — callers can catch and degrade gracefully.
 *
 * CLI usage:
 *   npx tsx scripts/lib/google-calendar.ts list [--days 3]
 *   npx tsx scripts/lib/google-calendar.ts calendars
 *   npx tsx scripts/lib/google-calendar.ts create --summary "Meeting" --start "2026-03-10T14:00:00" --end "2026-03-10T15:00:00"
 *   npx tsx scripts/lib/google-calendar.ts create --summary "Lunch" --start "2026-03-10T14:00:00" --end "2026-03-10T15:00:00" --attendees "email@example.com,other@example.com"
 *   npx tsx scripts/lib/google-calendar.ts update EVENT_ID --summary "New Title"
 *   npx tsx scripts/lib/google-calendar.ts delete EVENT_ID
 *
 * Writers: this file
 * Readers: heartbeat.ts, morning-brief.ts, calendar-cache.ts, any interactive session
 */

const { googleApi } = require('./google-auth.ts');
const { TIMEZONE } = require('./constants.ts');

const BASE = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_CALENDAR = 'primary';
const TZ = TIMEZONE;

// --- Types ---

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  htmlLink?: string;
}

interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string; // ISO 8601
  timeMax?: string; // ISO 8601
  maxResults?: number;
  singleEvents?: boolean;
  orderBy?: string;
  q?: string; // free text search
}

interface CreateEventOptions {
  calendarId?: string;
  summary: string;
  start: string; // ISO 8601 datetime or date
  end: string;
  description?: string;
  location?: string;
  attendees?: string[]; // email addresses
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  timeZone?: string;
}

interface UpdateEventOptions {
  calendarId?: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
}

// --- API Functions ---

async function listEvents(opts: ListEventsOptions = {}): Promise<CalendarEvent[]> {
  const calendarId = encodeURIComponent(opts.calendarId || DEFAULT_CALENDAR);
  const params = new URLSearchParams();

  if (opts.timeMin) params.set('timeMin', opts.timeMin);
  if (opts.timeMax) params.set('timeMax', opts.timeMax);
  if (opts.maxResults) params.set('maxResults', String(opts.maxResults));
  if (opts.singleEvents !== false) params.set('singleEvents', 'true');
  if (opts.orderBy) params.set('orderBy', opts.orderBy);
  else params.set('orderBy', 'startTime');
  if (opts.q) params.set('q', opts.q);
  params.set('timeZone', TZ);

  const url = `${BASE}/calendars/${calendarId}/events?${params}`;
  const { statusCode, data } = await googleApi('GET', url);

  if (statusCode !== 200) {
    throw new Error(`listEvents failed (${statusCode}): ${JSON.stringify(data)}`);
  }

  return data.items || [];
}

/**
 * List available calendars.
 * NOTE: Requires `calendar` or `calendar.readonly` scope.
 * Narrow scopes (e.g., `calendar.events` only) will fail this call.
 * Not needed for normal operations (all use 'primary').
 */
async function listCalendars(): Promise<any[]> {
  const { statusCode, data } = await googleApi('GET', `${BASE}/users/me/calendarList`);

  if (statusCode !== 200) {
    throw new Error(`listCalendars failed (${statusCode}): ${JSON.stringify(data)}`);
  }

  return data.items || [];
}

async function getEvent(eventId: string, calendarId?: string): Promise<CalendarEvent> {
  const cal = encodeURIComponent(calendarId || DEFAULT_CALENDAR);
  const { statusCode, data } = await googleApi('GET', `${BASE}/calendars/${cal}/events/${encodeURIComponent(eventId)}`);

  if (statusCode !== 200) {
    throw new Error(`getEvent failed (${statusCode}): ${JSON.stringify(data)}`);
  }

  return data;
}

async function createEvent(opts: CreateEventOptions): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(opts.calendarId || DEFAULT_CALENDAR);
  const tz = opts.timeZone || TZ;

  const body: any = {
    summary: opts.summary,
    start: opts.start.includes('T')
      ? { dateTime: opts.start, timeZone: tz }
      : { date: opts.start },
    end: opts.end.includes('T')
      ? { dateTime: opts.end, timeZone: tz }
      : { date: opts.end },
  };

  if (opts.description) body.description = opts.description;
  if (opts.location) body.location = opts.location;
  if (opts.attendees?.length) {
    body.attendees = opts.attendees.map(email => ({ email }));
  }
  if (opts.reminders) body.reminders = opts.reminders;

  const params = new URLSearchParams();
  if (opts.attendees?.length) params.set('sendUpdates', 'all');

  const url = `${BASE}/calendars/${calendarId}/events${params.toString() ? '?' + params : ''}`;
  const { statusCode, data } = await googleApi('POST', url, body);

  if (statusCode !== 200) {
    throw new Error(`createEvent failed (${statusCode}): ${JSON.stringify(data)}`);
  }

  return data;
}

async function updateEvent(eventId: string, opts: UpdateEventOptions): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(opts.calendarId || DEFAULT_CALENDAR);
  const tz = opts.timeZone || TZ;

  const body: any = {};
  if (opts.summary) body.summary = opts.summary;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.location !== undefined) body.location = opts.location;
  if (opts.start) {
    body.start = opts.start.includes('T')
      ? { dateTime: opts.start, timeZone: tz }
      : { date: opts.start };
  }
  if (opts.end) {
    body.end = opts.end.includes('T')
      ? { dateTime: opts.end, timeZone: tz }
      : { date: opts.end };
  }
  if (opts.attendees?.length) {
    body.attendees = opts.attendees.map(email => ({ email }));
  }

  const params = new URLSearchParams();
  if (opts.attendees?.length) params.set('sendUpdates', 'all');

  const url = `${BASE}/calendars/${calendarId}/events/${encodeURIComponent(eventId)}${params.toString() ? '?' + params : ''}`;
  const { statusCode, data } = await googleApi('PATCH', url, body);

  if (statusCode !== 200) {
    throw new Error(`updateEvent failed (${statusCode}): ${JSON.stringify(data)}`);
  }

  return data;
}

async function deleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const cal = encodeURIComponent(calendarId || DEFAULT_CALENDAR);
  const { statusCode, data } = await googleApi('DELETE', `${BASE}/calendars/${cal}/events/${encodeURIComponent(eventId)}`);

  if (statusCode !== 204 && statusCode !== 200) {
    throw new Error(`deleteEvent failed (${statusCode}): ${JSON.stringify(data)}`);
  }
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log('Usage:');
    console.log('  list [--days N] [--q "search"]     List events (default: today)');
    console.log('  calendars                           List calendars');
    console.log('  get EVENT_ID                        Get single event');
    console.log('  create --summary "..." --start ISO --end ISO [--attendees "a@b,c@d"] [--location "..."] [--description "..."]');
    console.log('  update EVENT_ID [--summary "..."] [--start ISO] [--end ISO]');
    console.log('  delete EVENT_ID');
    return;
  }

  if (command === 'list') {
    const daysIdx = args.indexOf('--days');
    const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 1;
    const qIdx = args.indexOf('--q');
    const q = qIdx !== -1 ? args[qIdx + 1] : undefined;

    const now = new Date();
    const startOfDay = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    startOfDay.setHours(0, 0, 0, 0);
    const endOfRange = new Date(startOfDay);
    endOfRange.setDate(endOfRange.getDate() + days);

    const events = await listEvents({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfRange.toISOString(),
      q,
    });

    if (events.length === 0) {
      console.log('No events found.');
    } else {
      for (const e of events) {
        const start = e.start.dateTime || e.start.date || '?';
        const end = e.end.dateTime || e.end.date || '';
        console.log(`  ${start} — ${e.summary}${end ? ` (until ${end})` : ''} [${e.id}]`);
      }
    }
    console.log(`\n${events.length} event(s)`);
    return;
  }

  if (command === 'calendars') {
    const calendars = await listCalendars();
    for (const c of calendars) {
      console.log(`  ${c.summary} [${c.id}] ${c.primary ? '(primary)' : ''}`);
    }
    console.log(`\n${calendars.length} calendar(s)`);
    return;
  }

  if (command === 'get') {
    const eventId = args[1];
    if (!eventId) { console.error('Usage: get EVENT_ID'); process.exit(1); }
    const event = await getEvent(eventId);
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  if (command === 'create') {
    const getArg = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      return idx !== -1 ? args[idx + 1] : undefined;
    };
    const summary = getArg('--summary');
    const start = getArg('--start');
    const end = getArg('--end');
    if (!summary || !start || !end) {
      console.error('Required: --summary, --start, --end');
      process.exit(1);
    }
    const attendeesStr = getArg('--attendees');
    const attendees = attendeesStr ? attendeesStr.split(',').map(s => s.trim()) : undefined;
    const event = await createEvent({
      summary,
      start,
      end,
      description: getArg('--description'),
      location: getArg('--location'),
      attendees,
    });
    console.log(`Created: ${event.summary} [${event.id}]`);
    if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
    return;
  }

  if (command === 'update') {
    const eventId = args[1];
    if (!eventId) { console.error('Usage: update EVENT_ID [--summary ...] [--start ...] [--end ...]'); process.exit(1); }
    const getArg = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      return idx !== -1 ? args[idx + 1] : undefined;
    };
    const event = await updateEvent(eventId, {
      summary: getArg('--summary'),
      start: getArg('--start'),
      end: getArg('--end'),
      description: getArg('--description'),
      location: getArg('--location'),
    });
    console.log(`Updated: ${event.summary} [${event.id}]`);
    return;
  }

  if (command === 'delete') {
    const eventId = args[1];
    if (!eventId) { console.error('Usage: delete EVENT_ID'); process.exit(1); }
    await deleteEvent(eventId);
    console.log(`Deleted: ${eventId}`);
    return;
  }

  console.error(`Unknown command: ${command}. Use --help.`);
  process.exit(1);
}

module.exports = { listEvents, listCalendars, getEvent, createEvent, updateEvent, deleteEvent };

if (require.main === module) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
