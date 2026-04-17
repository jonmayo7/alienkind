// @alienkind-core
/**
 * Alert Dispatcher — single source of truth for alerting the human.
 *
 * Every alert in the organism routes through this ONE function.
 * It handles: formatting (alert-format.ts), delivery (telegram.ts),
 * daily logging (logToDaily), and cooldown (no spam).
 *
 * Delivery gracefully degrades: if no TELEGRAM_BOT_TOKEN is configured, the
 * alert is still logged to the daily file. No Telegram? No crash. The partner
 * just writes to disk.
 *
 * Usage:
 *   const { alertOperator } = require('./lib/alert-dispatcher.ts');
 *   alertOperator({ severity: 'heads-up', source: 'trading', summary: 'BTC drift accelerating' });
 *
 * Writers: this module → notification channel + daily file
 * Readers: every script that needs to alert the human
 */

const { formatAlert } = require('./alert-format.ts');
const { logToDaily } = require('./env.ts');

// Cooldown tracking — prevents duplicate alerts of the same type
const COOLDOWN_MS = 300_000; // 5 min default
const lastAlertTimes: Record<string, number> = {};

type Severity = 'action' | 'heads-up' | 'resolved' | 'status' | 'error';

interface AlertOptions {
  severity: Severity;
  source: string;
  summary: string;
  detail?: string;
  nextStep?: string;
  /** Cooldown key — alerts with the same key are throttled. Defaults to source+summary. */
  cooldownKey?: string;
  /** Custom cooldown in ms (default: 5 min) */
  cooldownMs?: number;
  /** Skip daily file logging (default: false) */
  skipDailyLog?: boolean;
  /** Skip Telegram delivery (default: false) */
  skipTelegram?: boolean;
}

/**
 * Alert the human. ONE function for all alerts in the organism.
 *
 * 1. Checks cooldown (no spam)
 * 2. Formats via alert-format.ts
 * 3. Sends to the configured notification channel (Telegram, if set up)
 * 4. Logs to today's daily file
 *
 * Returns true if the alert was sent, false if throttled by cooldown.
 */
function alertOperator(opts: AlertOptions): boolean {
  const key = opts.cooldownKey || `${opts.source}:${opts.summary.slice(0, 50)}`;
  const cooldown = opts.cooldownMs ?? COOLDOWN_MS;

  // Cooldown check
  const lastSent = lastAlertTimes[key] || 0;
  if (Date.now() - lastSent < cooldown) {
    return false; // throttled
  }
  lastAlertTimes[key] = Date.now();

  // Format
  const formatted = formatAlert({
    severity: opts.severity,
    source: opts.source,
    summary: opts.summary,
    detail: opts.detail,
    nextStep: opts.nextStep,
  });

  // Deliver to Telegram (best-effort). If Telegram isn't configured, the alert
  // is still logged to the daily file and returned as sent=true — forkers
  // without Telegram still get alerts in their daily memory trail.
  //
  // NOTE: do NOT call processQueue() here. It races with sendTelegram() and
  // double-delivers: sendTelegram enqueues to disk synchronously before the
  // HTTP send completes, processQueue finds that file, and fires a second
  // send on the same message. Queue drain happens on startup from listeners.
  if (!opts.skipTelegram) {
    try {
      const { sendTelegram: _send } = require('./telegram.ts');
      const env = process.env;
      const botToken = env.TELEGRAM_BOT_TOKEN;
      const chatId = env.TELEGRAM_ALERTS_CHAT_ID || env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        _send(formatted, { botToken, chatId, log: () => {} });
      }
    } catch {
      // Telegram unavailable — alert still logged to daily file
    }
  }

  // Log to daily file
  if (!opts.skipDailyLog) {
    const severityLabel = opts.severity.toUpperCase().replace('-', ' ');
    logToDaily(`${severityLabel}: ${opts.source} — ${opts.summary}`, 'Alert');
  }

  return true;
}

/**
 * Convenience: alert about a job failure.
 */
function alertJobFailure(jobName: string, error: string, consecutiveFailures?: number): boolean {
  return alertOperator({
    severity: consecutiveFailures && consecutiveFailures >= 3 ? 'action' : 'heads-up',
    source: jobName,
    summary: `failed${consecutiveFailures && consecutiveFailures > 1 ? ` (${consecutiveFailures}x in a row)` : ''}`,
    detail: error.slice(0, 200),
    nextStep: consecutiveFailures && consecutiveFailures >= 3
      ? 'check daemon logs — repeated failures may need manual intervention'
      : 'daemon will retry automatically',
    cooldownKey: `job-failure:${jobName}`,
  });
}

/**
 * Convenience: alert about a service status change.
 */
function alertService(serviceName: string, state: 'down' | 'recovered' | 'restarting'): boolean {
  return alertOperator({
    severity: state === 'recovered' ? 'resolved' : 'heads-up',
    source: 'watchdog',
    summary: `${serviceName} ${state === 'recovered' ? 'recovered' : `is ${state}`}`,
    nextStep: state === 'down' ? 'attempting automatic restart' : undefined,
    cooldownKey: `service:${serviceName}:${state}`,
  });
}

module.exports = { alertOperator, alertJobFailure, alertService };
