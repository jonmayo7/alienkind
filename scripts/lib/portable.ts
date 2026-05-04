// @alienkind-core
/**
 * Portable — Graceful degradation layer for open-source hooks.
 *
 * Every hook in the open-source release imports this module instead of
 * directly calling Supabase, local models, or hardcoded paths. It provides:
 *
 *   1. resolveRepoRoot() — finds the repo root from anywhere
 *   2. tryStorage(fn, fallback) — tries Supabase, falls back gracefully
 *   3. tryClassifier(prompt, fallback) — tries local 9B, falls back to regex
 *   4. resolveConfig(key, default) — reads from partner-config.json
 *   5. getCapabilityStatus() — reports what's available vs degraded
 *
 * Design principle: a forker clones the repo, drops in an API key, and
 * everything RUNS. Some features are degraded. Nothing is broken. As they
 * add infrastructure (Supabase, local models), capabilities automatically
 * upgrade from degraded to full.
 *
 * The capability status is injected into the agent's context at boot,
 * so the partner KNOWS its own state and can tell its human what to
 * invest in next. The partner helps you build the partner.
 *
 * Usage:
 *   import { resolveRepoRoot, tryStorage, tryClassifier, getCapabilityStatus } from './portable.ts';
 *
 * Readers: every open-source hook, ground.sh, consciousness-boot.
 * Writers: stateless — reads config and probes infrastructure.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// ============================================================================
// Configuration
// ============================================================================

// Load .env file into process.env if it exists (no dependency — hand-rolled)
// This is critical: a forker creates .env from .env.example but nothing
// loads it into the Node process. Without this, capability status can't
// detect API keys and hooks can't read credentials.
function loadDotEnv(): void {
  try {
    const envPath = path.join(resolveRepoRoot(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key]) {  // don't override existing env vars
        process.env[key] = value;
      }
    }
  } catch { /* .env loading is best-effort */ }
}

// Cache for config and capability status (computed once per process)
let _configCache: Record<string, any> | null = null;
let _capabilityCache: CapabilityStatus | null = null;
let _repoRootCache: string | null = null;
let _envLoaded = false;

const CONFIG_FILENAME = 'partner-config.json';
const DEFAULT_CLASSIFIER_PORT = 8005;
const DEFAULT_CLASSIFIER_TIMEOUT = 3000;
const STORAGE_PROBE_TIMEOUT = 2000;

// ============================================================================
// 1. Repo root resolution
// ============================================================================

/**
 * Find the repository root by walking up from this file's location,
 * looking for a directory that contains CLAUDE.md or .git.
 * Never returns a hardcoded path.
 */
function resolveRepoRoot(): string {
  if (_repoRootCache) return _repoRootCache;

  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, 'CLAUDE.md')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      _repoRootCache = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Fallback: use process.cwd()
  _repoRootCache = process.cwd();
  return _repoRootCache;
}

/**
 * Resolve a path relative to the repo root.
 * Usage: resolvePath('identity/character.md') → /full/path/to/character.md
 */
function resolvePath(relPath: string): string {
  return path.join(resolveRepoRoot(), relPath);
}

// ============================================================================
// 2. Configuration
// ============================================================================

interface PartnerConfig {
  // Storage backend
  storage?: 'supabase' | 'sqlite' | 'file';
  supabase_url?: string;
  supabase_key?: string;
  sqlite_path?: string;

  // Local model (Tier 2 — Pursuit of Sovereignty)
  classifier_host?: string;
  classifier_port?: number;

  // Identity kernel file paths (relative to repo root)
  identity_files?: string[];

  // Protected paths for memory firewall
  protected_paths?: string[];

  // Daily memory file pattern
  daily_file_pattern?: string;

  // Any key-value pair the forker wants to add
  [key: string]: any;
}

/**
 * Load partner-config.json from the repo root.
 * Returns empty config (all defaults) if file doesn't exist.
 * Never throws — missing config is the normal first-run state.
 */
function loadConfig(): PartnerConfig {
  if (_configCache) return _configCache;

  const configPath = path.join(resolveRepoRoot(), CONFIG_FILENAME);
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    _configCache = {};
  }
  return _configCache!;
}

/**
 * Get a config value with a default fallback.
 * Usage: resolveConfig('classifier_port', 8005)
 */
function resolveConfig<T>(key: string, defaultValue: T): T {
  const config = loadConfig();
  return (config[key] as T) ?? defaultValue;
}

// ============================================================================
// 3. Storage abstraction
// ============================================================================

type StorageBackend = 'supabase' | 'sqlite' | 'file' | 'none';

/**
 * Detect which storage backend is available.
 */
function detectStorage(): StorageBackend {
  const config = loadConfig();

  // Explicit config takes priority
  if (config.storage) return config.storage;

  // Check for Supabase credentials (env or config)
  const supabaseUrl = config.supabase_url || process.env.SUPABASE_URL;
  const supabaseKey = config.supabase_key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (supabaseUrl && supabaseKey) return 'supabase';

  // Check for SQLite path
  if (config.sqlite_path) return 'sqlite';

  // Default: file-based storage (always works)
  return 'file';
}

/**
 * Try a storage operation. If the configured backend isn't available,
 * fall back gracefully.
 *
 * Usage:
 *   const result = await tryStorage(
 *     async () => {
 *       // Try the Supabase/SQLite call
 *       return await supabaseQuery(...)
 *     },
 *     'default-value-or-null',
 *     'register-terminal'  // operation name for logging
 *   );
 *
 * On failure: returns the fallback, logs a warning to stderr.
 * Never throws. Never blocks.
 */
async function tryStorage<T>(
  fn: () => Promise<T>,
  fallback: T,
  operationName?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const name = operationName || 'storage';
    process.stderr.write(
      `[portable] ${name}: storage unavailable (${err?.message?.slice(0, 80) || 'unknown'}), using fallback\n`,
    );
    return fallback;
  }
}

/**
 * Write to local file as the universal fallback storage.
 * Creates directories as needed. Appends to JSON-lines format.
 */
function writeLocalFallback(filename: string, data: any): void {
  const dir = path.join(resolveRepoRoot(), '.partner', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n', 'utf8');
}

/**
 * Read from local file fallback storage.
 * Returns array of parsed JSON lines, or empty array if file doesn't exist.
 */
function readLocalFallback(filename: string): any[] {
  const filePath = path.join(resolveRepoRoot(), '.partner', 'state', filename);
  try {
    return fs.readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ============================================================================
// 4. Classifier abstraction (local model / cloud fallback)
// ============================================================================

/**
 * Try a local classifier call. If the local model isn't available,
 * return the fallback value.
 *
 * Usage:
 *   const result = await tryClassifier(
 *     'Is this content safe? Respond SAFE or UNSAFE.',
 *     'SAFE',  // fallback if classifier unavailable
 *     'memory-firewall'  // operation name for logging
 *   );
 *
 * Graceful degradation: regex-based hooks continue to work.
 * The classifier adds semantic depth when available.
 */
async function tryClassifier(
  prompt: string,
  fallback: string,
  operationName?: string,
): Promise<string> {
  const config = loadConfig();
  const host = config.classifier_host || 'http://localhost';
  const port = config.classifier_port || DEFAULT_CLASSIFIER_PORT;
  const timeout = DEFAULT_CLASSIFIER_TIMEOUT;

  return new Promise<string>((resolve) => {
    const body = JSON.stringify({
      model: 'classifier',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 50,
      stream: false,
    });

    const url = new URL(`${host}:${port}/v1/chat/completions`);

    const timer = setTimeout(() => {
      req.destroy();
      const name = operationName || 'classifier';
      process.stderr.write(
        `[portable] ${name}: classifier timeout (${timeout}ms), using regex fallback\n`,
      );
      resolve(fallback);
    }, timeout);

    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(data);
          const content = j.choices?.[0]?.message?.content || '';
          // Strip <think> blocks
          const clean = content
            .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
            .replace(/<think>[\s\S]*$/g, '')
            .trim();
          resolve(clean || fallback);
        } catch {
          resolve(fallback);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      const name = operationName || 'classifier';
      process.stderr.write(
        `[portable] ${name}: classifier unavailable, using regex fallback\n`,
      );
      resolve(fallback);
    });

    req.write(body);
    req.end();
  });
}

// ============================================================================
// 5. Capability status — the partner knows its own state
// ============================================================================

interface CapabilityEntry {
  name: string;
  status: 'active' | 'degraded' | 'unavailable';
  detail: string;
  upgrade?: string;  // what the human can do to upgrade this
}

interface CapabilityStatus {
  timestamp: string;
  storage: StorageBackend;
  capabilities: CapabilityEntry[];
  summary: string;
  hooksFiring: number;
  hooksDegraded: number;
  hooksUnavailable: number;
}

/**
 * Probe all infrastructure and return a structured capability report.
 * Called at boot time and injected into the agent's context.
 *
 * The agent reads this and can tell its human:
 * "I'm running with 64 of 67 hooks. My memory is local-only.
 * If you want cross-machine persistence, I can help you set up Supabase."
 */
async function getCapabilityStatus(): Promise<CapabilityStatus> {
  if (_capabilityCache) return _capabilityCache;

  // Load .env on first capability check (hand-rolled, zero deps)
  if (!_envLoaded) { loadDotEnv(); _envLoaded = true; }

  const capabilities: CapabilityEntry[] = [];

  // --- Identity kernel ---
  const config = loadConfig();
  const identityFiles = config.identity_files || [
    'identity/character.md', 'identity/commitments.md',
    'identity/orientation.md', 'identity/harness.md',
  ];
  const identityFound = identityFiles.filter(f => fs.existsSync(resolvePath(f)));
  if (identityFound.length === identityFiles.length) {
    capabilities.push({ name: 'Identity kernel', status: 'active', detail: `${identityFound.length} files loaded` });
  } else if (identityFound.length > 0) {
    capabilities.push({
      name: 'Identity kernel',
      status: 'degraded',
      detail: `${identityFound.length}/${identityFiles.length} files found`,
      upgrade: `Create the missing files: ${identityFiles.filter(f => !fs.existsSync(resolvePath(f))).join(', ')}`,
    });
  } else {
    capabilities.push({
      name: 'Identity kernel',
      status: 'unavailable',
      detail: 'No identity files found',
      upgrade: 'Create your identity kernel in the identity/ directory. Start with identity/character.md — describe who your partner is.',
    });
  }

  // --- Storage ---
  const storage = detectStorage();
  if (storage === 'supabase') {
    capabilities.push({ name: 'Storage', status: 'active', detail: 'Supabase (persistent, cross-machine)' });
  } else if (storage === 'sqlite') {
    capabilities.push({ name: 'Storage', status: 'active', detail: 'SQLite (persistent, single machine)' });
  } else {
    capabilities.push({
      name: 'Storage',
      status: 'degraded',
      detail: 'Local files (persistent on this machine only)',
      upgrade: 'Configure Supabase or SQLite in partner-config.json for cross-machine persistence.',
    });
  }

  // --- Classifier (local model) ---
  const classifierAvailable = await probeClassifier();
  if (classifierAvailable) {
    capabilities.push({ name: 'Local classifier', status: 'active', detail: 'Semantic security scanning enabled' });
  } else {
    capabilities.push({
      name: 'Local classifier',
      status: 'degraded',
      detail: 'Regex-only security (semantic layer unavailable)',
      upgrade: 'Run a local model on port 8005 (e.g., vLLM-MLX with a 9B classifier) for semantic injection detection.',
    });
  }

  // --- Hooks ---
  const settingsPath = path.join(resolveRepoRoot(), '.claude', 'settings.local.json');
  let hookCount = 0;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks || {};
    for (const groups of Object.values(hooks)) {
      for (const group of groups as any[]) {
        const subHooks = group.hooks || [group];
        hookCount += subHooks.length;
      }
    }
    capabilities.push({ name: 'Hooks', status: 'active', detail: `${hookCount} hooks registered` });
  } catch {
    capabilities.push({
      name: 'Hooks',
      status: 'unavailable',
      detail: 'No hook configuration found',
      upgrade: 'Copy the default settings.local.json to .claude/ to enable behavioral enforcement hooks.',
    });
  }

  // --- Multi-instance (mycelium) ---
  if (storage === 'supabase') {
    capabilities.push({ name: 'Multi-instance', status: 'active', detail: 'Terminal coordination via shared state' });
  } else {
    capabilities.push({
      name: 'Multi-instance',
      status: 'unavailable',
      detail: 'Single-terminal only (no shared state backend)',
      upgrade: 'Configure Supabase in partner-config.json to enable multi-terminal coordination.',
    });
  }

  // --- API key (check common providers + any gateway/router key) ---
  const hasApiKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    Object.keys(process.env).some(k => /API_KEY|GATEWAY.*KEY/i.test(k) && process.env[k]?.length > 10)
  );
  if (hasApiKey) {
    capabilities.push({ name: 'LLM substrate', status: 'active', detail: 'API key configured' });
  } else {
    capabilities.push({
      name: 'LLM substrate',
      status: 'unavailable',
      detail: 'No API key found',
      upgrade: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment or .env file.',
    });
  }

  // --- Gateway (alternate-substrate fallback) ---
  // Probed directly, not via registry — registry only populates when something
  // actually tries to call the gateway.
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (gatewayKey && gatewayKey.length > 5) {
    capabilities.push({
      name: 'Gateway fallback',
      status: 'active',
      detail: 'Alternate-substrate fallback configured (primary can fail over to GPT/Grok/Gemini)',
    });
  } else {
    capabilities.push({
      name: 'Gateway fallback',
      status: 'unavailable',
      detail: 'No alternate-substrate fallback configured',
      upgrade: 'Sign up for an OpenAI-compatible gateway (Vercel AI Gateway, OpenRouter, or self-hosted LiteLLM). Set AI_GATEWAY_API_KEY in .env to enable.',
    });
  }

  // --- Local models (Tier 2) ---
  const localModelAvailable = await probeLocalModel();
  if (localModelAvailable) {
    capabilities.push({ name: 'Local models', status: 'active', detail: 'Sovereign inference available (Tier 2)' });
  } else {
    capabilities.push({
      name: 'Local models',
      status: 'unavailable',
      detail: 'Cloud-only (Tier 1)',
      upgrade: 'Set up vLLM-MLX or Ollama for local model inference. See docs/SOVEREIGNTY.md.',
    });
  }

  // --- Daily memory ---
  const dailyPattern = config.daily_file_pattern || 'memory/daily/YYYY-MM-DD.md';
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = resolvePath(dailyPattern.replace('YYYY-MM-DD', today));
  if (fs.existsSync(dailyPath)) {
    capabilities.push({ name: 'Daily memory', status: 'active', detail: `Today's file exists (${today})` });
  } else {
    capabilities.push({
      name: 'Daily memory',
      status: 'degraded',
      detail: 'No daily file for today',
      upgrade: 'The grounding script creates this automatically. Run ground.sh or start a session.',
    });
  }

  // Build summary
  const active = capabilities.filter(c => c.status === 'active').length;
  const degraded = capabilities.filter(c => c.status === 'degraded').length;
  const unavailable = capabilities.filter(c => c.status === 'unavailable').length;

  const summary = `${active} active, ${degraded} degraded, ${unavailable} unavailable out of ${capabilities.length} capabilities.`;

  _capabilityCache = {
    timestamp: new Date().toISOString(),
    storage,
    capabilities,
    summary,
    hooksFiring: hookCount,
    hooksDegraded: degraded,
    hooksUnavailable: unavailable,
  };

  return _capabilityCache;
}

/**
 * Format capability status as human-readable text for context injection.
 */
function formatCapabilityStatus(status: CapabilityStatus): string {
  const lines = ['## Partner Capability Status', ''];

  for (const cap of status.capabilities) {
    const icon = cap.status === 'active' ? '✓' : cap.status === 'degraded' ? '⚠' : '✗';
    lines.push(`${icon} **${cap.name}**: ${cap.detail}`);
    if (cap.upgrade) {
      lines.push(`  → ${cap.upgrade}`);
    }
  }

  lines.push('', `*${status.summary}*`);
  return lines.join('\n');
}

// ============================================================================
// Internal probes
// ============================================================================

function probeClassifier(): Promise<boolean> {
  const config = loadConfig();
  const host = config.classifier_host || 'http://localhost';
  const port = config.classifier_port || DEFAULT_CLASSIFIER_PORT;

  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, STORAGE_PROBE_TIMEOUT);
    const url = new URL(`${host}:${port}/v1/models`);

    const req = http.get(url, (res: any) => {
      clearTimeout(timer);
      resolve(res.statusCode === 200);
      res.resume(); // drain
    });

    req.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function probeLocalModel(): Promise<boolean> {
  // Check port 8001 (typical local inference server)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, STORAGE_PROBE_TIMEOUT);

    const req = http.get('http://localhost:8001/v1/models', (res: any) => {
      clearTimeout(timer);
      resolve(res.statusCode === 200);
      res.resume();
    });

    req.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// ============================================================================
// 6. Capability registry — runtime record of what's unavailable and how to enable
// ============================================================================
//
// The stub pattern: every module that depends on external infrastructure (gateway
// keys, local models, Supabase, etc.) registers itself as unavailable the first
// time it's called without configuration. Callers wrap in try/catch and get a
// typed CapabilityUnavailable error instead of a mystery crash.
//
// The partner reads this registry to answer questions like "what can you do
// right now, and what would unlock if I set up X?". This is how the partner
// helps you build the partner — continuously, not as a one-time setup step.

interface UnavailableInfo {
  reason: string;
  enableWith: string;
  docs?: string;
  firstLoggedAt: string;
}

/**
 * Typed error thrown when a capability is unavailable due to missing config.
 * Callers that expect optional capabilities should wrap in try/catch and
 * read err.enableWith to tell the human what to configure.
 */
class CapabilityUnavailable extends Error {
  capability: string;
  enableWith: string;
  docs?: string;

  constructor(capability: string, enableWith: string, docs?: string) {
    super(`Capability '${capability}' unavailable. ${enableWith}`);
    this.name = 'CapabilityUnavailable';
    this.capability = capability;
    this.enableWith = enableWith;
    this.docs = docs;
  }
}

const _capabilityRegistry: Map<string, UnavailableInfo> = new Map();

/**
 * Register a capability as unavailable. First call per process logs to stderr
 * so forkers see what they're missing. Subsequent calls are silent (no spam).
 *
 * Usage (inside a stubbed module):
 *   registerUnavailable('gateway', {
 *     reason: 'No AI_GATEWAY_API_KEY configured',
 *     enableWith: 'Set AI_GATEWAY_API_KEY in .env to enable alternate-substrate fallback',
 *     docs: 'docs/capabilities/gateway.md',
 *   });
 *   throw new CapabilityUnavailable('gateway', '...');
 */
function registerUnavailable(capability: string, info: { reason: string; enableWith: string; docs?: string }): void {
  if (!_capabilityRegistry.has(capability)) {
    _capabilityRegistry.set(capability, { ...info, firstLoggedAt: new Date().toISOString() });
    process.stderr.write(`[portable] Capability '${capability}' unavailable: ${info.reason}. Enable: ${info.enableWith}\n`);
  }
}

/**
 * Read the registry. The partner can call this to answer "what's missing, and how do I get it?".
 */
function getUnavailableCapabilities(): Array<UnavailableInfo & { capability: string }> {
  return Array.from(_capabilityRegistry.entries()).map(([capability, info]) => ({ capability, ...info }));
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  resolveRepoRoot,
  resolvePath,
  loadConfig,
  resolveConfig,
  detectStorage,
  tryStorage,
  writeLocalFallback,
  readLocalFallback,
  tryClassifier,
  getCapabilityStatus,
  formatCapabilityStatus,
  // Capability registry — stub pattern support
  CapabilityUnavailable,
  registerUnavailable,
  getUnavailableCapabilities,
};
