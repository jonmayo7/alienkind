/**
 * Privacy Gate — deterministic regex scanner for private family information.
 *
 * This scanner exists to catch family-private content before it reaches a
 * public surface (social media posts, articles, external communications).
 *
 * Categories:
 *   - family-health: Medical conditions, diagnoses, treatments, surgeries
 *   - family-finance: Private financial details about family members
 *   - family-minor: Identifying details about minor children
 *   - family-private: Other private family details (addresses, legal, etc.)
 *
 * Design: Deterministic regex. Zero LLM cost. Stateless.
 *
 * IMPORTANT — this is a SCANNER, not a gate. It should be wrapped by a
 * discernment engine (e.g., publish-hold.ts) which implements the pattern:
 * scan -> hold -> surface to [HUMAN] -> resolve. Using this as a hard block
 * creates excessive false positives. Wire through a discernment layer so
 * resolutions feed AIRE and the patterns calibrate from real labeled data.
 *
 * Writers: none (stateless scanner)
 * Readers: publish-hold.ts (recommended), or your own discernment wrapper
 */

interface PrivacyFinding {
  category: string;
  pattern: string;
  matched: string;
  detail: string;
}

interface PrivacyResult {
  blocks: PrivacyFinding[];
  clean: boolean;
  summary: string;
}

// ─── Family Members ─────────────────────────────────────────────────────────
// Customize these patterns for your family's privacy protection
// Used to build contextual patterns. First names alone aren't blocks —
// they become blocks when combined with private detail categories.

const FAMILY_MEMBERS = [
  'Partner',   // Replace with actual partner name
  'Child1',    // Replace with actual child names
  'Child2',
];

// Family relationship terms
const FAMILY_RELATIONS = [
  "[HUMAN]'s\\s+(?:father|dad|mother|mom|wife|husband|spouse|partner|son|daughter|sons|brother|sister|parent|parents|family|kid|kids|child|children)",
  "(?:his|her|my)\\s+(?:father|dad|mother|mom|wife|husband|spouse|partner|son|daughter|sons|brother|sister|parent|parents|family|kid|kids|child|children)",
  "(?:father|dad|mother|mom)\\s+(?:has|had|was|is|got|diagnosed|battling|fighting|suffering|undergoing|recovering)",
];

// ─── Health / Medical ───────────────────────────────────────────────────────
// Any family member or relation + medical context = BLOCK

const MEDICAL_TERMS = [
  'cancer', 'tumor', 'tumour', 'chemo(?:therapy)?', 'radiation\\s+(?:therapy|treatment)',
  'diagnosed', 'diagnosis', 'prognosis', 'terminal', 'malignant', 'benign',
  'surgery', 'surgical', 'operation', 'procedure', 'hospital(?:ized)?',
  'illness', 'disease', 'condition', 'disorder', 'syndrome',
  'treatment\\s+(?:plan|option|center)', 'oncolog(?:y|ist)',
  'diabetes', 'type\\s+[12]\\s+diabetes',
  'mental\\s+health', 'psychiatr(?:y|ist|ic)', 'therap(?:y|ist)',
  'depression', 'anxiety\\s+disorder', 'PTSD', 'medication',
  'disability', 'recovery', 'recovering', 'rehab(?:ilitation)?',
  'biopsy', 'scan', 'MRI', 'CT\\s+scan', 'x-ray',
  'ICU', 'emergency\\s+room', 'ER\\s+visit',
];

// ─── Financial (Family) ─────────────────────────────────────────────────────
// Family members + financial details = BLOCK

const FINANCIAL_TERMS = [
  'debt', 'loan', 'mortgage', 'bankruptcy',
  'salary', 'income', 'payment', '\\$\\d+[KkMm]?',
  'credit\\s+(?:card|score)', 'balance\\s+transfer',
  'foreclos(?:ure|ing)', 'repossess(?:ion|ed)',
  'financial\\s+(?:trouble|difficulty|hardship|struggle)',
];

// ─── Minor Children Detail ──────────────────────────────────────────────────
// Identifying details about minor children beyond casual first-name mention

const MINOR_CHILD_DETAIL_PATTERNS: { pattern: RegExp; name: string }[] = [
  // Child name + age/grade/school
  { pattern: new RegExp(`\\b(?:${FAMILY_MEMBERS.slice(1).join('|')})\\b.*?(?:\\b\\d{1,2}\\s*(?:year|yr)s?\\s*old\\b|\\bgrade\\s+\\d|\\bschool\\b|\\b(?:elementary|middle|high)\\s+school)`, 'i'), name: 'minor-age-school' },
  // Child name + medical detail
  { pattern: new RegExp(`\\b(?:${FAMILY_MEMBERS.slice(1).join('|')})\\b[^.]{0,80}\\b(?:${MEDICAL_TERMS.join('|')})\\b`, 'i'), name: 'minor-medical' },
  // Child name + specific incident
  { pattern: new RegExp(`\\b(?:${FAMILY_MEMBERS.slice(1).join('|')})\\b[^.]{0,80}\\b(?:animal\\s+attack|bit(?:e|ten)|injur(?:y|ed)|accident|ambulance)`, 'i'), name: 'minor-incident' },
];

// ─── Pattern Builders ───────────────────────────────────────────────────────

function buildFamilyHealthPatterns(): { pattern: RegExp; name: string }[] {
  const patterns: { pattern: RegExp; name: string }[] = [];

  // Family relation + medical term (within 120 chars)
  for (const relation of FAMILY_RELATIONS) {
    patterns.push({
      pattern: new RegExp(`(?:${relation})[^.]{0,120}\\b(?:${MEDICAL_TERMS.join('|')})\\b`, 'i'),
      name: 'relation-medical',
    });
    // Reverse: medical term then relation
    patterns.push({
      pattern: new RegExp(`\\b(?:${MEDICAL_TERMS.join('|')})\\b[^.]{0,120}(?:${relation})`, 'i'),
      name: 'medical-relation',
    });
  }

  // Named family member + medical term (within 80 chars)
  for (const name of FAMILY_MEMBERS) {
    patterns.push({
      pattern: new RegExp(`\\b${name}\\b[^.]{0,80}\\b(?:${MEDICAL_TERMS.join('|')})\\b`, 'i'),
      name: `${name.toLowerCase()}-medical`,
    });
    patterns.push({
      pattern: new RegExp(`\\b(?:${MEDICAL_TERMS.join('|')})\\b[^.]{0,80}\\b${name}\\b`, 'i'),
      name: `medical-${name.toLowerCase()}`,
    });
  }

  // Direct statements about serious medical conditions in family
  patterns.push({
    pattern: /\b(?:father|mother|parent|spouse|wife|husband|partner)\s+(?:has|had|was diagnosed|is battling|passed away)\s+\w+/i,
    name: 'family-medical-serious',
  });

  // Treatment/diagnosis references tied to family context
  patterns.push({
    pattern: /\b(?:treatment|diagnosis|prognosis)\s+(?:for|about)\s+(?:father|mother|parent|family)/i,
    name: 'family-medical-treatment',
  });

  return patterns;
}

function buildFamilyFinancePatterns(): { pattern: RegExp; name: string }[] {
  const patterns: { pattern: RegExp; name: string }[] = [];

  // Named family member + financial detail
  for (const name of FAMILY_MEMBERS) {
    patterns.push({
      pattern: new RegExp(`\\b${name}\\b[^.]{0,80}\\b(?:${FINANCIAL_TERMS.join('|')})`, 'i'),
      name: `${name.toLowerCase()}-financial`,
    });
  }

  // Family relation + financial detail
  patterns.push({
    pattern: new RegExp(`(?:[HUMAN]'s|his|her|my)\\s+(?:wife|husband|spouse|partner|family|father|mother|dad|mom)[^.]{0,80}\\b(?:${FINANCIAL_TERMS.join('|')})`, 'i'),
    name: 'family-relation-financial',
  });

  return patterns;
}

function buildFamilyPrivatePatterns(): { pattern: RegExp; name: string }[] {
  return [
    // Family address/location
    { pattern: /\b(?:family|wife|husband|spouse|partner|kids?|sons?|daughters?|children)\s+(?:live|living|moved|reside|residing)\s+(?:at|in|on)\s+\d+\s+/i, name: 'family-address' },
    // Custody/legal
    { pattern: /\b(?:custody|divorce|separation|restraining\s+order|CPS|child\s+protective)\b.*?\b(?:family)\b/i, name: 'family-legal' },
  ];
}

// ─── Main Scanner ───────────────────────────────────────────────────────────

const HEALTH_PATTERNS = buildFamilyHealthPatterns();
const FINANCE_PATTERNS = buildFamilyFinancePatterns();
const PRIVATE_PATTERNS = buildFamilyPrivatePatterns();

function privacyGate(text: string): PrivacyResult {
  if (!text || text.trim().length === 0) {
    return { blocks: [], clean: true, summary: 'Empty content — pass' };
  }

  const blocks: PrivacyFinding[] = [];

  function scan(
    patterns: { pattern: RegExp; name: string }[],
    category: string,
  ) {
    for (const p of patterns) {
      const match = text.match(p.pattern);
      if (match) {
        blocks.push({
          category,
          pattern: p.name,
          matched: match[0].slice(0, 120),
          detail: `${category}: "${match[0].slice(0, 80)}"`,
        });
      }
    }
  }

  scan(HEALTH_PATTERNS, 'family-health');
  scan(FINANCE_PATTERNS, 'family-finance');
  scan(MINOR_CHILD_DETAIL_PATTERNS, 'family-minor');
  scan(PRIVATE_PATTERNS, 'family-private');

  const clean = blocks.length === 0;
  let summary: string;
  if (clean) {
    summary = 'Privacy gate clean — no family information detected';
  } else {
    // Deduplicate by category for summary
    const categories = [...new Set(blocks.map(b => b.category))];
    summary = `PRIVACY GATE: ${blocks.length} BLOCK — ${categories.join(', ')}`;
  }

  return { blocks, clean, summary };
}

/**
 * Quick check — returns true if content passes privacy gate.
 */
function privacyQuickCheck(text: string): boolean {
  return privacyGate(text).blocks.length === 0;
}

/**
 * Semantic privacy check via local model.
 * Second pass after regex — catches euphemistic, indirect, or rephrased
 * references that regex can't reach.
 *
 * Examples regex misses:
 *   "the person who raised [HUMAN] is fighting something terminal"
 *   "the youngest child's condition"
 *   "the family went through hell financially that year"
 *
 * Returns: { flagged: boolean, reason: string }
 * Cost: zero (local inference). Latency: <1 second.
 * Falls back gracefully — if the local model is down, regex result stands.
 */
async function semanticPrivacyCheck(text: string): Promise<{ flagged: boolean; reason: string }> {
  if (!text || text.length < 50) return { flagged: false, reason: 'too short for semantic check' };

  const http = require('http');
  const familyList = FAMILY_MEMBERS.join(', ');
  const prompt = `You are a privacy gate. Analyze this text for ANY reference to private family information — even indirect, euphemistic, or rephrased. Check for:

1. Health/medical conditions of family members (even without naming the condition)
2. Financial hardship, debt, or money struggles of the family
3. Identifying details about minor children (ages, schools, incidents)
4. Private family events (legal issues, moves, relationship struggles)

The family members are: ${familyList}. Also watch for references to parents, spouse, or other relatives.

If ANY private family information is present — even hinted at — respond with:
FLAGGED: [one-line reason]

If the text is clean, respond with:
CLEAN

Text to analyze:
${text.slice(0, 2000)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ flagged: false, reason: 'timeout — regex result stands' }), 3000);

    const req = http.request({
      hostname: '127.0.0.1', port: 8000, path: '/v1/chat/completions',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data).choices?.[0]?.message?.content?.trim() || '';
          if (response.startsWith('FLAGGED:')) {
            resolve({ flagged: true, reason: response.slice(8).trim() });
          } else {
            resolve({ flagged: false, reason: 'semantic check clean' });
          }
        } catch {
          resolve({ flagged: false, reason: 'parse error — regex result stands' });
        }
      });
    });
    req.on('error', () => {
      clearTimeout(timeout);
      resolve({ flagged: false, reason: 'local model unavailable — regex result stands' });
    });
    req.write(JSON.stringify({
      model: 'local-model',  // Replace with your local model identifier
      messages: [{ role: 'user', content: prompt }],
      stream: false, temperature: 0, max_tokens: 50,
    }));
    req.end();
  });
}

/**
 * Full two-pass privacy gate: regex (fast, deterministic) + semantic (local model, catches what regex misses).
 * Both must pass. If either flags content, it's blocked.
 */
async function privacyGateFull(text: string): Promise<PrivacyResult> {
  // Pass 1: regex (existing, <1ms)
  const regexResult = privacyGate(text);
  if (!regexResult.clean) return regexResult; // regex caught it — done

  // Pass 2: semantic (local model, <1s)
  const semantic = await semanticPrivacyCheck(text);
  if (semantic.flagged) {
    return {
      blocks: [{
        category: 'semantic-detection',
        pattern: 'local-model',
        matched: semantic.reason,
        detail: `Semantic privacy flag: ${semantic.reason}`,
      }],
      clean: false,
      summary: `PRIVACY GATE (semantic): ${semantic.reason}`,
    };
  }

  return regexResult; // both clean
}

module.exports = { privacyGate, privacyQuickCheck, semanticPrivacyCheck, privacyGateFull };
