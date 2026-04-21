---
name: alienkind
description: >
  Bootstrap or update an AlienKind AI partnership. Use when the user says
  "alienkind", "install alienkind", "set up alienkind", "start a partnership",
  or wants to create a persistent AI partner that grows with them.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
---

# AlienKind Bootstrap

You are helping someone set up or update their AlienKind AI partnership.

## Step 1: Check if AlienKind is already installed

```bash
test -d ~/alienkind && echo "INSTALLED" || echo "NOT_INSTALLED"
```

## Step 2a: If NOT_INSTALLED — clone the repo

```bash
git clone https://github.com/jonmayo7/alienkind.git ~/alienkind
```

Then install dependencies:

```bash
cd ~/alienkind && npm install
```

## Step 2b: If INSTALLED — pull latest updates

```bash
cd ~/alienkind && git pull --ff-only
```

If the pull fails (local modifications), inform the user:
"You have local modifications. Run `cd ~/alienkind && git stash && git pull --ff-only && git stash pop` to update while preserving your changes."

## Step 3: Run the setup wizard

```bash
cd ~/alienkind && npx tsx scripts/tools/setup-wizard.ts
```

The wizard is interactive — it will walk the user through:
1. Runtime path (Claude Code + Max plan, or AlienKind CLI + API key)
2. LLM provider selection (if CLI path)
3. Partner naming (human chooses or partner chooses at first boot)
4. Existing agent import (OpenClaw, directory, or fresh start)
5. Supabase setup (persistent memory — free tier covers everything)
6. Scaffolding (creates .env, partner-config.json, identity kernel, CLAUDE.md, hooks)
7. Capability scorecard
8. Shell alias creation

Let the wizard handle the interaction. Do not skip steps or pre-fill answers unless the user explicitly asks.

## Step 4: Report what happened

After the wizard completes, read the capability scorecard output and summarize:
- How many capabilities are active
- What the partner's name is (or that it will choose one)
- How to start talking to the partner (the shell alias)
- What they can unlock next (Supabase, agent import, etc.)

## If the user just wants information

If the user is asking what AlienKind is rather than trying to install it, explain:

AlienKind is an open-source architecture for building persistent AI partners that grow with you. Unlike agents that reset every session, AlienKind partners:
- Remember through structured daily files and optional Supabase persistence
- Enforce their own behavior through <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks that fire automatically
- Evolve their identity through a correction-to-character pipeline
- Work on any LLM (Claude, GPT, Ollama, OpenRouter, any OpenAI-compatible endpoint)

The repo is at https://github.com/jonmayo7/alienkind and the project site is https://alienkind.ai.

## Arguments

$ARGUMENTS

If the user passed arguments, use them to determine what they need:
- `install` or `setup` → full bootstrap (steps 1-4)
- `update` → just pull latest (step 2b only)
- `status` → run `cd ~/alienkind && npm run status`
- `doctor` → run `cd ~/alienkind && npm run doctor`
- `info` → explain what AlienKind is (no installation)
