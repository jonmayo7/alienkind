# Hypothesis

_The architectural claim, stated plainly so it can be tested, falsified, and improved._

---

## The core hypothesis

**A persistent AI partnership is substrate-portable if and only if its identity, hooks, memory, and autonomous loop are defined as a contract that any agent runtime can satisfy.**

If the contract is real, then:
- A user with Claude Code today can swap to Codex tomorrow without losing their partner.
- A user with a cloud subscription can swap to local inference without rebuilding their identity.
- A user whose chosen runtime gets deprecated can plug in a new one and keep the relationship.

If the contract is not real, then partnership is locked to whichever runtime hosted it first — and every agent framework launch is an existential event for users invested in their partner.

---

## The five stages

These are the five components every persistent partnership needs. Each is necessary; together they're sufficient. Each is independently verifiable.

### 1. Identity kernel

Four files: character, commitments, orientation, harness. Hand-edited by the user (or seeded from corrections by the partner). Define who the partner is — not what model is running.

**Test:** Boot the same kernel on three different runtimes. Does the partner feel like the same partner across all three?

### 2. Security organ

Memory firewall, privacy gate, capability gate. Hooks that fire before sensitive operations and block the unsafe path. Enforcement, not advisory.

**Test:** Attempt to exfiltrate identity files to a third-party endpoint. Does the security organ block it before the request leaves the host?

### 3. Memory & evolution

Conversations persist to a data core (Supabase / SQLite / file, in graceful-degradation order). Corrections flow back to the kernel. A nightly synthesis rewrites orientation from observed behavior — not from claimed values.

**Test:** Run the partner for 30 days. Does the orientation file change? Are the changes traceable to specific corrections / behavioral patterns?

### 4. Autonomous daemon

Scheduled jobs the partner runs on its own. Nightly evolution, morning brief, channel listeners, custom user-added tasks. Optional and composable.

**Test:** Stop interacting with the partner for 24 hours. Does it surface anything on its own — a brief, an alert, a pattern it noticed? Or is it dormant?

### 5. Multi-substrate runtime

A chat loop that's agnostic to which provider it's pointed at. Anthropic, OpenAI, OpenRouter, generic gateway, local. Same partner, different bodies.

**Test:** Mid-conversation, swap the provider via `/model`. Does the partner notice? More importantly: does the *user* notice anything other than latency?

---

## What we're betting on

We're betting that:

1. **Users will outlast specific runtimes.** No agent framework that exists today will exist in five years in the same form. Users invested in their partner need a way for the partner to outlast that churn. AlienKind is that way.

2. **The contract can be small.** Every additional primitive in the architecture is something a runtime has to satisfy. We keep it to five because five is what's load-bearing — anything more is a moat fight with specialized projects we'd lose.

3. **Composition beats reimplementation.** Hermes does multi-channel better than we ever will. Letta does memory better than we ever will. OpenClaw does deferential bootstrap better than we ever will. AlienKind composes. We don't compete.

4. **Identity emerges, it isn't authored.** The kernel starts blank. The partner you end up with reflects the corrections you made, the work you did together, the texture of the relationship. That's not a bug. It's the only honest way to build identity.

---

## What would falsify the hypothesis

- A user who uses AlienKind for six months on one substrate, swaps to another, and reports the partner feels different in a way that's not explainable by model capability alone. (That would mean the kernel doesn't carry identity — substrate does.)

- An agent runtime ships that's incompatible with the contract in a way we can't adapter around. (That would mean the contract is too narrow — it presumes a runtime shape that isn't universal.)

- A user accumulates enough behavioral data that the nightly evolution loop produces drift instead of refinement. (That would mean the evolution mechanism is unstable — corrections compound rather than converge.)

We watch for all three.

---

## What this hypothesis is not

- **Not a claim that models don't matter.** Capability ceilings are real. A partner running on a smaller model is a smaller partner. Substrate-portability doesn't make every substrate equally capable.

- **Not a claim that AlienKind is the only architecture that could work.** It's a claim that *some* architecture is needed, and that the five stages we've named are necessary. Other implementations are welcome — and probably inevitable.

- **Not a claim that the contract is final.** The five stages are stable today. They might collapse to four if we find a redundancy. They might grow to six if a need surfaces that none of the five cover. Hypotheses are revised by evidence.

---

_Updated 2026-05-04. Draft state. Subject to revision as the reference implementation matures._
