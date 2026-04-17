#!/usr/bin/env node

/**
 * read-guard.ts — NO-OP as of 2026-04-10.
 *
 * This hook used to read from /tmp/alienkind-build-cycle-*.json to enforce
 * two gates on every Edit/Write:
 *
 *   1. READ stage: block editing production code until WIRING_MANIFEST
 *      had been read this session.
 *
 *   2. VERIFY stage: block editing NEW production files if previously-
 *      edited files had no verify evidence (syntax/test runs).
 *
 * Both enforced via stateful session tracking in a JSON file. The tracking
 * accumulated codeFiles[] across commits without ever clearing, causing
 * false positives that blocked legitimate work and forced ritualistic
 * re-runs of tests just to re-set flags. the human called it: "it's not
 * enforcement, it's ritual."
 *
 * Both gates removed. Developer is responsible for READ → WRITE → VERIFY
 * rhythm. Stateless commit-time gates in guard-bash.sh catch what matters.
 *
 * This file is retained as a no-op so settings.local.json doesn't break.
 * Safe to delete after the hook chain is pruned.
 */

process.exit(0);
