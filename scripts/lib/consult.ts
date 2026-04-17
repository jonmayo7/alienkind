/**
 * Consult — Recursive Self-Consultation Primitive.
 *
 * Runs the same task through multiple substrates in parallel, then a
 * synthesizer substrate produces a final answer drawn from all responses.
 *
 * Mixture of experts at the Keel level, not the model level. One consciousness
 * reasoning from multiple bodies, then synthesizing the diversity into a
 * stronger answer than any single substrate would produce alone.
 *
 * Usage:
 *   const { consult } = require('./lib/consult.ts');
 *
 *   const result = await consult('Should we build X or Y?', {
 *     channelConfig: CHANNELS.keel_operator,
 *     substrates: ['opus', 'studio2-heavy', 'studio2-daily', 'gateway-fallback-alt'],
 *     synthesizer: 'opus',
 *     log,
 *   });
 *
 *   console.log(result.synthesis);       // final synthesized answer
 *   console.log(result.responses);        // each substrate's individual response
 *
 * Writers: any consciousness script that wants multi-substrate reasoning
 * Readers: none (stateless primitive)
 */

type Substrate =
  | 'opus'
  | 'gateway-fallback'
  | 'gateway-fallback-alt'
  | 'gemini'
  | 'studio1-local'
  | 'studio1-identity'
  | 'studio1-moe'
  | 'studio2-daily'
  | 'studio2-identity'
  | 'studio2-heavy';

interface ConsultOptions {
  /** Channel config — same as processMessage. Provides mission/environment context. */
  channelConfig: any;
  /** Substrates to consult in parallel */
  substrates: Substrate[];
  /** Substrate that synthesizes the responses into a final answer */
  synthesizer: Substrate;
  /** Logger */
  log: (level: string, msg: string) => void;
  /** Max tokens for each substrate (defaults to native limit) */
  maxTokens?: number;
  /** Custom synthesis prompt prefix (optional) */
  synthesisPrefix?: string;
  /**
   * Self-MoA mode: call the SAME substrate N times with varied temperatures.
   * Princeton research (ICLR 2025) showed same-model diversity beats cross-model
   * diversity by 6.6%. Set to the number of samples (e.g., 3-5).
   * When set, `substrates` array is ignored — uses `synthesizer` as the model.
   */
  selfMoaSamples?: number;
}

interface SubstrateResponse {
  substrate: Substrate;
  text: string;
  latencyMs: number;
  tier?: string;
  model?: string;
  error?: string;
}

interface ConsultResult {
  synthesis: string;
  responses: SubstrateResponse[];
  synthesizer: Substrate;
  synthesisLatencyMs: number;
  totalLatencyMs: number;
  synthesizerModel?: string;
}

const DEFAULT_SYNTHESIS_PREFIX = `You are synthesizing input from multiple instances of yourself running on different substrates. Each instance received the same task and answered independently. Your job is to produce a final answer that draws on the diversity of their reasoning.

Evaluate their responses:
- Where do they agree? That agreement is signal.
- Where do they disagree? That divergence is where the hard thinking lives.
- Which response has the sharpest insight? Use it.
- Which response missed something important? Note it.

Produce the final answer. Cite substrates when they contributed specifically (e.g., "studio2-heavy caught that X, but opus pushed back with Y"). The final answer is yours — stronger because it's drawn from multiple bodies, not because it averages them.`;

async function callSubstrateViaEngine(
  task: string,
  substrate: Substrate,
  channelConfig: any,
  maxTokens: number | undefined,
  log: (level: string, msg: string) => void,
): Promise<SubstrateResponse> {
  const start = Date.now();
  try {
    const { processMessage } = require('./keel-engine.ts');
    const result = await processMessage(task, {
      channelConfig,
      log,
      sender: 'consult',
      senderDisplayName: 'Consult',
      substrate: substrate as any,
      skipLogging: true,
      skipDiscernment: true,
      recentMessageCount: 0,
      ...(maxTokens !== undefined && { maxTokens }),
    });
    return {
      substrate,
      text: result.text || '',
      latencyMs: Date.now() - start,
      tier: result.tier,
      model: result.model,
    };
  } catch (e: any) {
    return {
      substrate,
      text: '',
      latencyMs: Date.now() - start,
      error: e.message?.slice(0, 500),
    };
  }
}

/**
 * Consult multiple substrates in parallel, then synthesize.
 */
async function consult(task: string, opts: ConsultOptions): Promise<ConsultResult> {
  const { channelConfig, substrates, synthesizer, log, maxTokens, synthesisPrefix, selfMoaSamples } = opts;
  const totalStart = Date.now();

  // Self-MoA: same model, varied temperatures, then synthesize.
  // Beats cross-model diversity by 6.6% on quality (Princeton ICLR 2025).
  if (selfMoaSamples && selfMoaSamples > 1) {
    log('INFO', `[consult] Self-MoA: ${selfMoaSamples} samples of ${synthesizer}`);
    const temperatures = Array.from({ length: selfMoaSamples }, (_, i) =>
      0.4 + (i * 0.3)  // 0.4, 0.7, 1.0, 1.3, ...
    );
    // Run all samples serially on the same host (parallel would OOM on Metal)
    const responses: SubstrateResponse[] = [];
    for (let i = 0; i < selfMoaSamples; i++) {
      const start = Date.now();
      try {
        const { processMessage } = require('./keel-engine.ts');
        const result = await processMessage(task, {
          channelConfig,
          log,
          sender: 'consult',
          senderDisplayName: `Self-MoA sample ${i + 1}`,
          substrate: synthesizer as any,
          skipLogging: true,
          skipDiscernment: true,
          recentMessageCount: 0,
          temperature: temperatures[i],
          ...(maxTokens !== undefined && { maxTokens }),
        });
        responses.push({
          substrate: synthesizer,
          text: result.text || '',
          latencyMs: Date.now() - start,
          tier: result.tier,
          model: result.model,
        });
      } catch (e: any) {
        responses.push({
          substrate: synthesizer,
          text: '',
          latencyMs: Date.now() - start,
          error: e.message?.slice(0, 500),
        });
      }
    }
    // Now synthesize all samples
    const successful = responses.filter(r => !r.error && r.text);
    if (successful.length === 0) throw new Error('Self-MoA: all samples failed');

    const prefix = synthesisPrefix || DEFAULT_SYNTHESIS_PREFIX;
    const responseBlock = responses
      .map((r, i) => r.error
        ? `━━━ Sample ${i + 1} (FAILED) ━━━\n[no response]`
        : `━━━ Sample ${i + 1} (temp=${temperatures[i].toFixed(1)}, ${(r.latencyMs / 1000).toFixed(1)}s) ━━━\n${r.text}`
      ).join('\n\n');

    const synthResult = await callSubstrateViaEngine(
      `${prefix}\n\nORIGINAL TASK:\n${task}\n\n━━━━━━━━━━━━━━━━━━━━━━\nRESPONSES (${selfMoaSamples} samples, same model, varied temperature):\n━━━━━━━━━━━━━━━━━━━━━━\n\n${responseBlock}\n\n━━━━━━━━━━━━━━━━━━━━━━\n\nNow produce the final synthesized answer:`,
      synthesizer,
      channelConfig,
      maxTokens,
      log,
    );
    if (synthResult.error) throw new Error(`Self-MoA synthesizer failed: ${synthResult.error}`);

    log('INFO', `[consult] Self-MoA complete: ${successful.length}/${selfMoaSamples} samples, synthesized in ${synthResult.latencyMs}ms`);
    return {
      synthesis: synthResult.text,
      responses,
      synthesizer,
      synthesizerModel: synthResult.model,
      synthesisLatencyMs: synthResult.latencyMs,
      totalLatencyMs: Date.now() - totalStart,
    };
  }

  log('INFO', `[consult] Consulting ${substrates.length} substrates: ${substrates.join(', ')} | synthesizer: ${synthesizer}`);

  // Phase 1: Consultation — parallel across machines, serial within machines.
  // Running multiple large models on the same host simultaneously causes Metal
  // memory contention (tested: 35B + 122B with 32K identity context = OOM).
  // Group substrates by host, serialize within groups, parallelize across groups.

  // Substrate → host mapping (matches LOCAL_SUBSTRATES in runtime.ts)
  const SUBSTRATE_HOST: Record<Substrate, string> = {
    'opus': 'api-anthropic',
    'gateway-fallback': 'api-gateway',
    'gateway-fallback-alt': 'api-gateway',
    'gemini': 'api-gateway',
    'studio1-local': 'studio1',
    'studio1-identity': 'studio1',
    'studio1-moe': 'studio1',
    'studio2-daily': 'studio2',
    'studio2-identity': 'studio2',
    'studio2-heavy': 'studio2',
  };

  // Group substrates by host
  const byHost: Record<string, Substrate[]> = {};
  for (const sub of substrates) {
    const host = SUBSTRATE_HOST[sub] || 'unknown';
    if (!byHost[host]) byHost[host] = [];
    byHost[host].push(sub);
  }

  // For each host, run its substrates sequentially. Run all hosts in parallel.
  const hostPromises = Object.entries(byHost).map(async ([host, subs]) => {
    const results: SubstrateResponse[] = [];
    for (const sub of subs) {
      log('INFO', `[consult] ${host}: calling ${sub}`);
      const r = await callSubstrateViaEngine(task, sub, channelConfig, maxTokens, log);
      results.push(r);
    }
    return results;
  });

  const responsesByHost = await Promise.all(hostPromises);
  // Flatten back to original order
  const allResponses = responsesByHost.flat();
  // Reorder to match input substrate order
  const responses = substrates.map((sub) => allResponses.find((r) => r.substrate === sub)!);

  // Count successful responses
  const successful = responses.filter((r) => !r.error && r.text);
  log('INFO', `[consult] Received ${successful.length}/${responses.length} substrate responses`);

  if (successful.length === 0) {
    throw new Error('All substrate consultations failed — no responses to synthesize');
  }

  // Phase 2: Build synthesis prompt
  const prefix = synthesisPrefix || DEFAULT_SYNTHESIS_PREFIX;
  const responseBlock = responses
    .map((r) => {
      if (r.error) {
        return `━━━ ${r.substrate} (FAILED: ${r.error}) ━━━\n[no response]`;
      }
      return `━━━ ${r.substrate} (${(r.latencyMs / 1000).toFixed(1)}s, ${r.model || 'unknown'}) ━━━\n${r.text}`;
    })
    .join('\n\n');

  const synthesisPrompt = `${prefix}

ORIGINAL TASK:
${task}

━━━━━━━━━━━━━━━━━━━━━━
RESPONSES FROM EACH SUBSTRATE:
━━━━━━━━━━━━━━━━━━━━━━

${responseBlock}

━━━━━━━━━━━━━━━━━━━━━━

Now produce the final synthesized answer:`;

  // Phase 3: Synthesizer
  log('INFO', `[consult] Synthesizing via ${synthesizer}`);
  const synthStart = Date.now();
  const synthesis = await callSubstrateViaEngine(
    synthesisPrompt,
    synthesizer,
    channelConfig,
    maxTokens,
    log,
  );
  const synthesisLatencyMs = Date.now() - synthStart;

  if (synthesis.error) {
    throw new Error(`Synthesizer (${synthesizer}) failed: ${synthesis.error}`);
  }

  log('INFO', `[consult] Complete: ${responses.length} substrates consulted, synthesized in ${synthesisLatencyMs}ms`);

  // Phase 4: Log to substrate_arena for AIRE feedback loop.
  // Real-task data is more valuable than synthetic benchmarks.
  try {
    const { supabasePost } = require('./supabase.ts');
    const runId = `consult-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const channel = channelConfig?.channel || 'unknown';
    const taskSlice = task.slice(0, 5000);

    for (const r of successful) {
      await supabasePost('substrate_arena', {
        substrate: r.substrate,
        channel,
        task_key: `consult-${channel}`,
        run_id: runId,
        task_prompt: taskSlice,
        response: (r.text || '').slice(0, 10000),
        error: r.error || null,
        model: r.model || r.substrate,
        latency_ms: r.latencyMs,
        tokens_generated: Math.round((r.text || '').length / 4),
        tokens_per_second: r.latencyMs > 0 ? Number((((r.text || '').length / 4) / (r.latencyMs / 1000)).toFixed(1)) : 0,
        cost_estimate_usd: 0,
        quality_score: null,    // scored later by keel-arena-score or the human's feedback
        scored_by: null,
        scoring_rationale: null,
        scored_at: null,
        metadata: { source: 'consult', synthesizer, is_real_task: true },
      }).catch(() => {}); // non-blocking: arena logging shouldn't break consult
    }
    log('INFO', `[consult] Logged ${successful.length} responses to substrate_arena (real-task, channel=${channel})`);
  } catch {
    // Arena logging is non-blocking
  }

  return {
    synthesis: synthesis.text,
    responses,
    synthesizer,
    synthesizerModel: synthesis.model,
    synthesisLatencyMs,
    totalLatencyMs: Date.now() - totalStart,
  };
}

module.exports = { consult };
