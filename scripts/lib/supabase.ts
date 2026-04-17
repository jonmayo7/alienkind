/**
 * Shared Supabase REST client for Keel.
 *
 * Zero dependencies — native Node.js https only.
 * Pattern from memory-indexer.js supabaseRequest.
 * Every script that talks to Supabase imports from here.
 *
 * Usage:
 *   const { supabaseGet, supabasePost, supabasePatch, supabaseCount } = require('./supabase.ts');
 *   const rows = await supabaseGet('transcription_records', 'select=id,title&summary=is.null&limit=5');
 */

const https = require('https');
const { withTimeout } = require('./utils.ts');

interface Credentials {
  url: string;
  key: string;
}

interface RequestOptions {
  url: string;
  key: string;
  prefer?: string;
}

interface QueryOptions {
  timeout?: number;
}

interface PostOptions extends QueryOptions {
  prefer?: string;
  onConflict?: string;
}

// --- Credential Resolution ---
// Reads from process.env. Callers must have loaded .env before requiring this module.
function getCredentials(): Credentials {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
  }
  return { url, key };
}

// Encode '+' as %2B in query values so URL parser doesn't treat timezone offsets as spaces
// (e.g. +00:00 in timestamps). PostgREST has no '+' operators, so this is always safe.
function buildUrl(base: string, pathAndQuery: string): URL {
  const [pathPart, queryPart] = pathAndQuery.split('?', 2);
  const safeQuery = queryPart ? '?' + queryPart.replace(/\+/g, '%2B') : '';
  return new URL(`${base}/rest/v1/${pathPart}${safeQuery}`);
}

// --- Core Request ---
function request(method: string, pathAndQuery: string, body: any, { url, key, prefer }: RequestOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const fullUrl = buildUrl(url, pathAndQuery);
    const bodyStr = body ? JSON.stringify(body) : '';

    const headers: Record<string, string | number> = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    };

    if (prefer) {
      headers['Prefer'] = prefer;
    } else if (method === 'POST') {
      headers['Prefer'] = 'return=minimal';
    } else if (method === 'PATCH') {
      headers['Prefer'] = 'return=minimal';
    } else if (method === 'DELETE') {
      headers['Prefer'] = 'return=minimal';
    }

    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(fullUrl, { method, headers }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${method} ${pathAndQuery.split('?')[0]}: ${res.statusCode} ${data.slice(0, 300)}`));
          return;
        }
        // HEAD requests and minimal returns may have empty body
        if (!data || data.trim() === '') {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          // Return raw data if not JSON (e.g. count header responses)
          resolve(data);
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Supabase request socket timeout (30s)'));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// --- Public API ---

/**
 * GET rows from a table.
 */
async function supabaseGet(table: string, query: string = '', opts: QueryOptions = {}): Promise<any[]> {
  const { url, key } = getCredentials();
  const pathAndQuery = query ? `${table}?${query}` : table;
  const timeout = opts.timeout || 15000;
  return withTimeout(request('GET', pathAndQuery, null, { url, key }), timeout);
}

/**
 * POST (insert) rows into a table.
 *
 * Default Prefer changed 2026-04-10 from 'return=minimal' to
 * 'return=representation'. The old default made POST look like a silent
 * failure to any caller that tried to read an id or field from the
 * response — the insert succeeded but the response was empty, so
 * `result.id` returned undefined and callers logged an error or retried,
 * causing duplicate inserts. Hit concretely in Phase 5.2.5 Step D when
 * working-group-steward.ts tried to deposit a mission packet, got empty
 * back, and reported "0 deposited, 1 rejected" even though the row was
 * live in Supabase.
 *
 * Fence principle verified before changing the default:
 *   - Every production caller that explicitly needed 'return=minimal'
 *     already passes it as an option (lib/trust-provenance.ts,
 *     lib/terminal-state.ts, a client product/*, etc.). Those are unaffected.
 *   - Fire-and-forget callers (~110 sites) don't read the return value,
 *     so a slightly larger response body they never look at is negligible.
 *   - No bulk-insert callers rely on minimal for performance via the
 *     default path; the one bulk insert (a client project-intelligence.ts) is a
 *     single-element array.
 *
 * Callers that want the old behavior can still opt in with
 * `{ prefer: 'return=minimal' }`. Callers that want the new safe
 * behavior don't need to pass anything.
 */
async function supabasePost(table: string, data: any, opts: PostOptions = {}): Promise<any> {
  const { url, key } = getCredentials();
  const timeout = opts.timeout || 15000;
  let path = table;
  if (opts.onConflict) {
    path += `?on_conflict=${opts.onConflict}`;
  }
  const prefer = opts.prefer || 'return=representation';
  return withTimeout(request('POST', path, data, { url, key, prefer }), timeout);
}

/**
 * PATCH (update) rows matching a filter.
 */
async function supabasePatch(table: string, filter: string, data: any, opts: QueryOptions = {}): Promise<any> {
  const { url, key } = getCredentials();
  const timeout = opts.timeout || 15000;
  const pathAndQuery = `${table}?${filter}`;
  return withTimeout(request('PATCH', pathAndQuery, data, { url, key }), timeout);
}

/**
 * Count rows matching a filter using Prefer: count=exact header.
 */
async function supabaseCount(table: string, filter: string = '', opts: QueryOptions = {}): Promise<number> {
  const { url, key } = getCredentials();
  const timeout = opts.timeout || 15000;

  // Don't hardcode a select column — HEAD with Prefer: count=exact returns
  // Content-Range without needing any column materialization, and the hardcoded
  // `select=created_at` caused 400s on tables without that column (terminal_state,
  // etc). Fall back to an empty query if there's no filter so the URL is still
  // valid.
  const pathAndQuery = filter ? `${table}?${filter}` : table;

  return withTimeout(new Promise((resolve, reject) => {
    const fullUrl = buildUrl(url, pathAndQuery);

    const req = https.request(fullUrl, {
      method: 'HEAD',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'count=exact',
      },
    }, (res: any) => {
      // Drain FIRST on every path so the keep-alive socket is released cleanly
      // before we resolve/reject. Previous implementation drained after resolve
      // on success and not at all on error — which confused the Node HTTP agent
      // pool and caused subsequent requests to hang indefinitely after any 400.
      const statusCode = res.statusCode;
      const rangeHeader = res.headers['content-range'] || '';
      res.on('data', () => {}); // consume any body chunks
      res.on('end', () => {
        if (statusCode >= 400) {
          reject(new Error(`Supabase HEAD ${table}: ${statusCode}`));
          return;
        }
        // Parse Content-Range header: "0-N/total" or "*/total"
        const match = rangeHeader.match(/\/(\d+)$/);
        resolve(match ? parseInt(match[1], 10) : 0);
      });
      res.on('error', reject);
      // Start flowing in case no data events fire (HEAD spec says no body)
      res.resume();
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Supabase HEAD socket timeout (30s)'));
    });
    req.on('error', reject);
    req.end();
  }), timeout);
}

/**
 * DELETE rows matching a filter.
 */
async function supabaseDelete(table: string, filter: string, opts: QueryOptions = {}): Promise<any> {
  const { url, key } = getCredentials();
  const timeout = opts.timeout || 15000;
  const pathAndQuery = `${table}?${filter}`;
  return withTimeout(request('DELETE', pathAndQuery, null, { url, key }), timeout);
}

module.exports = {
  supabaseGet,
  supabasePost,
  supabasePatch,
  supabaseCount,
  supabaseDelete,
  // Exposed for testing
  _request: request,
  _getCredentials: getCredentials,
};
