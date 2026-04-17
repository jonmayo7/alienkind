/**
 * @keel-ai/steward-core — Single source of truth for all AI steward deployments.
 *
 * Every steward ([steward-b], [steward-a], [client-product-c], future clients) consumes this package.
 * Domain-specific config (synonyms, metrics, persona) is registered at creation.
 * Engine logic (logging, discernment, knowledge, gap detection, verification) is universal.
 *
 * Changes here propagate to every deployment. One fix, all benefit.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SupabaseConfig {
  url: string;
  key: string;
}

export interface VerifiedMetric {
  /** Human-readable name, e.g. "YTD Revenue" */
  name: string;
  /** Patterns that indicate this metric is being discussed */
  patterns: RegExp[];
  /** Compute the exact value from the database */
  compute: () => Promise<number | string>;
  /** Format for display, e.g. (v) => `$${v.toLocaleString()}` */
  format: (value: number | string) => string;
}

export interface CorrectionEvent {
  prefix: string;
  category: string;
  feedbackText?: string;
}

export interface GapEvent {
  prefix: string;
  gapType: string;
  userMessage: string;
  sessionId: string;
}

export interface StewardConfig {
  /** Table prefix — isolates data per deployment (e.g. 'a client project', 'a client product') */
  prefix: string;
  /** Supabase connection — each deployment provides its own */
  supabase: SupabaseConfig;
  /** Domain-specific synonyms merged with defaults */
  synonyms?: Record<string, string[]>;
  /** Verified metrics for tier 1 accuracy enforcement */
  verifiedMetrics?: VerifiedMetric[];
  /** Optional business context builder — called during context assembly */
  businessContext?: () => Promise<string>;
  /** Optional callback when unhelpful feedback is received (e.g. circulation deposit) */
  onCorrection?: (event: CorrectionEvent) => void;
  /** Optional callback when a capability gap is detected */
  onGap?: (event: GapEvent) => void;
}

export interface StewardEngine {
  logExchange: (sessionId: string, messageIndex: number, role: string, content: string, extra?: Record<string, any>) => Promise<void>;
  getRelevantHistory: (question: string) => Promise<string>;
  getSessionContext: (sessionId: string) => Promise<string>;
  updateSession: (sessionId: string, userName?: string) => Promise<void>;
  getDiscernmentRules: () => Promise<string>;
  updateDiscernment: (sessionId: string, messageIndex: number, helpful: boolean, feedbackText?: string) => Promise<void>;
  updateDiscernmentDirect: (correctionText: string, isHelpful: boolean, feedbackText?: string) => Promise<void>;
  composeSystemPrompt: (basePrompt: string, sessionContext: string, historicalContext: string, knowledgeContext: string, discernmentRules: string) => string;
  detectCapabilityGap: (userMessage: string, agentResponse: string, sessionId: string) => void;
  getKnowledgeContext: (userMessage: string) => Promise<string>;
  formatKnowledge: (records: Array<{ topic: string; content: string }>) => string;
  getBusinessContext: () => Promise<string>;
  getVerifiedContext: () => Promise<string>;
  verifyResponse: (response: string) => Promise<{ verified: boolean; corrections: string[]; correctedResponse?: string }>;
  getStatus: () => Promise<Record<string, any>>;
  getRecentMessages: (sessionId: string, limit?: number) => Promise<Array<{ role: string; content: string }>>;
  getNextMessageIndex: (sessionId: string) => Promise<number>;
  CONV_TABLE: string;
  DISC_TABLE: string;
  SESS_TABLE: string;
  KNOWLEDGE_TABLE: string;
  supabasePost: (table: string, data: Record<string, any>) => Promise<any>;
  supabaseGet: (table: string, query: string) => Promise<any[]>;
  supabasePatch: (table: string, filter: string, data: Record<string, any>) => Promise<void>;
}

// ─── Default synonym map ─────────────────────────────────────────────────────

export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  funding: ['capital', 'investment', 'budget', 'financial'],
  risk: ['threat', 'danger', 'concern', 'vulnerability'],
  compare: ['versus', 'difference', 'comparison'],
  score: ['rating', 'assessment', 'evaluation'],
  recommend: ['suggest', 'advise', 'proposal'],
  revenue: ['income', 'sales', 'earnings', 'profit'],
  team: ['staff', 'personnel', 'people', 'employees'],
  client: ['customer', 'account', 'prospect'],
  quote: ['estimate', 'proposal', 'bid'],
  job: ['project', 'work', 'service'],
};

// ─── Gap detection patterns ──────────────────────────────────────────────────

export const GAP_PATTERNS: Record<string, RegExp[]> = {
  explicit_gap: [
    /i (?:can't|cannot|don't have|am not able|am unable|don't have access)/i,
    /(?:outside|beyond) (?:my|the) (?:scope|capabilities|ability)/i,
    /(?:not available|not supported|not possible|not implemented)/i,
  ],
  implicit_request: [
    /can you (?:also|help|do|make|send|show|create|build|add|update)/i,
    /(?:is there|are there) (?:a way|any way|a feature)/i,
    /(?:would it be|is it) possible (?:to|for)/i,
    /how (?:do i|can i|would i) (?:get|make|do|see|access)/i,
  ],
  wish: [
    /i wish (?:it|you|this|there)/i,
    /(?:it would|that would) be (?:nice|great|helpful|useful|cool)/i,
  ],
  pain_point: [
    /i (?:keep|always|still) (?:having|needing|going) to/i,
    /(?:frustrating|annoying|tedious|painful|slow) (?:to|that|when)/i,
    /(?:separately|manually|by hand)/i,
  ],
};

// ─── De-dupe (in-memory, per-process) ────────────────────────────────────────

const _gapHashes = new Set<string>();

function isDuplicateGap(userMessage: string, gapType: string): boolean {
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(gapType + ':' + (userMessage || '').slice(0, 200)).digest('hex');
    if (_gapHashes.has(hash)) return true;
    _gapHashes.add(hash);
    return false;
  } catch {
    return false;
  }
}

// ─── Engine factory ──────────────────────────────────────────────────────────

export function createSteward(config: StewardConfig): StewardEngine {
  const { prefix, supabase: sbConfig, synonyms: extraSynonyms = {}, verifiedMetrics = [], businessContext: businessContextFn, onCorrection, onGap } = config;

  const CONV_TABLE = `${prefix}_steward_conversations`;
  const DISC_TABLE = `${prefix}_steward_discernment`;
  const SESS_TABLE = `${prefix}_steward_sessions`;
  const KNOWLEDGE_TABLE = `${prefix}_steward_knowledge`;

  const synonyms = { ...DEFAULT_SYNONYMS, ...extraSynonyms };

  // ─── Supabase helpers (config-injected, not env-dependent) ───────────────

  async function supabasePost(table: string, data: Record<string, any>): Promise<any> {
    if (!sbConfig.url || !sbConfig.key) return null;
    try {
      const res = await fetch(`${sbConfig.url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { apikey: sbConfig.key, Authorization: `Bearer ${sbConfig.key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(data),
      });
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }

  async function supabaseGet(table: string, query: string): Promise<any[]> {
    if (!sbConfig.url || !sbConfig.key) return [];
    try {
      const res = await fetch(`${sbConfig.url}/rest/v1/${table}?${query}`, {
        headers: { apikey: sbConfig.key, Authorization: `Bearer ${sbConfig.key}` },
      });
      return res.ok ? (await res.json()) as any[] : [];
    } catch {
      return [];
    }
  }

  async function supabasePatch(table: string, filter: string, data: Record<string, any>): Promise<void> {
    if (!sbConfig.url || !sbConfig.key) return;
    await fetch(`${sbConfig.url}/rest/v1/${table}?${filter}`, {
      method: 'PATCH',
      headers: { apikey: sbConfig.key, Authorization: `Bearer ${sbConfig.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(data),
    });
  }

  async function supabaseCount(table: string): Promise<number> {
    if (!sbConfig.url || !sbConfig.key) return 0;
    try {
      const res = await fetch(`${sbConfig.url}/rest/v1/${table}?select=id`, {
        headers: { apikey: sbConfig.key, Authorization: `Bearer ${sbConfig.key}`, Prefer: 'count=exact', Range: '0-0' },
      });
      const range = res.headers.get('content-range') || '';
      return parseInt(range.split('/')[1] || '0', 10);
    } catch {
      return 0;
    }
  }

  // ─── Conversation logging ────────────────────────────────────────────────

  async function logExchange(sessionId: string, messageIndex: number, role: string, content: string, extra: Record<string, any> = {}) {
    await supabasePost(CONV_TABLE, {
      session_id: sessionId, message_index: messageIndex, role, content,
      model: extra.model || null, response_time_ms: extra.response_time_ms || null,
      page_context: extra.page_context || null, project_id: extra.project_id || null,
    });
  }

  // ─── Historical context retrieval (synonym expansion) ────────────────────

  async function getRelevantHistory(question: string): Promise<string> {
    const words = question.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (words.length === 0) return '';
    const expanded = [...words];
    for (const w of words) {
      const syns = synonyms[w.toLowerCase()];
      if (syns) expanded.push(...syns.slice(0, 2));
    }
    const tsquery = [...new Set(expanded)].join(' | ');
    const results = await supabaseGet(CONV_TABLE, `select=content,created_at&fts=fts.plfts.${encodeURIComponent(tsquery)}&role=eq.assistant&order=created_at.desc&limit=5`);
    if (!results.length) return '';
    const summaries = results.map((r: any) =>
      `[${new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}] ${r.content.slice(0, 400)}`
    ).join('\n\n');
    return `\n\n## Relevant Past Conversations\nYou have discussed related topics before. Use this context but verify against current data:\n\n${summaries}`;
  }

  // ─── Session continuity ──────────────────────────────────────────────────

  async function getSessionContext(sessionId: string): Promise<string> {
    const session = await supabaseGet(SESS_TABLE, `select=*&id=eq.${encodeURIComponent(sessionId)}&limit=1`);
    if (!session || session.length === 0) return '';
    const s = session[0];
    if (s.message_count > 0) {
      const lastSeen = new Date(s.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `\n\n## Session Context\nThis user${s.user_name ? ` (${s.user_name})` : ''} has interacted before (${s.message_count} messages, last: ${lastSeen}). ${s.topics?.length ? `Topics: ${s.topics.join(', ')}.` : ''} Build on prior context.`;
    }
    return '';
  }

  async function updateSession(sessionId: string, userName?: string) {
    const existing = await supabaseGet(SESS_TABLE, `select=id,message_count&id=eq.${encodeURIComponent(sessionId)}&limit=1`);
    if (existing && existing.length > 0) {
      await supabasePatch(SESS_TABLE, `id=eq.${encodeURIComponent(sessionId)}`, {
        last_seen: new Date().toISOString(),
        message_count: (existing[0].message_count || 0) + 1,
      });
    } else {
      await supabasePost(SESS_TABLE, { id: sessionId, user_name: userName || null, message_count: 1 });
    }
  }

  // ─── Discernment rules ───────────────────────────────────────────────────

  async function getDiscernmentRules(): Promise<string> {
    const rules = await supabaseGet(DISC_TABLE, 'select=rule_text,score,question_category&active=eq.true&order=score.desc&limit=10');
    if (!rules.length) return '';
    const text = rules.map((r: any) => `- ${r.rule_text} (confidence: ${Math.round(r.score * 100)}%)`).join('\n');
    return `\n\n## REQUIRED Response Patterns\nThese rules are derived from direct user feedback. Follow them — they override your default response style when the category matches:\n\n${text}\n\nIf a rule conflicts with your instinct, follow the rule. These patterns were validated by the people using this tool.`;
  }

  function categorizeQuestion(text: string): string {
    const q = text.toLowerCase();
    if (q.match(/compar|vs|versus/)) return 'comparison';
    if (q.match(/risk|threat|danger/)) return 'risk_assessment';
    if (q.match(/recommend|should|suggest/)) return 'recommendation';
    if (q.match(/score|rating|assess/)) return 'scoring';
    if (q.match(/summar|overview|status/)) return 'summary';
    if (q.match(/explain|why|how.*work/)) return 'explanation';
    if (q.match(/build|create|implement|wire|add|deploy/)) return 'implementation';
    if (q.match(/fix|bug|broken|error|fail/)) return 'debugging';
    if (q.match(/don't|stop|never|no more|quit/)) return 'behavioral';
    return 'general';
  }

  async function updateDiscernment(sessionId: string, messageIndex: number, helpful: boolean, feedbackText?: string) {
    const msgs = await supabaseGet(CONV_TABLE, `select=content,role&session_id=eq.${encodeURIComponent(sessionId)}&message_index=gte.${messageIndex - 1}&message_index=lte.${messageIndex}&order=message_index.asc&limit=2`);
    const userMsg = msgs.find((m: any) => m.role === 'user');
    if (!userMsg) return;

    const content = userMsg.content || '';
    if (content.startsWith('PAGE STATE:') || content.includes('INTERACTIVE ELEMENTS:') || content.includes('VISIBLE TEXT:') || content.startsWith('Extract LinkedIn posts') || content.startsWith('Write a LinkedIn comment') || content.startsWith('You are posting as')) {
      return;
    }

    const category = categorizeQuestion(content);
    await upsertDiscernmentRule(category, helpful, feedbackText);
  }

  async function updateDiscernmentDirect(correctionText: string, isHelpful: boolean, feedbackText?: string) {
    const category = categorizeQuestion(correctionText);
    await upsertDiscernmentRule(category, isHelpful, feedbackText);

    if (!isHelpful && onCorrection) {
      onCorrection({ prefix, category, feedbackText });
    }
  }

  async function upsertDiscernmentRule(category: string, helpful: boolean, feedbackText?: string) {
    const existing = await supabaseGet(DISC_TABLE, `select=*&question_category=eq.${category}&limit=1`);
    if (existing.length > 0) {
      const rule = existing[0];
      const updates: any = { updated_at: new Date().toISOString() };
      if (helpful) updates.helpful_count = (rule.helpful_count || 0) + 1;
      else updates.unhelpful_count = (rule.unhelpful_count || 0) + 1;
      const total = (updates.helpful_count || rule.helpful_count || 0) + (updates.unhelpful_count || rule.unhelpful_count || 0);
      updates.score = (updates.helpful_count || rule.helpful_count || 0) / total;
      await supabasePatch(DISC_TABLE, `id=eq.${rule.id}`, updates);
    } else {
      const ruleText = helpful
        ? `When handling ${category} tasks, responses are effective.`
        : `When handling ${category} tasks, responses may miss the mark. ${feedbackText ? `Feedback: "${feedbackText.slice(0, 200)}"` : ''}`;
      await supabasePost(DISC_TABLE, { rule_type: 'response_pattern', question_category: category, helpful_count: helpful ? 1 : 0, unhelpful_count: helpful ? 0 : 1, score: helpful ? 1.0 : 0.0, rule_text: ruleText });
    }
  }

  // ─── System prompt composition ───────────────────────────────────────────

  function composeSystemPrompt(basePrompt: string, sessionContext: string, historicalContext: string, knowledgeContext: string, discernmentRules: string): string {
    return basePrompt + sessionContext + historicalContext + (knowledgeContext || '') + discernmentRules;
  }

  // ─── Capability gap detection ────────────────────────────────────────────

  function detectCapabilityGap(userMessage: string, agentResponse: string, sessionId: string) {
    for (const pattern of GAP_PATTERNS.explicit_gap) {
      if (pattern.test(agentResponse)) {
        if (!isDuplicateGap(userMessage, 'explicit_gap')) logGap(userMessage, agentResponse, sessionId, 'explicit_gap');
        return;
      }
    }
    for (const [gapType, patterns] of Object.entries(GAP_PATTERNS)) {
      if (gapType === 'explicit_gap') continue;
      for (const pattern of patterns) {
        if (pattern.test(userMessage)) {
          if (!isDuplicateGap(userMessage, gapType)) logGap(userMessage, agentResponse, sessionId, gapType);
          return;
        }
      }
    }
  }

  function logGap(userMessage: string, agentResponse: string, sessionId: string, gapType: string) {
    supabasePost('capability_requests', {
      source: 'steward', source_prefix: prefix, session_id: sessionId,
      user_message: userMessage, agent_response: (agentResponse || '').slice(0, 1000), gap_type: gapType,
    }).catch(() => {});

    if (onGap) {
      onGap({ prefix, gapType, userMessage, sessionId });
    }
  }

  // ─── Knowledge base retrieval ────────────────────────────────────────────

  async function getKnowledgeContext(userMessage: string): Promise<string> {
    const words = userMessage.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 8);
    if (words.length === 0) {
      const top = await supabaseGet(KNOWLEDGE_TABLE, 'select=topic,content&active=eq.true&priority=gte.9&order=priority.desc&limit=5');
      return formatKnowledge(top);
    }
    const tsquery = words.join(' | ');
    const results = await supabaseGet(KNOWLEDGE_TABLE, `select=topic,content,category,priority&active=eq.true&fts=fts.plfts.${encodeURIComponent(tsquery)}&order=priority.desc&limit=5`);
    if (results.length === 0) {
      const fallback = await supabaseGet(KNOWLEDGE_TABLE, 'select=topic,content&active=eq.true&priority=gte.9&order=priority.desc&limit=3');
      return formatKnowledge(fallback);
    }
    return formatKnowledge(results);
  }

  function formatKnowledge(records: Array<{ topic: string; content: string }>): string {
    if (!records || !records.length) return '';
    const chunks = records.map(r => `### ${r.topic}\n${r.content}`).join('\n\n');
    return `\n\n## Knowledge Base\nRelevant domain knowledge for this question:\n\n${chunks}`;
  }

  // ─── Business context (domain-specific, registered by deployment) ────────

  async function getBusinessContext(): Promise<string> {
    if (businessContextFn) return businessContextFn();
    return '';
  }

  // ─── Verified metrics — Tier 1 accuracy enforcement ──────────────────────

  async function getVerifiedContext(): Promise<string> {
    if (verifiedMetrics.length === 0) return '';
    const results: string[] = [];
    for (const metric of verifiedMetrics) {
      try {
        const value = await metric.compute();
        results.push(`- ${metric.name}: ${metric.format(value)}`);
      } catch {
        // Metric computation failed — skip, don't inject bad data
      }
    }
    if (results.length === 0) return '';
    return `\n\n## Verified Business Metrics (AUTHORITATIVE — use these exact numbers)\nThese values are computed directly from the database. If you cite these metrics, use these exact figures:\n\n${results.join('\n')}`;
  }

  async function verifyResponse(response: string): Promise<{ verified: boolean; corrections: string[]; correctedResponse?: string }> {
    if (verifiedMetrics.length === 0) return { verified: true, corrections: [] };

    const corrections: string[] = [];

    for (const metric of verifiedMetrics) {
      // Check if the response discusses this metric
      const mentionsMetric = metric.patterns.some(p => p.test(response));
      if (!mentionsMetric) continue;

      try {
        const exactValue = await metric.compute();
        const formatted = metric.format(exactValue);

        // Extract numbers from the response near the metric mention
        // Look for dollar amounts, percentages, or plain numbers
        const numberPatterns = [
          /\$[\d,]+(?:\.\d{1,2})?/g,  // $123,456.78
          /\d+(?:\.\d+)?%/g,           // 69%
          /\d{1,3}(?:,\d{3})+/g,       // 1,234,567
        ];

        for (const np of numberPatterns) {
          const matches = response.match(np);
          if (!matches) continue;
          for (const match of matches) {
            // Normalize both values for comparison
            const responseNum = parseFloat(match.replace(/[$,%]/g, '').replace(/,/g, ''));
            const exactNum = typeof exactValue === 'number' ? exactValue : parseFloat(String(exactValue).replace(/[$,%]/g, '').replace(/,/g, ''));
            if (isNaN(responseNum) || isNaN(exactNum)) continue;

            // Allow 2% tolerance for rounding
            const tolerance = Math.abs(exactNum * 0.02);
            if (Math.abs(responseNum - exactNum) > tolerance && Math.abs(responseNum - exactNum) > 1) {
              corrections.push(`${metric.name}: response said "${match}" but verified value is ${formatted}`);
            }
          }
        }
      } catch {
        // Can't verify — don't flag
      }
    }

    return {
      verified: corrections.length === 0,
      corrections,
      correctedResponse: corrections.length > 0
        ? response + `\n\n---\n*Data correction: ${corrections.join('; ')}*`
        : undefined,
    };
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  async function getStatus() {
    const convCount = await supabaseCount(CONV_TABLE);
    const [rules, sessions, knowledge, gaps] = await Promise.all([
      supabaseGet(DISC_TABLE, 'select=id&active=eq.true').then(r => r.length),
      supabaseGet(SESS_TABLE, 'select=id').then(r => r.length),
      supabaseGet(KNOWLEDGE_TABLE, 'select=id&active=eq.true').then(r => r.length).catch(() => 0),
      supabaseGet('capability_requests', `select=id&source_prefix=eq.${prefix}&status=eq.detected`).then(r => r.length),
    ]);
    const lastConv = await supabaseGet(CONV_TABLE, 'select=created_at&order=created_at.desc&limit=1');
    return {
      prefix, conversations: convCount, active_rules: rules, sessions,
      knowledge_records: knowledge, unresolved_gaps: gaps,
      verified_metrics: verifiedMetrics.length,
      last_activity: lastConv[0]?.created_at || null, checked_at: new Date().toISOString(),
    };
  }

  // ─── Message retrieval ───────────────────────────────────────────────────

  async function getRecentMessages(sessionId: string, limit = 10): Promise<Array<{ role: string; content: string }>> {
    const msgs = await supabaseGet(CONV_TABLE, `select=role,content&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=${limit}`);
    return (msgs || []).reverse().map((m: any) => ({ role: m.role, content: m.content }));
  }

  async function getNextMessageIndex(sessionId: string): Promise<number> {
    const last = await supabaseGet(CONV_TABLE, `select=message_index&session_id=eq.${encodeURIComponent(sessionId)}&order=message_index.desc&limit=1`);
    return last.length > 0 ? (last[0].message_index || 0) + 1 : 0;
  }

  // ─── Return engine ───────────────────────────────────────────────────────

  return {
    logExchange, getRelevantHistory, getSessionContext, updateSession,
    getDiscernmentRules, updateDiscernment, updateDiscernmentDirect,
    composeSystemPrompt, detectCapabilityGap,
    getKnowledgeContext, formatKnowledge,
    getBusinessContext, getVerifiedContext, verifyResponse,
    getStatus, getRecentMessages, getNextMessageIndex,
    CONV_TABLE, DISC_TABLE, SESS_TABLE, KNOWLEDGE_TABLE,
    supabasePost, supabaseGet, supabasePatch,
  };
}
