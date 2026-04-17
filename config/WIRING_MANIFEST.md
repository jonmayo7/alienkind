# WIRING MANIFEST — System Data Flows

_Every data flow in the system. When building anything new, check this manifest. Every write needs a reader. Every reader needs a writer. If a flow is one-directional, it's either intentional or a gap._

_Customize this document as you wire your own integrations. The PATTERN matters more than the content — document your data flows so future sessions know what connects to what._

---

## Subscription Architecture

| Account | Email | Plan | Config Dir | Services |
|---------|-------|------|-----------|----------|
| Primary | [YOUR_EMAIL] | [PLAN] ($[COST]/mo) | `~/.claude` | Terminal, primary listener |
| Secondary | [YOUR_EMAIL] | [PLAN] ($[COST]/mo) | `~/.claude-auto` | Daemon, secondary listener |

**Failover:** `shared.ts` detects rate limits in Claude CLI output, writes sticky state to `logs/failover-state.json`, all subsequent spawns use the alternate account. Stays in failover until `resets_at + 5min buffer` passes.

**Usage Monitoring:** `usage-monitor.ts` polls both accounts. Zero compute cost. Writes historical data to Supabase `subscription_usage`. Triggers proactive failover at 100% utilization.

| Writer | File/Table | Reader |
|--------|------------|--------|
| `shared.ts:activateFailover()` | `logs/failover-state.json` | `shared.ts:getActiveConfigDir()` |
| `usage-monitor.ts` | Supabase `subscription_usage` | Dashboard, interactive sessions |
| `usage-monitor.ts` | `logs/usage-monitor-health.json` | `operational-pulse.ts` (staleness check) |

## Emergency Tier

When primary accounts are unavailable, traffic routes through a gateway to alternate models. Self-heal diagnostic runs first to attempt automated repair.

| Tier | Model | Trigger |
|------|-------|---------|
| 1 (Primary) | [PRIMARY_MODEL] | Default |
| 2 (Secondary) | [PRIMARY_MODEL] | Primary rate-limited or auth-failed |
| 2.5 (Self-Heal) | [FALLBACK_MODEL_1] | Both accounts fail, attempt automated repair |
| 3 (Emergency) | [FALLBACK_MODEL_1] | Self-heal could not fix, run task on gateway |
| 4 (Emergency Fallback) | [FALLBACK_MODEL_2] | Tier 3 fails |

---

## Database Architecture — Two-Tier Strategy

| Tier | Project | Supabase Ref | Purpose | Env Prefix |
|------|---------|-------------|---------|------------|
| **Platform** | [PLATFORM_PROJECT] | `[PROJECT_REF]` | Conversations, patterns, circulation, infrastructure — operator's data | `SUPABASE_*` |
| **Product** | [PRODUCT_PROJECT] | `[PROJECT_REF]` | App data, user accounts, subscriptions, product-specific tables | `PRODUCT_*` |

**Boundary rule:** If a buyer of the product needs it to run, it belongs in the product DB. If it is the operator's content, brand, or operations data, it belongs in the platform DB.

### Key Tables (Platform Tier)

| Table | Writers | Readers | Notes |
|-------|---------|---------|-------|
| `sessions` | heartbeat.ts, nightly-cycle.ts, Stop hook | ground.sh, heartbeat.ts | Session tracking |
| `conversations` | telegram-listener.ts, discord-engine.ts, log-conversation.ts | recent-context.ts, ground.sh | All messages, all channels |
| `patterns` | nightly-cycle.ts | heartbeat.ts, ground.sh | Behavioral patterns (AIRE) |
| `circulation` | Any organ (deposit) | circulation-pump.ts (route) | Stigmergic blackboard |
| `mission_packets` | working-group-steward.ts | partner's operator script (fork-wired) | Autonomous findings for human review |
| `learning_ledger` | correction analysis | nightly analysis, ground.sh | Correction history |
| `memory_chunks` | memory-indexer.ts | memory-search.ts | Full-text search index |
| `capability_requests` | Steward pipelines | working-group-steward.ts | Detected gaps awaiting analysis |

---

## Core Data Flows

### Flow 1: Message Processing (Conversation Channel)

```
Inbound message
  -> telegram-listener.ts / discord-engine.ts
    -> consciousness-engine.ts:processMessage()
      -> runtime.ts:invoke()
        -> invoke.ts:invokeKeel() -> Claude CLI
      <- response
    -> supabase conversations table (log both sides)
  -> outbound response to channel
```

| Writer | File/Table | Reader |
|--------|------------|--------|
| `telegram-listener.ts` | Supabase `conversations` (user + assistant) | `recent-context.ts`, `ground.sh` |
| `discord-engine.ts` | Supabase `conversations` (user + assistant) | `recent-context.ts`, `ground.sh` |
| `consciousness-engine.ts` | Response text to caller | Listener (sends to channel) |

### Flow 2: Nightly Evolution Pipeline

```
22:30  nightly-immune    -> security scans, backup verify, cleanup
23:00  nightly-analysis  -> growth reflection, pattern evolution
23:20  nightly-weekly    -> Saturday only: strategic 7-day review
23:35  identity-sync     -> identity kernel evolution
00:10  nightly-digest    -> ONE summary notification to human
```

| Writer | File/Table | Reader |
|--------|------------|--------|
| `nightly-cycle.ts (immune)` | Supabase `sessions`, logs | `nightly-cycle.ts (analysis)` |
| `nightly-cycle.ts (analysis)` | Supabase `patterns`, daily file | `nightly-cycle.ts (identity-sync)` |
| `nightly-cycle.ts (identity-sync)` | identity kernel files | Boot grounding (next session) |
| `nightly-cycle.ts (digest)` | Notification channel | Human |

### Flow 3: Circulation System (Stigmergic Blackboard)

```
Any organ deposits a finding -> circulation table
  -> circulation-pump.ts (every 10 min)
    -> cross-organ reinforcement detection
    -> route: T1 auto-fix / T2 inform / T3 surface to human
    -> prune expired findings
```

| Writer | File/Table | Reader |
|--------|------------|--------|
| Any organ | Supabase `circulation` (deposit) | `circulation-pump.ts` |
| `circulation-pump.ts` | Routes to target organ / notification | Target organ, human |
| `consciousness-engine.ts` | Injects top findings into channel context | Every response |

### Flow 4: Autonomous Working Group Pipeline

```
Working group steward (nightly at 2:00 AM)
  -> scan capability_requests (status=detected)
  -> organ-map.ts: build organ map + survey
  -> consult() with 4 role prompts on local substrates
  -> triage-aire.ts: score finding
  -> deposit mission_packet to Supabase
  -> partner's operator picks up packet on next cycle (fork-specific)
  -> human reviews via whatever review surface the fork wires
```

| Writer | File/Table | Reader |
|--------|------------|--------|
| Steward pipelines | Supabase `capability_requests` | `working-group-steward.ts` |
| `working-group-steward.ts` | Supabase `mission_packets` | partner's operator script, human review surface |
| Human (approve/deny) | Supabase `mission_packets` (status update) | partner's operator (executes approved) |

---

## Integration Examples

### Messaging (Telegram)

| Writer | File/Table | Reader |
|--------|------------|--------|
| `telegram-listener.ts` | Telegram API (polling) | Inbound messages |
| `send-telegram.ts` | Telegram API (send) | Human (mobile) |
| System alerts | Telegram alerts channel | Human |

### Messaging (Discord)

| Writer | File/Table | Reader |
|--------|------------|--------|
| `discord-engine.ts` | Discord WebSocket | Inbound messages |
| `discord-send.ts` | Discord REST API | Channel participants |
| Multi-channel router | Routes to consciousness engine | Per-channel response |

---

## Security Architecture

### Defense Layers

| Layer | Component | Purpose |
|-------|-----------|---------|
| 1 | `injection-detector.ts` | 3-layer input scanning (regex + semantic + LLM) |
| 2 | `output-guard.ts` | Outbound content scanning (credentials, architecture, sensitive data) |
| 3 | `privacy-gate.ts` | Family/personal information protection (regex scanner) |
| 4 | `guard-bash.sh` | Commit gate — blocks commits without tests, syntax check, daily file |
| 5 | `memory-firewall-hook.ts` | Blocks writes to protected files containing credentials or injection |
| 6 | `action-evaluator.ts` | Unified action classification (T1-T4) with deny-by-default |
| 7 | Nightly security organ | Sequential scans: threat-hunter, red-team, pentest, OSINT, honeypots, threat-intel |

### Containment Fields

| Level | Access | Used By |
|-------|--------|---------|
| `analyst` | Full access — identity, memory, external messaging, code | Interactive terminal, nightly analysis |
| `operator` | Can send externally, cannot write identity/memory | Listeners, heartbeat, scheduled digest/reporting jobs |
| `builder` | Code files only — no identity/personal data, no external messaging | CI/CD, working groups, tests |

---

## Adding New Data Flows

When you add a new integration or data pipeline:

1. **Document the Writer** — what creates the data
2. **Document the File/Table** — where the data lives
3. **Document the Reader** — what consumes the data
4. **Check for orphans** — if a write has no reader, it is dead weight. If a read has no writer, it is a bug waiting to happen.
5. **Add to this manifest** — future sessions need to know what connects to what

_Every write needs a reader. Every reader needs a writer._
