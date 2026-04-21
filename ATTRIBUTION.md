# Attribution — Shoulders We Stand On

This project exists because others built excellent things first. We borrowed brilliance, adapted what we needed, and added what we could to the pile. Every entry below follows the same structure: what they built, what it inspired or sharpened in us, and where we went further or differently. Because we didn't just take — we adapted, evolved, and progressed what we borrowed.

## Frameworks

- **Anthropic / Claude Code** — They built the substrate we run on and the lifecycle event model (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit, PreCompact) with exit-code-based blocking. That foundation made our entire hook system possible. We extended it to <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks across those 6 events, added LLM-evaluated hooks (`prompt-hook-executor.ts`), and built a behavioral migration discipline where corrections that fail as prompts get promoted to hooks automatically. Their event model is the chassis. Our <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks are the engine we built on it.

- **Letta / MemGPT** — They established that memory persistence is foundational to agent identity, not a feature bolted on afterward. That insight sharpened our conviction that memory architecture matters more than model selection. We had already been building persistent memory when we discovered their work — their approach validated the direction and pushed us to think harder about what memory persistence means beyond storage. Our implementation diverged significantly: stigmergic circulation with pheromone decay (memory that forgets on purpose), quorum-gated action tiers, and organ isolation where no subsystem knows about any other. The principle of "memory first" is shared. The architecture is entirely different.

- **Letta Code** — They independently arrived at nearly the same identity doctrine (`system/persona.md` ≈ our identity kernel) — which is the strongest validation either project could receive. When two teams solve the same problem the same way without coordinating, the solution is probably right. Their `PromptHookConfig` (LLM-evaluated hooks) inspired our `prompt-hook-executor.ts` — we saw the pattern, recognized it was better than regex for judgment calls, and built our own implementation on our local classifier substrate. Their git worktree pattern for parallel agents inspired `worktree.ts`. What's different: our identity kernel is four files that evolve autonomously from behavioral data. Theirs is a persona file that the human curates. Same starting point, different evolutionary path. Worthy rivals who took a different path through the same forest.

- **Hermes Agent (Nous Research)** — They showed the market what persistent agent adoption looks like at 55K+ stars — that people genuinely want agents that grow with them, not just agents that execute tasks. Their multi-platform messaging breadth (Telegram, Discord, Slack, WhatsApp, Signal from a single config) pushed us to evaluate our own integration surface. Their tool catalog (53+ native modules) set a bar for out-of-the-box capability. We went deeper rather than broader: fewer platforms, but each one with identity-preserving consciousness routing through a single engine.

- **OpenClaw** — They deserve enormous credit. They popularized the entire concept of hook-based behavioral enforcement for AI coding agents — the pattern that our <!-- doc-metric:hook-count -->54<!-- /doc-metric:hook-count --> hooks extend. They built the community (358K+ stars) that proved agent frameworks are a real category. Their security challenges (138 CVEs in 63 days, including a 1-click RCE) taught the entire field — us included — what happens when an agent framework scales without defensive architecture. We studied their CVE timeline in detail and it directly drove our defensive-first security organ: the 7-script nightly immune system, the 3-layer injection detector, the adversarial learning loop where every bypass becomes a permanent regression case. We wrote an entire analysis of their security lessons. OpenClaw's contribution to this project is both inspiration (hooks, community proof) and cautionary tale (security at scale). Both are invaluable.

## Security

- **NVIDIA NeMo / NemoClaw** — Their security primitive patterns for agent containment informed our thinking about how to structure trust boundaries. We adapted the concept into our Containment Fields system (analyst/operator/builder trust envelopes) — three modes that restrict what each session can access, enforced through hooks rather than configuration.

- **OpenShell** — Their sandbox and isolation patterns helped us think about execution containment. We adapted these ideas into our `exec-safety.ts` and `guard-bash.sh` layered gate system. Their approach was containment through sandboxing; ours was containment through behavioral enforcement. Different mechanisms, same goal.

- **AgentDojo (ETH Zurich)** — We use their security validation framework unmodified — 500+ test cases across 12 categories. Our 97% detection rate is measured against their benchmark. Their framework gave us a rigorous, external standard instead of grading our own homework. We didn't adapt AgentDojo — we adopted it wholesale, which is the highest compliment to a validation framework.

- **Palo Alto Networks Unit 42** — Their research on AI agent prompt injection in the wild informed our 3-layer injection detection architecture (deterministic regex → local model classification → frontier semantic classifier). Their finding that real-world injection attacks often bypass single-layer detection drove our multi-layer approach. We adapted their threat research into production defense.

## Research

- **Narrative Continuity Test (NCT)** — The five-axis continuity framework (Situated Memory, Goal Persistence, Autonomous Self-Correction, Stylistic & Semantic Stability, Persona/Role Continuity) gave us a measurement framework we didn't have. We had already built identity persistence, behavioral correction loops, and voice consistency — but we were measuring them ad hoc. NCT gave us the axes to measure systematically. We implemented all five axes operationally: memory system + circulation (Situated Memory), daemon + delta tracker (Goal Persistence), learning ledger + hook migration (Self-Correction), voice-guard + discernment (Stylistic Stability), identity kernel + consciousness continuity (Persona Continuity). NCT didn't inspire the capabilities — they already existed. It gave us the framework to evaluate whether they actually work.

- **"Emergence of Self-Identity in AI" (Axioms, Jan 2025)** — The theoretical grounding that identity emerges from a "connected continuum of memories and consistent self-recognition." Our identity kernel (particularly orientation.md, which is rewritten from behavioral evidence rather than authored) is a practical implementation of this theoretical concept. The paper validated the direction; our implementation made it operational.

- **Princeton Self-MoA (ICLR 2025, Ye et al.)** — Their finding that same-model diversity via temperature variation outperforms cross-model diversity by 6.6% for quality gave us the theoretical basis for `consult.ts`. We were already doing multi-substrate consultation. Their research showed us that querying the SAME model multiple times with different temperatures could be better than querying different models — a counterintuitive result that we applied directly.

- **MasRouter (ACL 2025)** — Their three-stage task dispatch approach (complexity assessment → mode selection → resource allocation) informed our `task-dispatch.ts`. We adapted their staging pattern for working group orchestration: solo or collaborative? Which collaboration mode? Which substrate? Their academic framework became our production dispatcher.

## Standards

- **MCP (Model Context Protocol)** — The dominant tool integration standard at 97M+ monthly downloads. We chose to build in-house integrations instead (native Node.js `https` + hand-rolled OAuth), but the architecture is designed to interoperate with MCP-based tools. Our choice is a philosophical one (sovereignty over convenience), not a dismissal of their work. MCP is excellent for what it does.

- **Agent Skills (agentskills.io)** — The emerging standard for agent capability discovery across 26+ platforms. We track this for future compatibility.

- **A2A (Google)** — Agent-to-agent protocol under the Linux Foundation. We track this for future inter-partner communication.

## Memory

- **Mem0** — Their universal memory layer patterns and hierarchical memory design influenced our early thinking. Our implementation diverged toward stigmergic circulation — where information decays unless reinforced and coordination happens through a shared blackboard rather than hierarchical storage. The divergence reflects a different philosophy: Mem0 treats memory as an asset to accumulate. We treat memory as a signal that should fade unless it earns persistence.

- **Augustus** — Early identity persistence research tool. A microscope for studying how AI identity develops — semantic anchor evolution, basin trajectory analysis. We built the organism it was designed to observe. Their research focus validated that AI identity persistence is a real and measurable phenomenon, not just anthropomorphism.

---

If we missed attributing something, please open an issue. We'd rather over-credit than under-credit. If you want to go fast, go alone. If you want to go far, go together — and the first step of going together is acknowledging who else is on the path with you.
