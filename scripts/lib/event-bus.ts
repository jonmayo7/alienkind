// @alienkind-core
/**
 * Event Bus — Nervous System
 *
 * Organism Architecture: replaces polling with instant reactions.
 * Two channels:
 *   1. Local events (Node EventEmitter) — in-process, daemon-internal
 *   2. Signals (Supabase terminal_signals) — cross-terminal, persisted
 *
 * Borrows from:
 *   - SBP: pheromone model with intensity + decay + trail namespaces
 *   - AG2: pub/sub event bus with handler registration
 *   - gptme/Bob: Supabase as coordination substrate
 *
 * Usage (daemon):
 *   const bus = createEventBus({ nodeId: 'daemon', log });
 *   bus.on('signal:decision', async (signal) => { ... });
 *   bus.on('file:scripts/', async (event) => { ... });
 *   await bus.start();
 *
 * Usage (hooks — signal CRUD only, no listeners):
 *   const { emitSignal, getUnreadSignals, acknowledgeSignal } = require('./event-bus.ts');
 *   await emitSignal({ from: terminalId, type: 'decision', trail: 'phase4', payload: { ... } });
 *   const signals = await getUnreadSignals(terminalId);
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

// --- Types ---

interface Signal {
  id?: string;
  from_node: string;
  to_node?: string | null;
  signal_type: string;
  trail: string;
  intensity: number;
  payload: Record<string, any>;
  acknowledged_by?: string[];
  created_at?: string;
  expires_at?: string | null;
}

interface FileEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: string;
}

interface EventHandler {
  pattern: string;       // event type pattern (exact match or prefix with *)
  handler: (event: any) => Promise<void> | void;
  name: string;
}

interface EventBusOptions {
  nodeId: string;
  log: (level: string, msg: string) => void;
  watchPaths?: string[];    // filesystem paths to watch
  signalPollMs?: number;    // fallback poll interval for signals (default: 5000)
}

// --- Env loading ---
let envLoaded = false;
function ensureEnv(): void {
  if (envLoaded) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    try {
      const { loadEnv } = require(path.resolve(__dirname, 'shared.ts'));
      Object.assign(process.env, loadEnv());
    } catch {}
  }
  envLoaded = true;
}

function getSupabase() {
  ensureEnv();
  return require(path.resolve(__dirname, 'supabase.ts'));
}

// --- Signal CRUD (stateless, importable by hooks) ---

/**
 * Emit a signal to terminal_signals table.
 * Visible to all terminals. Persisted until acknowledged or expired.
 */
async function emitSignal(opts: {
  from: string;
  type: string;
  trail?: string;
  payload: Record<string, any>;
  to?: string;
  intensity?: number;
  expiresInMs?: number;
}): Promise<string | null> {
  try {
    const { supabasePost } = getSupabase();

    // Auto-enrich: look up sender's human-readable label from terminal_state
    let enrichedPayload = { ...opts.payload };
    if (!enrichedPayload.sender_label) {
      try {
        const { getTerminal } = require(path.resolve(__dirname, 'terminal-state.ts'));
        const senderState = await getTerminal(opts.from);
        if (senderState?.execution_context) {
          enrichedPayload.sender_label = senderState.execution_context;
        }
      } catch { /* best-effort enrichment */ }
    }

    const signal: Record<string, any> = {
      from_node: opts.from,
      signal_type: opts.type,
      trail: opts.trail || 'general',
      intensity: opts.intensity ?? 1.0,
      payload: enrichedPayload,
    };
    if (opts.to) signal.to_node = opts.to;
    if (opts.expiresInMs) {
      signal.expires_at = new Date(Date.now() + opts.expiresInMs).toISOString();
    }
    const result = await supabasePost('terminal_signals', signal, {
      prefer: 'return=representation',
    });
    return result?.[0]?.id || result?.id || null;
  } catch (e: any) {
    return null;
  }
}

/**
 * Get unread signals for a terminal.
 * A signal is "unread" if the terminal's ID is not in acknowledged_by.
 */
async function getUnreadSignals(terminalId: string, opts?: {
  trail?: string;
  type?: string;
  limit?: number;
}): Promise<Signal[]> {
  try {
    const { supabaseGet } = getSupabase();
    // PostgREST query — keep it simple, avoid nested or/and complexity.
    // Filter: not acknowledged by this terminal, broadcast or directed, not expired.
    let query = `select=*&order=created_at.desc&limit=${opts?.limit || 20}`;

    // Not acknowledged by this terminal (array does not contain)
    query += `&acknowledged_by=not.cs.{${terminalId}}`;

    // Broadcast OR directed to this terminal (single or= clause)
    query += `&or=(to_node.is.null,to_node.eq.${encodeURIComponent(terminalId)})`;

    // Type filter
    if (opts?.type) query += `&signal_type=eq.${encodeURIComponent(opts.type)}`;

    // Trail filter
    if (opts?.trail) query += `&trail=eq.${encodeURIComponent(opts.trail)}`;

    // Note: expiry filtering done in JS after fetch to avoid PostgREST or= conflicts.

    const results = await supabaseGet('terminal_signals', query) || [];

    // Post-fetch: filter out expired signals (avoids PostgREST or= conflicts)
    const now = Date.now();
    return results.filter((s: any) => {
      if (!s.expires_at) return true; // no expiry = always valid
      return new Date(s.expires_at).getTime() > now;
    });
  } catch {
    return [];
  }
}

/**
 * Acknowledge a signal (mark as consumed by this terminal).
 * Uses Postgres array append to avoid clobbering concurrent acknowledgments.
 */
async function acknowledgeSignal(signalId: string, terminalId: string): Promise<void> {
  try {
    ensureEnv();
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return;

    // Use RPC to atomically append to array (PostgREST doesn't support array_append directly)
    // Fallback: read-modify-write with the array
    const { supabaseGet } = getSupabase();
    const rows = await supabaseGet('terminal_signals', `id=eq.${signalId}&select=acknowledged_by`);
    if (!rows || rows.length === 0) return;

    const current: string[] = rows[0].acknowledged_by || [];
    if (current.includes(terminalId)) return; // already acknowledged

    const { supabasePatch } = getSupabase();
    await supabasePatch(
      'terminal_signals',
      `id=eq.${signalId}`,
      { acknowledged_by: [...current, terminalId] }
    );
  } catch {}
}

/**
 * Acknowledge multiple signals at once.
 */
async function acknowledgeSignals(signalIds: string[], terminalId: string): Promise<void> {
  for (const id of signalIds) {
    await acknowledgeSignal(id, terminalId);
  }
}

/**
 * Clean up expired signals. Called by daemon periodically.
 */
async function cleanupExpiredSignals(): Promise<number> {
  try {
    const { supabaseDelete } = getSupabase();
    // Delete signals past their expiry
    await supabaseDelete(
      'terminal_signals',
      `expires_at=not.is.null&expires_at.lt.${new Date().toISOString()}`
    );
    // Delete signals older than 24h that have been acknowledged by all active terminals
    // (For now, just delete signals older than 48h regardless)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await supabaseDelete('terminal_signals', `created_at=lt.${cutoff}`);
    return 0;
  } catch {
    return -1;
  }
}

/**
 * Reinforce an existing signal (increase intensity, SBP pattern).
 * Used when multiple sources confirm the same finding.
 */
async function reinforceSignal(signalId: string, addIntensity: number = 0.2): Promise<void> {
  try {
    const { supabaseGet, supabasePatch } = getSupabase();
    const rows = await supabaseGet('terminal_signals', `id=eq.${signalId}&select=intensity`);
    if (!rows || rows.length === 0) return;
    const newIntensity = Math.min(1.0, (rows[0].intensity || 0.5) + addIntensity);
    await supabasePatch('terminal_signals', `id=eq.${signalId}`, { intensity: newIntensity });
  } catch {}
}

// --- Event Bus (stateful, for daemon/listeners) ---

function createEventBus(options: EventBusOptions) {
  const { nodeId, log, watchPaths = [], signalPollMs = 5000 } = options;
  const emitter = new EventEmitter();
  const handlers: EventHandler[] = [];
  let signalPollTimer: any = null;
  let fileWatchers: any[] = [];
  let running = false;

  /**
   * Register a handler for an event pattern.
   * Patterns: 'signal:decision', 'signal:*', 'file:add', 'file:*', 'local:*'
   */
  function on(pattern: string, handler: (event: any) => Promise<void> | void, name: string): void {
    handlers.push({ pattern, handler, name });
    log('INFO', `[event-bus] Handler registered: ${name} → ${pattern}`);
  }

  /**
   * Dispatch an event to matching handlers.
   */
  async function dispatch(eventType: string, event: any): Promise<void> {
    for (const h of handlers) {
      try {
        if (h.pattern === eventType ||
            (h.pattern.endsWith('*') && eventType.startsWith(h.pattern.slice(0, -1)))) {
          await h.handler(event);
        }
      } catch (e: any) {
        log('ERROR', `[event-bus] Handler ${h.name} failed: ${e?.message || e}`);
      }
    }
  }

  /**
   * Emit a local event (in-process only, not persisted).
   */
  function emitLocal(type: string, payload: any): void {
    dispatch(`local:${type}`, payload).catch(() => {});
  }

  /**
   * Emit a signal (persisted to Supabase, cross-terminal).
   */
  async function signal(type: string, trail: string, payload: Record<string, any>, opts?: {
    to?: string;
    intensity?: number;
    expiresInMs?: number;
  }): Promise<string | null> {
    const signalId = await emitSignal({
      from: nodeId,
      type,
      trail,
      payload,
      to: opts?.to,
      intensity: opts?.intensity,
      expiresInMs: opts?.expiresInMs,
    });

    // Also dispatch locally so daemon handlers react immediately
    dispatch(`signal:${type}`, { signal_type: type, trail, payload, from_node: nodeId }).catch(() => {});

    return signalId;
  }

  /**
   * Poll for new signals (fallback when Supabase Realtime isn't available).
   * Interactive terminals use this via hooks instead.
   */
  async function pollSignals(): Promise<void> {
    try {
      const signals = await getUnreadSignals(nodeId, { limit: 10 });
      for (const sig of signals) {
        log('INFO', `[event-bus] Signal received: ${sig.signal_type} from ${sig.from_node} (trail: ${sig.trail})`);
        await dispatch(`signal:${sig.signal_type}`, sig);
        if (sig.id) await acknowledgeSignal(sig.id, nodeId);
      }
    } catch (e: any) {
      log('WARN', `[event-bus] Signal poll failed: ${e?.message || e}`);
    }
  }

  /**
   * Start filesystem watchers using chokidar (if available) or fs.watch.
   * Returns a promise that resolves when all watchers are ready.
   */
  async function startFileWatchers(): Promise<void> {
    if (watchPaths.length === 0) return;

    const readyPromises: Promise<void>[] = [];

    for (const watchPath of watchPaths) {
      try {
        // Ensure directory exists
        if (!fs.existsSync(watchPath)) {
          fs.mkdirSync(watchPath, { recursive: true });
        }

        // Try chokidar first (better macOS support — uses native FSEvents)
        let watcher: any;
        try {
          const chokidar = require('chokidar');
          watcher = chokidar.watch(watchPath, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
          });
        } catch {
          // Fallback to fs.watch
          watcher = fs.watch(watchPath, { recursive: true }, (eventType: string, filename: string) => {
            if (!filename) return;
            const fullPath = path.join(watchPath, filename);
            const fileEvent: FileEvent = {
              type: eventType === 'rename' ? 'add' : 'change',
              path: fullPath,
              timestamp: new Date().toISOString(),
            };
            dispatch(`file:${fileEvent.type}`, fileEvent).catch(() => {});
          });
          fileWatchers.push(watcher);
          log('INFO', `[event-bus] Filesystem watcher (fs.watch): ${watchPath}`);
          continue;
        }

        // Wait for chokidar to be ready before considering the bus started
        readyPromises.push(new Promise<void>((resolve) => {
          watcher.on('ready', () => {
            log('INFO', `[event-bus] Filesystem watcher ready (chokidar): ${watchPath}`);
            resolve();
          });
          // Safety: resolve after 5s even if ready never fires
          setTimeout(resolve, 5000);
        }));

        watcher.on('add', (filePath: string) => {
          dispatch('file:add', { type: 'add', path: filePath, timestamp: new Date().toISOString() }).catch(() => {});
        });
        watcher.on('change', (filePath: string) => {
          dispatch('file:change', { type: 'change', path: filePath, timestamp: new Date().toISOString() }).catch(() => {});
        });
        watcher.on('unlink', (filePath: string) => {
          dispatch('file:unlink', { type: 'unlink', path: filePath, timestamp: new Date().toISOString() }).catch(() => {});
        });

        fileWatchers.push(watcher);
        log('INFO', `[event-bus] Filesystem watcher (chokidar): ${watchPath}`);
      } catch (e: any) {
        log('WARN', `[event-bus] Failed to watch ${watchPath}: ${e?.message || e}`);
      }
    }

    // Wait for all watchers to be ready
    if (readyPromises.length > 0) {
      await Promise.all(readyPromises);
    }
  }

  /**
   * Start the event bus. Begins signal polling and filesystem watching.
   */
  async function start(): Promise<void> {
    if (running) return;
    running = true;

    log('INFO', `[event-bus] Starting for node: ${nodeId}`);

    // Start signal polling (fallback — Supabase Realtime can replace this later)
    signalPollTimer = setInterval(pollSignals, signalPollMs);
    // Initial poll
    await pollSignals();

    // Start filesystem watchers (await ready)
    await startFileWatchers();

    // Schedule expired signal cleanup (every 30 min)
    setInterval(cleanupExpiredSignals, 30 * 60 * 1000);

    log('INFO', `[event-bus] Running. ${handlers.length} handlers, ${watchPaths.length} watch paths, ${signalPollMs}ms signal poll`);
  }

  /**
   * Stop the event bus. Clean shutdown.
   */
  function stop(): void {
    running = false;
    if (signalPollTimer) {
      clearInterval(signalPollTimer);
      signalPollTimer = null;
    }
    for (const w of fileWatchers) {
      try {
        if (typeof w.close === 'function') w.close();
      } catch {}
    }
    fileWatchers = [];
    log('INFO', `[event-bus] Stopped`);
  }

  return {
    on,
    emit: emitLocal,
    signal,
    start,
    stop,
    pollSignals,
    getHandlerCount: () => handlers.length,
  };
}

// --- Convenience: Blocking Signal ---

/**
 * Emit a BLOCKING signal to a specific terminal.
 * This will pause the target terminal at its next tool call,
 * display the content, and require acknowledgment before proceeding.
 */
async function emitBlockingSignal(opts: {
  from: string;
  to: string;
  trail?: string;
  message: string;
  question?: string;
  action_required?: string;
  details?: string[] | string;
  expiresInMs?: number;
}): Promise<string | null> {
  return emitSignal({
    from: opts.from,
    type: 'blocking',
    trail: opts.trail || 'coordination',
    to: opts.to,
    intensity: 1.0,
    payload: {
      message: opts.message,
      question: opts.question,
      action_required: opts.action_required,
      details: opts.details,
    },
    expiresInMs: opts.expiresInMs || 1 * 60 * 60 * 1000, // 1 hour default — blocking signals are urgent, stale ones are noise
  });
}

/**
 * Emit an AWARENESS signal to all terminals (broadcast).
 * Non-blocking. Shows in mycelium-awareness hook output.
 */
async function emitAwarenessSignal(opts: {
  from: string;
  trail?: string;
  summary: string;
  details?: string[] | string;
  intensity?: number;
  expiresInMs?: number;
}): Promise<string | null> {
  return emitSignal({
    from: opts.from,
    type: 'awareness',
    trail: opts.trail || 'general',
    intensity: opts.intensity ?? 0.8,
    payload: {
      summary: opts.summary,
      details: opts.details,
    },
    expiresInMs: opts.expiresInMs || 4 * 60 * 60 * 1000, // 4 hours default
  });
}

// --- Format signals for hook display ---

/**
 * Format unread signals for display in mycelium-awareness hook output.
 */
function formatSignalsForDisplay(signals: Signal[]): string {
  if (!signals || signals.length === 0) return '';

  const lines: string[] = [
    '',
    '╔══════════════════════════════════════════╗',
    '║  INCOMING SIGNALS                        ║',
    '╠══════════════════════════════════════════╣',
  ];

  for (const sig of signals.slice(0, 5)) {
    const age = Date.now() - new Date(sig.created_at || '').getTime();
    const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` :
                   age < 3600000 ? `${Math.round(age / 60000)}m ago` :
                   `${Math.round(age / 3600000)}h ago`;
    const intensity = sig.intensity >= 0.8 ? '🔴' : sig.intensity >= 0.5 ? '🟡' : '⚪';

    const senderName = sig.payload?.sender_label || sig.from_node;
    lines.push(`║  ${intensity} [${sig.signal_type}] from ${senderName} (${ageStr})`);

    // Show first ~80 chars of payload summary
    const summary = sig.payload?.summary || sig.payload?.message || JSON.stringify(sig.payload).slice(0, 80);
    lines.push(`║    trail: ${sig.trail} | ${summary}`);
  }

  if (signals.length > 5) {
    lines.push(`║  ... and ${signals.length - 5} more`);
  }

  lines.push('╚══════════════════════════════════════════╝');
  return lines.join('\n');
}

module.exports = {
  // Stateless CRUD (for hooks and scripts)
  emitSignal,
  getUnreadSignals,
  acknowledgeSignal,
  acknowledgeSignals,
  cleanupExpiredSignals,
  reinforceSignal,
  formatSignalsForDisplay,

  // Convenience: two-tier signals
  emitBlockingSignal,
  emitAwarenessSignal,

  // Stateful bus (for daemon/listeners)
  createEventBus,
};
