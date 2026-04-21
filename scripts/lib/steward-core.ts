// @alienkind-core
/**
 * steward-core adapter — credential-injection layer over
 * packages/steward-core.
 *
 * The SSoT is packages/steward-core/index.ts. This adapter exists so
 * internal engines can call createEngine(prefix) without manually
 * assembling SupabaseConfig — credentials are read from process.env
 * at call time. Without it, every caller would need to know the env
 * var names and repeat the same config construction.
 *
 * DO NOT add engine logic here. Fix bugs in packages/steward-core/index.ts.
 *
 * Readers: intelligence-engine-*.ts, any deployment script that spins
 *   up a steward for its own prefix.
 * Writers: packages/steward-core/index.ts (upstream SSoT).
 */

const path = require('path');

const pkgPath = path.resolve(__dirname, '..', '..', 'packages', 'steward-core', 'index.ts');
const {
  createSteward: _createSteward,
  DEFAULT_SYNONYMS: _DEFAULT_SYNONYMS,
  GAP_PATTERNS: _GAP_PATTERNS,
} = require(pkgPath);

interface LegacyEngineConfig {
  prefix: string;
  extraSynonyms?: Record<string, string[]>;
}

/**
 * Create a steward engine for a specific prefix, with Supabase credentials
 * auto-injected from process.env. Accepts either a prefix string or a
 * config object for callers that want to pass extra synonyms.
 */
function createEngine(prefixOrConfig: string | LegacyEngineConfig) {
  const config: LegacyEngineConfig = typeof prefixOrConfig === 'string'
    ? { prefix: prefixOrConfig }
    : prefixOrConfig;

  return _createSteward({
    prefix: config.prefix,
    supabase: {
      url: process.env.SUPABASE_URL || '',
      key: process.env.SUPABASE_SERVICE_KEY || '',
    },
    synonyms: config.extraSynonyms || {},
  });
}

module.exports = {
  createEngine,
  createSteward: _createSteward,
  DEFAULT_SYNONYMS: _DEFAULT_SYNONYMS,
  GAP_PATTERNS: _GAP_PATTERNS,
};
