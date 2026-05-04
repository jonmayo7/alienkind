# Channel Contract

_The spec for any channel adapter that delivers messages to your AlienKind partner._

---

## What a channel adapter is

A long-running process that:
1. **Receives** messages from some external surface (Telegram, Discord, Slack, webhook, SMS, etc.)
2. **Authenticates** the sender against an allowlist
3. **Calls** `askPartner(message)` from `scripts/lib/substrate.ts`
4. **Sends** the response back through the same surface

The adapter does NOT talk to any AI provider directly. The substrate layer does that. **This is what makes channels portable across providers** — swap your `.env` from Claude Code to OpenAI to local Ollama, and your channel adapters keep working without code changes.

---

## The contract

Any adapter under `scripts/channels/<name>.ts` is conformant if:

### 1. It loads `.env` from the repo root and calls `askPartner` from substrate

```ts
const { askPartner } = require(path.join(ROOT, 'scripts', 'lib', 'substrate.ts'));

// inside your message handler:
const reply = await askPartner(userMessage);
```

That's the only call you need. `askPartner` handles:
- Provider detection (Claude Code OAuth / Anthropic API / OpenAI / OpenRouter / Ollama / generic)
- Identity injection (your 4 kernel files become the system prompt)
- Timeouts and error handling
- Returning the response as a string

### 2. It reads its credentials from `.env`, not hardcoded

Add channel-specific env vars (`<CHANNEL>_BOT_TOKEN`, `<CHANNEL>_ALLOWED_USER_IDS`, etc.).
The `add-channel.ts` tool prompts for them and writes them to `.env` for you.

### 3. It enforces an allowlist before forwarding to `askPartner`

Refuse unauthenticated messages silently. Channels are public surfaces; without an allowlist, anyone can use your subscription.

### 4. It runs as a long-lived process

`pm2` supervises it (auto-installed by `add-channel.ts`). No need to write a daemon — just write the message handler and let pm2 keep it alive.

### 5. It chunks responses if the channel has length limits

Telegram caps at 4096 chars/message. Discord at 2000. Most adapters split long replies before sending.

---

## Adding your own adapter

1. Create `scripts/channels/<your-channel>.ts`
2. Use Telegram (`grammy`) or Discord (`discord.js`) as a reference
3. Add an entry to `scripts/tools/add-channel.ts` `CHANNELS` registry — name, npm dep, env vars, setup notes
4. Submit a PR

We accept adapters that wrap mature, well-maintained libraries. We reject adapters that reinvent channel clients from scratch.

---

## Why this design

The AlienKind thesis is that the partner survives substrate changes. **Channels are part of that surface.** A Telegram bot wired directly to Anthropic API stops working when you swap to a local model — unless the channel calls a substrate-abstraction. That's `askPartner`.

By making the substrate the only thing that knows about providers, we get:
- Channels that work with any AI backend
- Substrate swaps that don't ripple into channel code
- A clean place to plug in new providers (one new branch in `substrate.ts`, all channels light up)

This is "eat the agents" in code form. We don't compete with grammY / discord.js / @slack/bolt — we compose with them.
