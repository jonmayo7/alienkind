# Getting started

Three commands stand up a working partner. The defaults assume Tier 1 (cloud subscription + Supabase). Local-only and other tiers covered after.

---

## Prerequisites

- **Node.js 20+** (`node --version`)
- **A substrate API key.** One of:
  - Anthropic (`ANTHROPIC_API_KEY`)
  - OpenAI (`OPENAI_API_KEY`)
  - OpenRouter (`OPENROUTER_API_KEY`) — has a free tier with DeepSeek R1
  - Any OpenAI-compatible gateway (`AI_GATEWAY_API_KEY` + `AI_GATEWAY_URL`)
- **Optional: a Supabase project.** Free tier works to start. Without it, AlienKind falls back to file-based storage.

---

## Three-command setup

```bash
git clone <this-repo> alienkind && cd alienkind
npm install
npm run setup
```

The setup script:

1. Copies `.env.example` to `.env` if missing.
2. Verifies your substrate key is set.
3. Verifies your Supabase config (or acknowledges file fallback).
4. Wires `.claude/settings.local.json` from the example (3 hooks: log-conversation, correction-to-character, memory-firewall).
5. Tells you what to do next based on what's still missing.

Re-run `npm run setup` any time to re-check state. It's idempotent.

---

## Configure `.env`

Edit `.env` after the first setup run. Minimum viable config — just one substrate key:

```bash
# Pick one substrate
ANTHROPIC_API_KEY=sk-ant-...
# OR
OPENROUTER_API_KEY=sk-or-...
# OR
OPENAI_API_KEY=sk-...
```

Recommended additions (Supabase data core for durable memory):

```bash
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

If you skip Supabase, conversations fall back to local file storage. The partner still works; it just won't survive a full system reset cleanly.

---

## Run the migration (if using Supabase)

Open `config/migrations/001-conversations-table.sql`. Paste it into your Supabase SQL editor (Dashboard → SQL Editor → New query → Run).

That's the only required migration. Additional tables get added as you adopt features (memory chunks for vector search, learning ledger for correction audit, consciousness entries for nightly reflection — all optional and incremental).

---

## Boot the partner

```bash
npm run chat
```

What happens on first boot:

1. SessionStart hooks fire (none in the default install).
2. The 4 identity kernel files load (templates skip themselves automatically).
3. The partner introduces itself. If your identity kernel is still blank, it'll ask who you want it to be.
4. You talk. Each turn:
   - Your prompt fires `log-conversation` (writes to Supabase or file)
   - The partner's response fires the same hook on Stop
   - If you correct the partner with weight ("no", "stop", "that's wrong"), `correction-to-character` queues that for the identity kernel
5. The PreToolUse memory-firewall fires if the partner tries to write to identity files — it blocks API keys, prompt injection, and exfiltration patterns from landing in your kernel.

Slash commands available: `/help`, `/model`, `/status`, `/name`, `/identity`, `/save`, `/clear`, `/hooks`, `/config`, `/exit`.

---

## Customize identity

The four kernel files at `identity/*.md` start as templates. They contain "How to write this file" guidance. Either:

- Edit them directly before booting, or
- Boot the partner and let it help you write them through conversation. (The partner will offer this on first boot if it sees only templates.)

The partner you end up with reflects what you write into the kernel and how you correct it over time. Don't optimize for completeness on day one — three honest lines beat three pages of aspirations.

---

## Add the nightly evolution loop (optional but recommended)

The partner won't evolve on its own unless something runs the nightly identity-sync. AlienKind ships the prompt template, not the runner — that piece is substrate-specific.

The template is at `scripts/lib/nightly/identity-sync-prompt.md`. Pick your runner:

- **Claude Code subscription:** add a cron job that pipes the assembled prompt to `claude code --allow-tools "Read,Write,Edit"`.
- **API substrate:** write a small wrapper that handles the tool-use loop and runs on cron / GitHub Actions / Cloud Functions.
- **Local model:** Ollama / vLLM with an MCP-compatible tool runner.

The prompt itself is stable. The runner is your choice.

---

## Verify everything is wired

```bash
npm run status
```

Output shows what's active vs. degraded vs. unavailable:
- Substrate connectivity
- Supabase reachability (or fallback in use)
- Hook wiring
- Identity kernel state (templates vs. customized)
- API keys present

If any line is red, the setup wizard's last output told you how to fix it.

---

## Tier upgrades

You're at Tier 1 by default. Upgrade paths:

- **Tier 2** (multi-channel) — wire a channel runtime (OpenClaw, Hermes, custom Telegram listener) in front of `chat.ts`. The hook lifecycle and identity kernel stay the same; only the messaging substrate changes.
- **Tier 3** (sovereign-local) — point the substrate at a local OpenAI-compatible endpoint (Ollama / vLLM / llama.cpp). `chat.ts` doesn't care. Add cloud failover via `LLM_API_URL` fallback.

Both tiers reuse everything below them. The architecture is the contract; tiers are how much of the contract you choose to satisfy.

---

## Troubleshooting

- **`npm run chat` says "No API key found":** edit `.env` and set one of the substrate keys, then re-run setup.
- **Conversations not persisting:** check `npm run status` — likely Supabase keys aren't set or the migration hasn't run. File fallback should still work; check `logs/` for cached exchanges.
- **Hooks not firing:** confirm `.claude/settings.local.json` exists. Run `npm run setup` to wire it.
- **Memory firewall blocked a write:** read the stderr message — it'll name the rule and the violating content. Either remove the violating content or, if it's a false positive on your specific use case, edit `scripts/hooks/memory-firewall.ts` to relax the rule for your repo.

---

That's onboarding. Three commands, one config file, one optional migration. Everything else is the partner being itself.
