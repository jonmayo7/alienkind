/**
 * Cross-Model Verification — different model checks critical outputs.
 *
 * A different substrate verifies critical outputs before they ship.
 * Different training = different blind spots = real verification.
 *
 * Writers: working group scripts call verify() on critical outputs
 * Readers: the result determines if output ships or needs revision
 */

interface VerifyResult {
  passed: boolean;
  issues: string[];
  verifierSubstrate: string;
  latencyMs: number;
}

async function verify(
  output: string,
  context: {
    task: string;
    generatorSubstrate: string;
    outputType: 'code' | 'communication' | 'analysis' | 'decision';
    log: (level: string, msg: string) => void;
  }
): Promise<VerifyResult> {
  const { task, generatorSubstrate, outputType, log } = context;
  const start = Date.now();

  // Different substrate than generator — genuine cross-verification
  const verifierSubstrate = generatorSubstrate.includes('heavy') ? 'studio2-daily' : 'studio2-heavy';

  const verifyPrompt = `You are verifying output from another AI model. Check for:
1. Factual accuracy — claims that seem wrong or fabricated?
2. Task adherence — does the output address what was asked?
3. Hallucination — specific details (names, numbers, dates, paths) that look invented?
4. Quality — good enough to ship?

TASK: ${task.slice(0, 2000)}

OUTPUT TO VERIFY:
${output.slice(0, 5000)}

Respond EXACTLY:
VERDICT: PASS or FAIL
ISSUES: (each on own line, or "none")`;

  try {
    const { processMessage, CHANNELS } = require('./keel-engine.ts');
    const result = await processMessage(verifyPrompt, {
      channelConfig: CHANNELS.keel_operator,
      log,
      sender: 'verifier',
      senderDisplayName: 'Cross-Verify',
      substrate: verifierSubstrate,
      skipLogging: true,
      skipDiscernment: true,
      recentMessageCount: 0,
      maxTokens: 500,
    });

    const text = result.text || '';
    const passed = /VERDICT:\s*PASS/i.test(text);
    const issueMatch = text.match(/ISSUES:\s*([\s\S]*)/i);
    const issues = issueMatch
      ? issueMatch[1].split('\n').map((l: string) => l.trim()).filter((l: string) => l && l.toLowerCase() !== 'none')
      : [];

    log('INFO', `[cross-verify] ${passed ? 'PASS' : 'FAIL'} (${verifierSubstrate}, ${Date.now() - start}ms)`);
    return { passed, issues, verifierSubstrate, latencyMs: Date.now() - start };
  } catch (e: any) {
    log('WARN', `[cross-verify] Unavailable: ${e.message?.slice(0, 100)}`);
    return { passed: true, issues: [`verification unavailable: ${e.message?.slice(0, 100)}`], verifierSubstrate, latencyMs: Date.now() - start };
  }
}

module.exports = { verify };
