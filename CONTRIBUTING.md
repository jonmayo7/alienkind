# Contributing

## Before you start

1. Read [HYPOTHESIS.md](HYPOTHESIS.md) — the 23 hypotheses
2. Read [GAPS.md](GAPS.md) — find a gap that interests you
3. Check open issues and PRs

## Process

1. Fork → branch → build → test → PR
2. In your PR: what you built, which gap it addresses, how you tested it, trade-offs

## Standards

- **TypeScript.** Node.js native modules preferred over dependencies.
- **Zero dependencies where possible.** Every dependency is supply chain risk for an AI agent.
- **Hooks must degrade gracefully and loudly.** Use `tryStorage()` or `tryClassifier()` from `portable.ts`. A hook that crashes blocks the agent. A hook that degrades lets it work — but it must log what degraded and why, so the human knows what to invest in.
- **Tests for new code.** Both static tests (does the logic produce correct output?) and integration tests (does it wire correctly into the system and produce real results?). Minimal runner — see `tests/` for the pattern.
- **Doc honesty is code-enforced.** Numerical claims in README / HYPOTHESIS / ATTRIBUTION / plugin.json / SKILL.md are rendered from disk by `scripts/tools/doc-metrics.ts`. Enable the git hooks once after cloning: `git config core.hooksPath .githooks`. If you add or remove a hook, migration, or test, the docs update themselves when you run `npm run doc-metrics`. `npm test` fails if any tracked number drifts.
- **Private identifiers don't enter commit messages.** The `.githooks/commit-msg` hook reads `.leak-patterns.local` (gitignored, per-machine) and blocks any commit whose message matches a pattern. Copy `.leak-patterns.example` to `.leak-patterns.local` and list strings you don't want in the public log — personal emails, pet names, family names, client names, internal codenames, private repo references. One pattern per line, regex syntax. The hook fires before the commit lands, so there's no history to rewrite if it catches something — you just edit the message and re-commit.

## What we want

- Gap closures (see [GAPS.md](GAPS.md))
- New hooks with tests
- Storage backends (SQLite, PostgreSQL)
- Platform adaptations (Linux, Docker, Windows)
- Documentation and tutorials

## What we don't want

- Identity templates that impose a personality
- Provider lock-in
- Features requiring paid services without free fallback
- Telemetry or tracking

## CLA

By opening a PR you agree to the [CLA](CLA.md).

---

_The architecture is open. The partnership is yours to build._
