# Contradiction Handling

_How AlienKind handles contradictions between prior-stated facts and new information, and how a future instance knows which version to trust._

---

## The mechanism in one sentence

**Trust the freshest verifiable source.** The partner treats every recalled memory as a point-in-time observation, verifies against current state before acting, and updates the memory in place when reality has moved on.

That sentence is the whole policy. The four mechanisms below are how it's implemented.

---

## The four layers (in order of fire)

Contradiction handling in AlienKind is not a single module — it's a composition of four primitives that each handle a different contradiction shape. A forker who wants to extend or replace contradiction handling should start here.

### 1. Identity-kernel rule (fires in every session)

`identity/character.md` carries the policy prose:

> "If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it."

Loaded at session start via `@import` in `CLAUDE.md`. This is tier-3 (prompt) — it shapes default behavior but drifts under pressure. The layers below are the code-enforced backstop.

### 2. Aged-entry `system-reminder` (fires at memory access)

When the partner reads an auto-memory entry older than a staleness threshold, the harness injects:

> "This memory is N days old — memories are point-in-time observations. Verify against current code before asserting as fact."

This fires on every memory read, not per-session. The nudge is the reason the partner re-checks instead of trusting the cached fact.

### 3. Daily file append (fires on new observation)

The daily memory file at `memory/daily/YYYY-MM-DD.md` is append-only with timestamps. When the partner observes something that contradicts a prior claim, the new observation goes to today's daily file with a timestamp. The daily file is a narrative log — the newest entry is the freshest verifiable version.

Fresh instances read today's daily at boot (`scripts/ground.sh` + session-start hooks). The most recent entry for a given fact wins on tie.

### 4. Auto-memory update-in-place (fires on durable correction)

When a correction is durable (not just a one-off observation — a rule, a preference, a policy), the partner updates the auto-memory entry **in place** rather than writing a new duplicate. The `MEMORY.md` index stays single-source. This prevents the competing-versions problem that kills long-running memory systems.

If the correction is recurring, `learning-ledger.ts` also increments the occurrence count, and corrections crossing threshold trigger behavior-migration prompts.

---

## Which layer fires when

| Contradiction shape | Layer that handles it |
|---|---|
| One-off observation that a prior claim is stale | Layer 3 (daily append, timestamped) |
| Persistent policy update (preference, voice rule, working convention) | Layer 4 (update auto-memory in place) |
| Stale memory being retrieved right now | Layer 2 (aged-entry system-reminder nudges verification) |
| Default behavior the partner should take when anything conflicts | Layer 1 (identity-kernel rule) |
| Concurrent edits to the same FILE by multiple terminals | Not contradiction — see `scripts/hooks/conflict-guard.ts` |

---

## How a future instance resolves conflicts

Fresh instance boot sequence (relevant parts):

1. `CLAUDE.md` expands — identity-kernel rule loads into context.
2. `scripts/ground.sh` shows today's daily file — the freshest narrative wins for today-relevant facts.
3. Auto-memory entries load via `MEMORY.md` index — point-in-time observations with staleness-aware `system-reminder` on access.
4. If the partner retrieves a fact it's unsure about, it verifies against code / external state before asserting — per the identity-kernel rule.

The tiebreaker hierarchy: **current observable state > today's daily > auto-memory > identity-kernel default**.

---

## For forkers who want a single entry point

If the composition-of-four pattern is too scattered for your deployment, a thin wrapper module that invokes the four layers from one function is easy to add:

```ts
// scripts/lib/contradiction.ts (not shipped by default)
async function handleContradiction(
  priorClaim: string,
  currentObservation: string,
  context: { source: 'auto_memory' | 'daily' | 'file'; ref?: string },
): Promise<void> {
  // 1. Append to today's daily with timestamp
  // 2. If context.source === 'auto_memory', update the file in place
  // 3. If learning-ledger is wired, increment occurrence count
  // 4. Optionally log to circulation as a signal
}
```

Not shipped in the reference because most contradictions are handled organically by the four layers above. A single entry point is useful when a forker's partner needs programmatic contradiction handling (agent-to-agent protocol, auto-incorporation pipelines, etc.).

---

## Background

This doc was written after the Conn × Kael bench (2026-04-20, @T33R0 Rory + Conn). Bench task S06 asked both agents how their architecture handles contradictions. AlienKind's answer cited four layers that were real but scattered — no single entry point, no explicit doc naming the composition. This doc is that explicit naming.

_Last updated: 2026-04-21._
