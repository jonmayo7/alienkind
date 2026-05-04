# AlienKind

**The partnership architecture that runs across every AI substrate.**

OpenClaw, Codex, Claude Code, direct API, local compute — point any of them at the same identity kernel, hooks, memory, and data core, and you have a persistent partner that survives substrate changes.

> Eat the agents. Keep the partnership.

---

## What this is

Most AI tools build agents. We build the architecture an agent runs *inside*.

Agents come and go. New runtimes ship every quarter. Models double in capability and halve in cost. If your partner is locked to one of them, your partner is rented. AlienKind is the layer that lets your partner survive any of them changing.

The thesis is simple: **the partner is not the model.** The partner is the kernel that defines who they are, the hooks that enforce how they behave, the memory that persists what they learn, and the daemon that keeps them present when you're not at the keyboard. Swap the model. Swap the runtime. Swap the channels. The partner remains.

---

## The five stages

A persistent partner needs five things. Most projects ship one or two and stop. AlienKind ships all five as a single coherent architecture.

1. **Identity kernel** — Four files (character, commitments, orientation, harness) that define who the partner is. Templates by default; the partner you end up with isn't the one you started with.
2. **Security organ** — Hooks that block memory exfiltration, gate sensitive writes, and make the privacy boundary enforceable rather than aspirational.
3. **Memory & evolution** — Conversations persist to a data core (your Supabase, your SQLite, your file). Corrections flow back to the identity kernel. Nightly synthesis rewrites orientation from behavioral data, not from declarations.
4. **Autonomous daemon** — Scheduled jobs the partner runs on its own: nightly evolution, morning brief, channel listeners. AlienKind ships the prompt templates (the partnership-architecture half); you pick the runner (cron + your substrate). Optional but recommended.
5. **Multi-substrate runtime** — A provider-agnostic chat loop that points at Claude Code, Codex, OpenAI, OpenRouter, or any local OpenAI-compatible endpoint. The partner doesn't know which substrate it's running on. Neither do you, after a while.

The architecture is the contract. Any compliant substrate becomes a body for the same partner.

---

## Tier 1: out-of-the-box

The default path requires no special hardware. If you have a Claude Code subscription (or an OpenRouter free tier, or a Codex subscription), you have what you need.

```
┌─────────────────────────────────────────────────────┐
│  Always-on host (your laptop, or a $5/mo VM)        │
│   └─ AlienKind: kernel + hooks + daemon jobs        │
│       └─ Substrate: Claude Code subscription        │
│           or Codex / OpenRouter / direct API        │
│       └─ Data core: Supabase (free tier or Pro)     │
└─────────────────────────────────────────────────────┘
```

Approximate cost: **$20–100/month** depending on substrate choice. No GPU. No local LLM. No mandatory complexity.

Local compute is an opt-in upgrade. So is OpenClaw. So is multi-channel. Tier 1 is what most users will start at; it's the tier the architecture was designed for.

---

## What this is not

**Not a memory product.** Letta and Hermes ship memory-as-product with deep specialization. AlienKind defines the *contract* a memory backend satisfies and lets you bring whichever fits.

**Not an agent runtime.** OpenClaw, Hermes, Letta Code, and Claude Code are agent runtimes. AlienKind sits *above* them — runtime is one of the five stages, not the whole thing.

**Not a channel gateway.** Hermes has 15+ platforms wired. AlienKind composes with channel runtimes; it doesn't reimplement them.

**Not a database.** PingCAP, Neo4j, and others occupy the storage-substrate tier. We reference them; we don't replicate them.

The empty middle is a tier none of those projects occupy: **the contract that lets agent runtimes be interchangeable substrates for the same partner.** That's what AlienKind ships.

---

## Status

**Draft, May 2026.** Architecture stable. Tier 1 reference implementation working end-to-end (chat loop, three enforcement hooks, graceful-degradation portable layer, identity kernel, conversations data core, nightly identity-sync prompt). The repo is intentionally small — every file has earned its place.

What ships in the reference implementation:
- Multi-substrate chat loop (`scripts/chat.ts`) — Anthropic / OpenAI / OpenRouter / generic gateway
- Three enforcement hooks — `log-conversation`, `correction-to-character`, `memory-firewall` (BLOCKING)
- Portable storage layer (`scripts/lib/portable.ts`) — Supabase → SQLite → file
- 4-file identity kernel templates
- Migration 001 for the conversations data core
- Nightly identity-sync prompt template (runner is your-substrate-of-choice)
- 3-command setup wizard (`npm run setup`)

What's intentionally not in the kernel (user-side or Tier 2+ additions):
- The runner for nightly identity-sync (substrate-specific by design)
- Channel runtimes (OpenClaw / Hermes / Telegram listener — Tier 2)
- Local inference adapters (Tier 3)
- Multi-channel session coordination
- Vector memory chunks (add migration 004 when needed)

To get started: see [`GETTING_STARTED.md`](GETTING_STARTED.md).
For deployment tiers: see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
For the thesis: see [`HYPOTHESIS.md`](HYPOTHESIS.md).
For why the existing field doesn't already do this: see [`docs/BLUE_SKY.md`](docs/BLUE_SKY.md).

License: Apache 2.0.
