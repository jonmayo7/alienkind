// @alienkind-core
/**
 * Google OAuth2 token management — shared by google-calendar.ts and google-gmail.ts.
 *
 * Zero external dependencies. Uses refresh_token from .env to get access tokens.
 * Caches access token to logs/google-token-cache.json (refreshes when expired).
 *
 * Supports multiple accounts:
 *   getAccessToken()             — default (primary) account
 *   getAccessToken('personal')   — optional secondary account
 *
 * Forkers who run multi-account setups can add their own account entries to
 * ACCOUNT_CONFIG below — for each, pick an env var name and a cache filename.
 *
 * Stub pattern: if GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
 * are not configured, the capability is registered as unavailable and
 * getAccessToken() throws CapabilityUnavailable with enableWith guidance.
 *
 * Writers: this file (token cache files)
 * Readers: google-calendar.ts, google-gmail.ts, send-email.ts
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ALIENKIND_DIR = path.resolve(__dirname, '..', '..');
const TOKEN_CACHE_DIR = path.join(ALIENKIND_DIR, 'logs');
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// Account configs — maps account key to env var names and cache file.
// Add your own entries here for multi-account setups.
const ACCOUNT_CONFIG: Record<string, { refreshTokenKey: string; cacheFile: string }> = {
  default: { refreshTokenKey: 'GOOGLE_REFRESH_TOKEN', cacheFile: 'google-token-cache.json' },
  personal: { refreshTokenKey: 'GOOGLE_PERSONAL_REFRESH_TOKEN', cacheFile: 'google-token-cache-personal.json' },
};

// Register unavailability at load time so getCapabilityStatus() can report
// without requiring a call to fail first. Best-effort — silently skips if
// portable.ts isn't present (very fresh clone or partial install).
try {
  const { loadEnv } = require('./shared.ts');
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    try {
      const { registerUnavailable } = require('./portable.ts');
      registerUnavailable('google-oauth', {
        reason: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN not set in .env',
        enableWith: 'Create a Google Cloud project at console.cloud.google.com, enable desired APIs (Calendar, Gmail, Drive), create OAuth2 credentials, then set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in your .env',
        docs: 'https://developers.google.com/identity/protocols/oauth2',
      });
    } catch { /* portable.ts not installed — runtime check in getAccessToken() still fires */ }
  }
} catch { /* shared.ts/loadEnv not available on very early bootstrap — skip registration */ }

function getCachePath(account: string = 'default'): string {
  const config = ACCOUNT_CONFIG[account] || ACCOUNT_CONFIG.default;
  return path.join(TOKEN_CACHE_DIR, config.cacheFile);
}

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
  obtainedAt: string;
}

function httpsRequest(method: string, url: string, body: string | null, headers: Record<string, string>): Promise<{ statusCode: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: any = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res: any) => {
      let data = '';
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function loadTokenCache(account: string = 'default'): TokenCache | null {
  try {
    const cachePath = getCachePath(account);
    if (!fs.existsSync(cachePath)) return null;
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!cache.accessToken || !cache.expiresAt) return null;
    return cache;
  } catch {
    return null;
  }
}

function saveTokenCache(cache: TokenCache, account: string = 'default'): void {
  const cachePath = getCachePath(account);
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = cachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, cachePath);
}

/**
 * Get a valid access token. Returns cached token if still valid,
 * otherwise refreshes using the refresh_token from .env.
 *
 * Throws CapabilityUnavailable if Google OAuth credentials are not
 * configured — callers can catch the typed error to degrade gracefully
 * (skip calendar sync, skip email, etc.) instead of crashing.
 *
 * @param envOrAccount - either an env object, or an account name ('default' | 'personal')
 * @param env - explicit env object (used when first param is account name)
 */
async function getAccessToken(envOrAccount?: Record<string, string> | string, env?: Record<string, string>): Promise<string> {
  // Parse overloaded parameters
  let account = 'default';
  if (typeof envOrAccount === 'string') {
    account = envOrAccount;
  } else if (envOrAccount && typeof envOrAccount === 'object') {
    env = envOrAccount;
  }

  // Check cache first
  const cached = loadTokenCache(account);
  if (cached && cached.expiresAt > Date.now() + TOKEN_BUFFER_MS) {
    return cached.accessToken;
  }

  // Load env if not provided
  if (!env) {
    try {
      const { loadEnv } = require('./shared.ts');
      env = loadEnv();
    } catch {
      throw new Error('Cannot load .env — shared.ts unavailable and no env passed');
    }
  }

  const config = ACCOUNT_CONFIG[account] || ACCOUNT_CONFIG.default;
  const clientId = env!.GOOGLE_CLIENT_ID;
  const clientSecret = env!.GOOGLE_CLIENT_SECRET;
  const refreshToken = env![config.refreshTokenKey];

  if (!clientId || !clientSecret || !refreshToken) {
    // Throw CapabilityUnavailable so callers can catch the typed error and
    // degrade gracefully. Falls back to plain Error if portable.ts isn't
    // present (very fresh clone).
    try {
      const { CapabilityUnavailable } = require('./portable.ts');
      throw new CapabilityUnavailable(
        'google-oauth',
        `Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or ${config.refreshTokenKey}. Set them in .env to enable this capability.`,
        'https://developers.google.com/identity/protocols/oauth2'
      );
    } catch (e: any) {
      if (e?.name === 'CapabilityUnavailable') throw e;
      throw new Error(`Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or ${config.refreshTokenKey} in .env`);
    }
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const result = await httpsRequest(
    'POST',
    'https://oauth2.googleapis.com/token',
    params.toString(),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );

  if (result.statusCode !== 200) {
    throw new Error(`Google token refresh failed (${result.statusCode}): ${result.body}`);
  }

  const data = JSON.parse(result.body);
  const tokenCache: TokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    obtainedAt: new Date().toISOString(),
  };
  saveTokenCache(tokenCache, account);

  return data.access_token;
}

/**
 * Make an authenticated Google API request.
 * Handles 401 by refreshing the token once and retrying.
 *
 * @param account - 'default' | 'personal' (optional, defaults to 'default')
 */
async function googleApi(
  method: string,
  url: string,
  body?: any,
  env?: Record<string, string>,
  account?: string
): Promise<{ statusCode: number; data: any }> {
  let token = await getAccessToken(account || 'default', env);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  };
  let bodyStr: string | null = null;
  if (body) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  let result = await httpsRequest(method, url, bodyStr, headers);

  // Token expired — refresh and retry once
  if (result.statusCode === 401) {
    // Force refresh by clearing cache
    try { fs.unlinkSync(getCachePath(account || 'default')); } catch {}
    token = await getAccessToken(account || 'default', env);
    headers['Authorization'] = `Bearer ${token}`;
    result = await httpsRequest(method, url, bodyStr, headers);
  }

  let data: any;
  try { data = JSON.parse(result.body); } catch { data = result.body; }

  return { statusCode: result.statusCode, data };
}

module.exports = { getAccessToken, googleApi, httpsRequest, ALIENKIND_DIR };
