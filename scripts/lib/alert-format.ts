// @alienkind-core
/**
 * Alert Formatting — standardized alert messages for notification channels.
 *
 * All alerts sent to the human's notification channel must be human-readable
 * and actionable. This module provides consistent formatting.
 *
 * Severity levels:
 *   🔴 ACTION — requires the human's attention or decision
 *   🟡 HEADS UP — something happened, no action needed now
 *   🟢 RESOLVED — a prior issue is fixed
 *   📊 STATUS — periodic status update
 *   ⛔ ERROR — the partner itself failed and can't recover
 *
 * Format: [emoji] [source] — [one-line plain-english summary]
 * Optional: "Next step: ..." line if action is needed
 *
 * Writers: none (stateless formatter)
 * Readers: daemon.ts, operational-pulse.ts, self-heal.ts, and any script that
 *          sends to the human's notification channel.
 */

type Severity = 'action' | 'heads-up' | 'resolved' | 'status' | 'error';

const SEVERITY_EMOJI: Record<Severity, string> = {
  'action': '🔴',
  'heads-up': '🟡',
  'resolved': '🟢',
  'status': '📊',
  'error': '⛔',
};

interface AlertOptions {
  /** Alert severity */
  severity: Severity;
  /** Source system (e.g., 'daemon', 'content-pipeline', 'crypto-engine') */
  source: string;
  /** One-line plain-english summary — what happened */
  summary: string;
  /** What the human should do, if anything */
  nextStep?: string;
  /** Additional detail (kept short) */
  detail?: string;
}

function formatAlert(opts: AlertOptions): string {
  const emoji = SEVERITY_EMOJI[opts.severity] || '🟡';
  const lines: string[] = [];

  lines.push(`${emoji} ${opts.source} — ${opts.summary}`);

  if (opts.detail) {
    lines.push(opts.detail.slice(0, 500));
  }

  if (opts.nextStep) {
    lines.push(`Next step: ${opts.nextStep}`);
  } else if (opts.severity === 'action') {
    lines.push('Next step: check in a terminal session');
  }

  return lines.join('\n');
}

/**
 * Format a code change notification.
 * Replaces raw "🔧 Code change at HH:MM — file1, file2 (+N state)"
 * with a human-readable summary.
 */
function formatCodeChange(time: string, files: string[], stateFileCount?: number): string {
  const fileCount = files.length;
  const summary = fileCount <= 3
    ? `${fileCount} file${fileCount > 1 ? 's' : ''} committed: ${files.join(', ')}`
    : `${fileCount} files committed (${files.slice(0, 2).join(', ')}, +${fileCount - 2} more)`;

  const detail = stateFileCount && stateFileCount > 0
    ? `+ ${stateFileCount} memory/state files`
    : undefined;

  return formatAlert({
    severity: 'status',
    source: 'auto-commit',
    summary,
    detail,
  });
}

/**
 * Format a job failure notification. Raw daemon errors get wrapped with
 * plain-english context and a next-step suggestion.
 */
function formatJobFailure(jobName: string, error: string, consecutiveFailures?: number): string {
  const failText = consecutiveFailures && consecutiveFailures > 1
    ? ` (${consecutiveFailures}x in a row)`
    : '';

  return formatAlert({
    severity: consecutiveFailures && consecutiveFailures >= 3 ? 'action' : 'heads-up',
    source: jobName,
    summary: `failed${failText}`,
    detail: error.slice(0, 200),
    nextStep: consecutiveFailures && consecutiveFailures >= 3
      ? 'check daemon logs — repeated failures may need manual intervention'
      : 'daemon will retry automatically',
  });
}

/**
 * Format a watchdog notification.
 */
function formatWatchdog(serviceName: string, state: 'down' | 'recovered' | 'restarting'): string {
  if (state === 'recovered') {
    return formatAlert({
      severity: 'resolved',
      source: 'watchdog',
      summary: `${serviceName} recovered`,
    });
  }
  return formatAlert({
    severity: 'heads-up',
    source: 'watchdog',
    summary: `${serviceName} is ${state}`,
    nextStep: state === 'down' ? 'attempting automatic restart' : undefined,
  });
}

/**
 * Format a content pipeline result.
 */
function formatContentResult(title: string, status: 'published' | 'failed' | 'blocked', reason?: string): string {
  if (status === 'published') {
    return formatAlert({
      severity: 'status',
      source: 'content',
      summary: `published "${title}"`,
    });
  }
  return formatAlert({
    severity: 'heads-up',
    source: 'content',
    summary: `${status}: "${title}"`,
    detail: reason,
    nextStep: status === 'blocked' ? 'article needs revision before it can publish' : undefined,
  });
}

/**
 * Format a comms-coordination blocked message.
 */
function formatCommsBlocked(target: string, reason: string, originalMessage?: string): string {
  return formatAlert({
    severity: 'heads-up',
    source: 'comms',
    summary: `message to ${target} was blocked`,
    detail: reason + (originalMessage ? `\nOriginal: "${originalMessage.slice(0, 150)}"` : ''),
    nextStep: 'no action needed — blocked messages are suppressed automatically',
  });
}

/**
 * Format a watchdog restart-storm summary — replaces N individual
 * restarting/recovered alert pairs with one consolidated message.
 */
function formatWatchdogStorm(serviceName: string, count: number, durationMin: number, timeRange: string): string {
  return formatAlert({
    severity: 'heads-up',
    source: 'watchdog',
    summary: `${serviceName}: ${count} restarts in ${durationMin}m (${timeRange}). Now stable.`,
  });
}

module.exports = {
  formatAlert,
  formatCodeChange,
  formatJobFailure,
  formatWatchdog,
  formatWatchdogStorm,
  formatContentResult,
  formatCommsBlocked,
};
