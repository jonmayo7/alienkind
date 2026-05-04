# Deployment

_Three tiers. Pick the one that matches your condition. Upgrade when condition demands it, not before._

---

## Tier 1 — Cloud subscription + always-on host

**Cost: ~$20–100 / month**
**Hardware: none required (any laptop or $5/mo VM)**

The default path. No GPU. No local LLM. No special infrastructure. If you have a Claude Code subscription (or Codex, or OpenRouter free tier), you have what you need.

```
┌─────────────────────────────────────────────────────┐
│  Always-on host                                     │
│  (your laptop, or $5/mo VM — Hetzner / DigitalOcean)│
│                                                     │
│  └─ AlienKind: kernel + hooks + daemon jobs         │
│      └─ Substrate: Claude Code subscription         │
│          (or Codex, OpenRouter, direct API)         │
│      └─ Data core: Supabase (free tier or $25 Pro)  │
└─────────────────────────────────────────────────────┘
```

Anyone with a subscription + a cheap VM can run a persistent partner. Daemon jobs run within the subscription quota. The partner lives 24/7. Cost stays bounded.

**Who it's for:** First-time users. Personal partnerships. Anyone who wants to start without a hardware commitment. This is the tier the architecture was designed for.

---

## Tier 2 — Cloud API + multi-channel

**Cost: ~$30–250 / month**
**Hardware: none required**

When you need multi-channel messaging — Telegram, Discord, Slack, your own clients texting your partner directly — Tier 2 adds a channel runtime in front of AlienKind.

```
┌─────────────────────────────────────────────────────┐
│  Always-on host                                     │
│   └─ AlienKind: kernel + hooks + daemon jobs        │
│       └─ Channel runtime (OpenClaw, Hermes, custom) │
│           └─ Inference: OpenRouter free tier        │
│               (DeepSeek R1) — $0–30/mo              │
│           OR Anthropic API with prompt caching      │
│               — $100–200/mo                          │
│           OR Claude Code subscription as a tool     │
│               (subscription-bounded, $20-100/mo)    │
└─────────────────────────────────────────────────────┘
```

The channel runtime is the body Hermes / OpenClaw / a custom listener exposes. AlienKind hosts the kernel; the channel runtime hosts the messaging substrate.

**Who it's for:** Users whose partner serves more than just them. Coaches with clients. Founders with teams. Anyone where the partner needs to be reachable on the channels people already live in.

---

## Tier 3 — Sovereign-local + cloud failover

**Cost: hardware $$ + ~$0–50 / month ongoing**
**Hardware: Mac with unified memory (32GB minimum, 64GB+ comfortable) or equivalent**

Local inference primary. Cloud failover for capability ceilings or reliability.

```
┌─────────────────────────────────────────────────────┐
│  Local hardware (Mac Studio, M-series with 32-128GB)│
│   └─ AlienKind: kernel + hooks + daemon jobs        │
│       └─ Local inference (Ollama / vLLM / llama.cpp)│
│           — primary substrate                        │
│       └─ Cloud failover (API or subscription)       │
│           — fallback for ceilings + outages         │
│       └─ Channel runtime (OpenClaw, optional)       │
└─────────────────────────────────────────────────────┘
```

Hardware ROI takes years; ongoing cost is just electricity. Best for sustained heavy use, sovereignty-driven users, or anyone with workloads that exceed subscription quotas.

**Who it's for:** Power users. Sovereignty-focused builders. People running multiple partners (one per family member, one per business unit). The endgame, not the entry point.

---

## Picking the right tier

Start at **Tier 1**. Always.

Move to **Tier 2** only when a specific condition demands it: "my partner needs to take Telegram messages from my customers" or "I want my partner reachable on Discord."

Move to **Tier 3** only when ongoing cloud cost passes the hardware payback threshold (typically 12-24 months of heavy use), or when sovereignty is a hard requirement.

---

## What every tier shares

Regardless of tier, the architecture is the same:

- The same identity kernel (4 files)
- The same hooks (security organ + memory loop + correction-to-character)
- The same data core schema (`conversations` table, plus what you add)
- The same nightly evolution job
- The same multi-substrate runtime contract

When you upgrade tiers, you change the substrate underneath the partner. You don't change the partner. That's the whole point.

---

## What you bring

- **Identity content.** The four kernel files start as templates. You fill them in. Your partner is what you write into them and what they become through correction.
- **A substrate.** A Claude Code subscription, a Codex subscription, an OpenRouter API key, an Anthropic API key, or a local Ollama install. Pick one.
- **A data core.** A Supabase project (free tier works to start). Or accept the SQLite fallback. Or accept the file-only fallback. Each tier degrades gracefully.
- **An always-on host.** Your laptop counts if you don't sleep it. A $5/mo VM is the cleaner path.

That's it. Everything else AlienKind ships.
