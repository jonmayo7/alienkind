#!/usr/bin/env npx tsx

/**
 * Webhook Channel Adapter — HTTP endpoint for any external system to bridge in.
 *
 * Use case: Zapier, custom mobile app, IFTTT, your own frontend, etc. Anything
 * that can POST JSON can talk to your partner.
 *
 * Substrate-agnostic via askPartner().
 *
 * Required env:
 *   WEBHOOK_AUTH_TOKEN — caller passes this in Authorization: Bearer <token>
 *
 * Optional:
 *   WEBHOOK_PORT       — default 8787
 *   WEBHOOK_HOST       — default 0.0.0.0 (localhost-only: set to 127.0.0.1)
 *
 * Endpoint:
 *   POST /partner
 *   Headers: Authorization: Bearer <WEBHOOK_AUTH_TOKEN>, Content-Type: application/json
 *   Body:    { "message": "Hello", "user_id": "optional-string" }
 *   Returns: { "reply": "..." }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv();
Object.assign(process.env, env);

const AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN;
const PORT = parseInt(process.env.WEBHOOK_PORT || '8787');
const HOST = process.env.WEBHOOK_HOST || '0.0.0.0';

if (!AUTH_TOKEN) {
  console.error('[webhook] WEBHOOK_AUTH_TOKEN not set — refusing to start (would accept anonymous requests)');
  process.exit(1);
}

const { askPartner } = require(path.join(ROOT, 'scripts', 'lib', 'substrate.ts'));

const server = http.createServer(async (req: any, res: any) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/partner') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try: POST /partner');
    return;
  }

  // Auth
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (auth !== expected) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // Body
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', async () => {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    const message = parsed.message || parsed.prompt || parsed.text;
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid "message" field' }));
      return;
    }

    try {
      const reply = await askPartner(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply }));
    } catch (err: any) {
      console.error(`[webhook] askPartner failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message.slice(0, 300) }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[webhook] listening on http://${HOST}:${PORT}/partner`);
  console.log(`[webhook] health: http://${HOST}:${PORT}/health`);
});
