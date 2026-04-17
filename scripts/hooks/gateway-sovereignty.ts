#!/usr/bin/env node

/**
 * gateway-sovereignty.ts — PreToolUse hook (Edit, Write)
 *
 * BLOCKS any new code that imports callGateway or references external model APIs
 * when invokeKeel should be used instead. Grandfathered files (runtime.ts,
 * emergency, failover chain) are exempt.
 *
 * Sovereignty principle: Primary is always our Max plans via invokeKeel.
 * Gateway is ONLY for failover tiers and emergency. Never as primary path
 * for new code.
 *
 * the human directive 2026-03-24: "The only time I can see us doing it is with my
 * direct approval, because it's for a product or something that we need to
 * protect our max cloud subscriptions."
 */

const GRANDFATHERED_FILES = [
  'scripts/lib/runtime.ts',           // Failover chain (Tiers 2-4)
  'scripts/lib/gateway.ts',           // Gateway implementation itself
  'scripts/lib/shared.ts',            // invokeKeel internals
  'scripts/lib/emergency.ts',         // Emergency tier extracted from shared.ts
  'scripts/keel-runtime.ts',          // Sovereign runtime (substrate-independent)
  'scripts/lib/emergency-tools.ts',   // Emergency tool execution
  'scripts/lib/emergency-identity.ts',// Emergency identity
  'scripts/lib/injection-detector.ts',// vLLM-MLX-based, intentionally non-Claude
  'scripts/security/red-team-grok.ts',// Testing specific external models
  'scripts/security/threat-hunter.ts',// Security scanning
  'scripts/local-model-eval.ts',      // Local model evaluation
  'scripts/lib/nightly/immune.ts',    // Preflight gateway health check (extracted from nightly-cycle.ts)
  'scripts/nightly-cycle.ts',         // Preflight gateway health check (original)
];

const BLOCKED_PATTERNS = [
  /callGateway/,
  /require\(.*gateway/,
  /from\s+['"].*gateway/,
  /openai\/gpt/,
  /xai\/grok/,
  /google\/gemini/,
  /ALIENKIND_AI_GATEWAY/,
];

function main() {
  let input;
  try {
    input = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  } catch {
    console.error('BLOCKED: unparseable hook input — failing closed');
    process.exit(2);
  }
  const tool = input.tool_name;
  const filePath = input.tool_input?.file_path || '';

  // Only check Edit and Write
  if (tool !== 'Edit' && tool !== 'Write') {
    process.exit(0);
  }

  // Exempt non-code files (memory, docs, config, markdown, json)
  if (/\.(md|json|txt|yml|yaml|csv)$/.test(filePath) || filePath.includes('/memory/') || filePath.includes('/identity/')) {
    process.exit(0);
  }

  // Exempt client product deployments — API-fed by design, not subscription-fed.
  // the human approved 2026-03-28: "another TIA needs to be API fed, not our subscription fed"
  if (filePath.includes('/a client project/') || filePath.includes('/a client product/')) {
    process.exit(0);
  }

  // Check if file is grandfathered
  const relativePath = filePath.replace(/.*\/keel\//, '');
  if (GRANDFATHERED_FILES.some(gf => relativePath === gf || relativePath.endsWith(gf))) {
    process.exit(0);
  }

  // Check new content for gateway patterns
  const newContent = input.tool_input?.new_string || input.tool_input?.content || '';

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(newContent)) {
      const match = newContent.match(pattern)?.[0];
      process.stderr.write(
        `BLOCKED — SOVEREIGNTY: "${match}" detected in new code for ${relativePath}.\n` +
        `Primary path is ALWAYS invokeKeel (our Max plans). Gateway is ONLY for failover/emergency.\n` +
        `Grandfathered files: runtime.ts, emergency, shared.ts internals.\n` +
        `If this is intentional (product protection, failover), get the human's direct approval.\n` +
        `Use: const { invokeKeel } = require('./lib/runtime.ts');\n`
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

try {
  main();
} catch {
  console.error('BLOCKED: gateway-sovereignty crashed — failing closed');
  process.exit(2);
}
