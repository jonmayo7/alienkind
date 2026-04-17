// @alienkind-core
/**
 * invoke-keel — alias module that re-exports invoke.ts.
 *
 * Exists because several callers in the alienkind codebase (consciousness
 * engine, shared.ts barrel, self-heal) import from `./invoke-keel.ts` by
 * historical name. This thin alias avoids renaming every caller while keeping
 * the canonical implementation in one place (`invoke.ts`).
 */

module.exports = require('./invoke.ts');
