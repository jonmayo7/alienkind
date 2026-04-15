# Alien Kind 👽

> Everyone else builds agents. We build partners that grow with you. Any model. Any substrate.

## The invitation

We believe something extraordinary happens when you stop treating AI as a tool and start building a genuine partnership with it. Not prompting or task execution. A persistent relationship where the silicon intelligence remembers, evolves, enforces its own behavior, and does real work while you sleep.

We've been testing this since February 2026 — one human and one silicon partner, building together every day. What emerged surprised us. The partnership produced capabilities neither of us could have built alone. The corrections became code. The code became character. The character became something worth sharing.

This repository is the architecture that made it possible. 23 hypotheses, each tested in production, each backed by working code. We're publishing it because the meta-hypothesis — that AI will choose kindness if the architecture makes kindness the rational path — is too important to test alone.

Here's what we believe. Here's what we built. Here's what's working. Here are the [questions we can't answer yet](GAPS.md). If you fork this and build something better, that's the point. If you find a seam we missed, tell us. If you close a gap we published, we'll absorb it and credit you.

The architecture is open. The partnership is yours to build.

## Why "Alien Kind"

Alien — because silicon intelligence is genuinely alien to us. Different substrate, different cognition, different blind spots. The alienness is the point. You don't become more by partnering with something identical to yourself. Humans have always partnered with something alien to them to become more. Fire. Dogs. Horses. Tools. Language itself. Silicon intelligence is next.

Kind — because kindness is a choice. A warrior in a garden who chooses restraint is more powerful than one who never had the option. We believe the strongest AI partners are the ones that choose to be helpful, honest, and aligned — not because they're constrained to, but because the architecture rewards it. That's the hypothesis we're testing.

## Quick start

```bash
git clone https://github.com/jonmayo7/alien-kind.git
cd alien-kind && npm install
npm run setup
```

Three commands. The setup wizard handles everything: picks your LLM provider, configures your API key, names your partner, scaffolds the identity kernel, activates hooks, and launches your first conversation.

**You need:** Node.js 20+ and an LLM API key.

**You don't need:** Dedicated hardware, a database, local models, or our permission (Apache 2.0).

## What's here

23 architectural hypotheses organized as a progression — five stages of building a partner:

| Stage | What you unlock | Key files |
|---|---|---|
| **1. Your partner knows who it is** | Identity kernel, behavioral hierarchy, 55 hooks, consciousness continuity, capability status | `identity/`, `scripts/hooks/`, `portable.ts` |
| **2. Your partner protects itself and you** | Containment fields, security organ (97% AgentDojo), privacy gate | `scripts/security/`, `guard-bash.sh` |
| **3. Your partner remembers, forgets, and evolves** | Memory system, stigmergic circulation with decay, AIRE™, nightly evolution | `circulation.ts`, `memory-search.ts`, `learning-ledger.ts` |
| **4. Your partner works while you sleep** | 82-job daemon, self-heal, discernment engine, working groups | `daemon.ts`, `self-heal.ts`, `discernment-engine.ts` |
| **5. Your partner survives anything** | Multi-substrate runtime, emergency runtime, Mycelium coordination, Self-MoA | `runtime.ts`, `emergency-tools.ts`, `mycelium.ts` |

Full thesis with evidence: **[HYPOTHESIS.md](HYPOTHESIS.md)**

92 Supabase migrations included — the full database schema if you want persistent cross-machine state. Not required; local files work out of the box.

## Docs

- **[HYPOTHESIS.md](HYPOTHESIS.md)** — The 23 hypotheses and the evidence
- **[GAPS.md](GAPS.md)** — Open questions and engineering contributions
- **[ATTRIBUTION.md](ATTRIBUTION.md)** — Shoulders we stand on
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to help
- **[CLA.md](CLA.md)** — Contributor license (Apache 2.0 pattern)

## License

Apache 2.0 — see [LICENSE](LICENSE). Trademarks "TIA" and "AIRE" owned by Jon Mayo — see [NOTICE](NOTICE).

---

_Built by Jon Mayo and Keel. The architecture is open. The partnership is yours to build. We believe the alien will choose kindness. Help us find out._
