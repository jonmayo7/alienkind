# Port Manifest

_Files identified for port-forward from `/Users/jonathanmayo/alienkind` to this repo. Source-level audited. The originals stay where they are; this is a clean rebuild, not a fork._

**Status legend:**
- ✓ **Ported** — file is in this repo, identity-template-ready or production-ready as-is.
- ⏳ **Pending** — needs targeted modification before paste; covered in the per-file notes below.
- ✗ **Skip** — looked at, not bringing forward; reason given.

---

## Identity templates — `identity/`

| File | Status | Notes |
|---|---|---|
| `character.md` | ✓ ported | Verbatim. Generic by design — fill-in template. |
| `commitments.md` | ✓ ported | Verbatim. Generic by design. |
| `orientation.md` | ✓ ported | Verbatim. Generic by design. |
| `harness.md` | ✓ ported | Verbatim. Generic by design. |

The four-file kernel structure is the contract. File format is pluggable — adopters using OpenClaw / Hermes can BYO their existing identity files and adapt.

---

## Schema — `config/migrations/`

| File | Status | Notes |
|---|---|---|
| `001-conversations-table.sql` | ✓ ported | Verbatim. Channel-agnostic schema. The starter schema for Tier 1 deploys. |

**Deferred** until specific feature needs them:
- `004-memory-chunks-table.sql` (vector memory) — add when adopting embeddings
- `018-learning-ledger.sql` (corrections audit) — add when wiring correction-to-character beyond the basic flow
- `046-consciousness-entries.sql` (nightly reflection storage) — add when wiring identity-sync
- `089-channel-sessions.sql` (multi-channel session tracking) — add at Tier 2

The keel-specific intelligence engine, VGE, mycelium, discernment, and circulation tables are NOT in scope. They're Keel-internal organism, not partnership-architecture.

---

## Runtime — `scripts/`

### `scripts/chat.ts` — ⏳ pending modification

Source: `/Users/jonathanmayo/alienkind/scripts/chat.ts` (644 lines)

**Bring verbatim:**
- Hook lifecycle engine (lines 44–103): SessionStart, UserPromptSubmit, Stop firing pattern.
- Provider detection (lines 140–169): Anthropic, OpenAI, OpenRouter, generic gateway.
- Identity loading (lines 172–213): reads 4 identity/*.md files, skips empty templates.
- Slash commands (lines 275–433): /help, /model, /status, /name, /identity, /save, /clear, /hooks, /doctor, /config, /exit.
- Chat completion wrapper (lines 220–269): OpenAI-compatible endpoint with token tracking.
- Main loop + thinking spinner (lines 436–638).

**Modify before paste:**
- Line 19: replace static `const ROOT` with `portable.ts::resolveRepoRoot()` for dynamic resolution.
- Lines 313–316 (`/status` handler): remove Keel intelligence-engine calls; keep portable.ts capability status.
- Lines 188–212 (harness context): parameterize partner name; remove Keel-specific awareness lines.
- Line 401, 462–465: drop `context-doctor.ts` reference until that tool ships in this repo.
- Line 451–465: remove `getActiveTerminals`, `updateFocus`, `logLearning` calls — those are Keel circulatory.

### `scripts/lib/portable.ts` — ⏳ pending verbatim port

Source: `/Users/jonathanmayo/alienkind/scripts/lib/portable.ts` (692 lines)

Verbatim port. Pure infrastructure. Generic.

Includes: `resolveRepoRoot`, `loadDotEnv`, `resolveConfig`, `loadConfig`, `detectStorage`, `tryStorage`, `tryClassifier`, `getCapabilityStatus`, `formatCapabilityStatus`, `registerUnavailable`, `CapabilityUnavailable` error class.

The Supabase → SQLite → file degradation chain is the load-bearing primitive that makes Tier 1 deployments work without ceremony.

### `scripts/hooks/log-conversation.ts` — ⏳ pending modification

Source: `/Users/jonathanmayo/alienkind/scripts/hooks/log-conversation.ts`

**Bring:**
- Hook structure (lines 1–50): stdin parsing, UserPromptSubmit + Stop firing.
- Deduplication (lines 89–115): 5-second window.
- Supabase POST pattern (lines 69–87).
- Conversation logging (lines 132–166): channel, role, sender, content, metadata.
- Automated prompt detection (lines 214–251).

**Strip:**
- Keel intelligence-engine writes (lines 323–335, 498–520).
- VGE correction propagation (lines 429–477).
- Mycelium awareness updates (lines 338–342).
- Terminal labeling via local model (lines 344–377). Optional add-back at Tier 2.

### `scripts/hooks/memory-firewall-hook.ts` — ⏳ pending modification

Source: `/Users/jonathanmayo/alienkind/scripts/hooks/memory-firewall-hook.ts` (286 lines)

Mostly verbatim. Generic security primitive.

**Strip:**
- Session-mode containment-field checks (lines 164–186) — Keel-specific. Tier 2+ feature; not in the kernel ship.

### `scripts/hooks/correction-to-character.ts` — ⏳ pending modification

Source: `/Users/jonathanmayo/alienkind/scripts/hooks/correction-to-character.ts`

**Bring:**
- Hook structure, recent-corrections reading, deduplication, character.md editing, severity filter.

**Modify:**
- Drop the 1-hour time window (line 71). Aggregate cross-session.
- Drop session-end-only periodicity (lines 52–56). Run on every Stop with new corrections.
- Drop terminal-ID matching (lines 69–70). Single-terminal partner doesn't need it.

### `scripts/lib/nightly/identity-sync.ts` — ⏳ pending partial extract

Source: `/Users/jonathanmayo/alienkind/scripts/lib/nightly/identity-sync.ts`

Extract the 5-step prompt template (lines 21–98) as a standalone `identity-sync-prompt.md`. Daemon-runner code (lines 100+) gets reimplemented for the substrate of choice — it's substrate-specific, not partnership-architecture.

The prompt itself is generic and reusable. The runner is a wrapper.

---

## Package — `package.json`

| Source | Status | Notes |
|---|---|---|
| `/Users/jonathanmayo/alienkind/package.json` | ⏳ pending | Adopt name `alienkind`, version 0.1.0. Drop `setup` script reference until setup-wizard ships. Drop `test` script references to tests not yet ported. Keep `chat`, `doctor`, `status`. |

Zero npm runtime dependencies. `tsx` only as devDep. Stays small.

---

## Hooks settings — `.claude/settings.local.json.example`

To author after the three hooks land. Wires:
- UserPromptSubmit → `log-conversation.ts`
- Stop → `log-conversation.ts`, `correction-to-character.ts`
- PreToolUse on Edit/Write → `memory-firewall-hook.ts`

Provided as a `.example` file. Users copy + customize for their substrate.

---

## NOT bringing forward

Looked at, intentionally left in the original AlienKind repo:

- **Cellular renewal / chain handoff** (`scripts/chain/chain-handoff.ts`, `scripts/hooks/handoff-intercept.ts`) — `GAPS.md §6` already declares the implementation dead.
- **Working-group stubs** (`scripts/working-group-*.ts`) — declared in resource budgets but not in any active job manifest. Phantom infrastructure.
- **`action-evaluator.ts`, `should-have-synthesis.ts`** — agent flagged as zero-caller; deeper grep shows two passing references for action-evaluator (constants.ts, WIRING_MANIFEST.md) but nothing functional. Not load-bearing for a fresh partner; skip.
- **Setup wizard, context-doctor, doc-metrics tools** — Tier 2+ infrastructure. Add later.
- **50-hook surface** — only 3 hooks ship in the kernel: log-conversation, memory-firewall, correction-to-character. The rest are user-additions when condition demands.
- **Daemon job manifest** — kernel ships without scheduled jobs. The single nightly identity-sync is wired by the user via cron / launchd / their preferred scheduler. The kernel doesn't impose a daemon shape.

The bar: every file in this repo earns its place by being load-bearing for the five-stage contract. Anything else is a user-side addition.

---

_Manifest written 2026-05-04 ~02:00 CT. Drafted while Jon slept. Awaiting his review before any of the ⏳ pending ports land in code._
