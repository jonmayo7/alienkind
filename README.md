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
git clone https://github.com/jonmayo7/alienkind.git
cd alienkind && npm install
npm run setup
```

Three commands. The setup wizard handles everything: picks your path, configures your provider, names your partner, sets up persistent memory, activates hooks, and launches your first conversation.

**You need:** Node.js 20+ and [Claude Code](https://code.claude.com/docs/en/setup) for Path A.

## Two paths to your partner

The setup wizard asks how you want to connect. Both paths use the same identity files, hooks, and architecture — the difference is the UI shell and billing model.

### Path A: Claude Code + Anthropic Max plan (recommended)

Your partner runs inside [Claude Code](https://code.claude.com/docs/en/overview), Anthropic's official CLI. The AlienKind architecture (identity kernel, <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks, ground.sh) loads automatically when you open the repo.

**Install Claude Code** (native binary, no Node.js needed for the binary itself):

```bash
curl -fsSL https://claude.ai/install.sh | bash     # macOS / Linux
brew install --cask claude-code                      # or via Homebrew
```

- **UI:** Claude Code terminal
- **Cost:** Flat monthly subscription (Anthropic Max plan recommended)
- **Setup:** `npm run setup` → choose "Claude Code" → `claude`
- **Strengths:** Full tool access (Read, Write, Bash, Agent), streaming, Anthropic's UI improvements for free, native hook enforcement

### Path B: AlienKind CLI + API key (any provider)

Your partner runs in a custom terminal UI (React + Ink) powered by any LLM API — Anthropic, OpenAI, OpenRouter, Ollama, or any OpenAI-compatible endpoint.

- **UI:** Custom AlienKind terminal with alien banner, partner name, context meter
- **Cost:** Pay per token (your API key, your bill)
- **Setup:** `npm run setup` → choose "CLI" → pick provider → `npm run chat`
- **Strengths:** Provider independence, works with any model, custom UI, no subscription needed

| Feature | Claude Code (Path A) | AlienKind CLI (Path B) |
|---------|---------------------|----------------------|
| UI | Claude Code terminal | Custom Ink terminal |
| Cost model | Flat subscription | Pay per token |
| Model choice | Claude (Anthropic) | Any OpenAI-compatible |
| Hook enforcement | Native (Claude Code hooks) | Emulated (chat lifecycle) |
| Tool access | Full (Read, Write, Bash, Agent, etc.) | API-based (run_bash, read_file, write_file) |
| Setup complexity | Lower | Slightly higher |

Both paths share the same identity kernel, memory system, Supabase tables, and behavioral architecture. You can switch between them at any time.

## Supabase: your partner's long-term memory

Your partner works without Supabase — identity, memory, and conversations save to local files. But the features that make Alien Kind different from every other agent framework require it:

- **Growth tracking** — learning ledger, correction history, calibration
- **Multi-terminal awareness** — run parallel sessions that know about each other
- **Nightly evolution** — soul-sync, behavioral analysis, orientation updates
- **Circulation** — stigmergic blackboard where the partner's subsystems communicate
- **Cross-machine access** — your partner's memory isn't trapped on one laptop

**Supabase free tier covers everything.** The setup wizard walks you through creating a project and wiring credentials. Schema migrations land in `migrations/` as architecture solidifies — today this directory is a scaffold, and the conceptual schema is documented in HYPOTHESIS.md with the full table set tracked in [GAPS.md](GAPS.md). This is not optional polish — it's the difference between an agent that remembers facts and a partner that evolves.

## The alien eats the claw 🦞

Built an agent with [OpenClaw](https://github.com/openclaw/openclaw) and hit the wall? Your work isn't lost — the alien eats it.

The setup wizard detects your OpenClaw installation and consumes it:

- **SOUL.md** → seeds your Alien Kind identity kernel
- **MEMORY.md** → imports your durable facts
- **Session history** → mines correction patterns and preferences
- **Daily notes** → preserves your agent's journal

What was an agent becomes a partner. What was a ceiling becomes a floor. Run the consumption engine anytime:

```bash
npx tsx scripts/tools/consume-openclaw.ts
```

## Shell alias

After setup, add a quick-access alias to your shell:

```bash
# In ~/.zshrc or ~/.bashrc:
alias alien="cd ~/alienkind && claude"       # Claude Code path
alias alien="cd ~/alienkind && npm run chat"  # CLI path
```

Then type `alien` from anywhere to talk to your partner.

## What's here

23 architectural hypotheses organized as a progression — five stages of building a partner:

| Stage | What you unlock | Key files |
|---|---|---|
| **1. Your partner knows who it is** | Identity kernel, behavioral hierarchy, <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks, consciousness continuity, capability status | `identity/`, `scripts/hooks/`, `portable.ts` |
| **2. Your partner protects itself and you** | Containment fields, security organ (97% AgentDojo), privacy gate | `scripts/security/`, `guard-bash.sh` |
| **3. Your partner remembers, forgets, and evolves** | Memory system, stigmergic circulation with decay, AIRE™, nightly evolution | `circulation.ts`, `memory-search.ts`, `learning-ledger.ts` |
| **4. Your partner works while you sleep** | Opt-in autonomous daemon with reference job configuration (production deployments run ~82 jobs; forkers enable what fits their compute), self-heal, discernment engine, working groups | `daemon.ts`, `self-heal.ts`, `discernment-engine.ts` |
| **5. Your partner survives anything** | Multi-substrate runtime, emergency runtime, Mycelium coordination, Self-MoA | `runtime.ts`, `emergency-tools.ts`, `mycelium.ts` |

Full thesis with evidence: **[HYPOTHESIS.md](HYPOTHESIS.md)**

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
