/**
 * Minimal OAuth 2.1 authorization server for the Prime MCP connector.
 *
 * claude.ai's custom-connector flow requires the full OAuth dance (discovery →
 * DCR → authorize → token) even for a single-user server. This implements just
 * enough of it, gated by the existing PRIME_API_KEY: the /authorize page asks
 * for the key once, so only Zach can mint tokens. Tokens live in oauth_store.
 */
import type { Express, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import express from 'express';
import { getDb, getConfig } from '../db.js';

const MCP_PATH = process.env.PRIME_MCP_PATH || '/mcp';
const BASE = 'https://prime.recaptureinsurance.com';
const CALLBACK_HOSTS = ['claude.ai', 'claude.com', 'www.claude.ai', 'www.claude.com'];

function ensureStore() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS oauth_store (
    kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    expires_at TEXT, created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (kind, id))`).run();
  return db;
}
function put(kind: string, id: string, data: any, ttlSec: number) {
  const db = ensureStore();
  db.prepare("INSERT OR REPLACE INTO oauth_store (kind, id, data, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
    .run(kind, id, JSON.stringify(data), `+${ttlSec} seconds`);
}
function take(kind: string, id: string, consume = false): any | null {
  const db = ensureStore();
  const row = db.prepare("SELECT data FROM oauth_store WHERE kind=? AND id=? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(kind, id) as any;
  if (!row) return null;
  if (consume) db.prepare('DELETE FROM oauth_store WHERE kind=? AND id=?').run(kind, id);
  return JSON.parse(row.data);
}

export function isValidBearer(token: string): boolean {
  return !!take('token', token);
}

function apiKey(): string {
  return process.env.PRIME_API_KEY || getConfig(getDb(), 'prime_api_key') || '';
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validRedirect(uri: string): boolean {
  try { const u = new URL(uri); return u.protocol === 'https:' && CALLBACK_HOSTS.includes(u.hostname); } catch { return false; }
}

function authorizePage(q: Record<string, string>, error?: string): string {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .filter(k => q[k])
    .map(k => `<input type="hidden" name="${k}" value="${String(q[k]).replace(/"/g, '&quot;')}">`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prime — Authorize</title>
<style>body{font-family:system-ui;background:#f7f5f2;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:32px;max-width:380px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 6px}p{color:#555;font-size:14px;margin:0 0 18px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:15px}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#1a1a1a;color:#fff;font-size:15px;cursor:pointer}
.err{color:#b00020;font-size:13px;margin-top:8px}</style></head><body>
<div class="card"><h1>Prime Recall</h1><p>A Claude connector is requesting access to your knowledge base. Enter the Prime access key to approve.</p>
<form method="POST" action="/authorize/decision">${hidden}
<input type="password" name="key" placeholder="Prime access key" autofocus autocomplete="current-password">
${error ? `<div class="err">${error}</div>` : ''}
<button type="submit">Approve access</button></form></div></body></html>`;
}

export function mountOAuth(app: Express) {
  ensureStore();
  app.use(express.urlencoded({ extended: false }));

  // ── Discovery metadata ──
  const asMeta = {
    issuer: BASE,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    registration_endpoint: `${BASE}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
  const prMeta = {
    resource: `${BASE}${MCP_PATH}`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
  app.get(['/.well-known/oauth-authorization-server', `/.well-known/oauth-authorization-server${MCP_PATH}`],
    (_req: Request, res: Response) => { res.json(asMeta); });
  app.get(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`],
    (_req: Request, res: Response) => { res.json(prMeta); });

  // ── Dynamic Client Registration ──
  app.post('/register', (req: Request, res: Response) => {
    const body = req.body || {};
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(validRedirect) : [];
    if (!redirectUris.length) { res.status(400).json({ error: 'invalid_redirect_uri' }); return; }
    const clientId = randomUUID();
    put('client', clientId, { redirect_uris: redirectUris, name: String(body.client_name || '').slice(0, 100) }, 3600 * 24 * 365);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: body.client_name,
    });
  });

  // ── Authorization endpoint: gated by the Prime access key ──
  app.get('/authorize', (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    if (q.response_type !== 'code' || !q.client_id || !q.redirect_uri || !q.code_challenge) {
      res.status(400).send('invalid authorization request'); return;
    }
    const client = take('client', q.client_id);
    const cimd = /^https:\/\//.test(q.client_id); // Anthropic-hosted client metadata: client_id is a URL
    const redirectOk = client ? (client.redirect_uris as string[]).includes(q.redirect_uri) : (cimd && validRedirect(q.redirect_uri));
    if (!redirectOk) { res.status(400).send('unknown client or redirect_uri'); return; }
    res.send(authorizePage(q));
  });

  app.post('/authorize/decision', (req: Request, res: Response) => {
    const b = req.body || {};
    const expected = apiKey();
    if (!expected || b.key !== expected) {
      res.status(401).send(authorizePage(b, 'Wrong key — check ~/.prime or .env on the Mini.')); return;
    }
    const client = take('client', b.client_id);
    const cimd = /^https:\/\//.test(String(b.client_id || ''));
    const redirectOk = client ? (client.redirect_uris as string[]).includes(b.redirect_uri) : (cimd && validRedirect(b.redirect_uri));
    if (!redirectOk) { res.status(400).send('unknown client or redirect_uri'); return; }
    const code = randomUUID();
    put('code', code, { client_id: b.client_id, redirect_uri: b.redirect_uri, code_challenge: b.code_challenge, scope: b.scope || 'mcp' }, 600);
    const target = new URL(b.redirect_uri);
    target.searchParams.set('code', code);
    if (b.state) target.searchParams.set('state', b.state);
    res.redirect(302, target.toString());
  });

  // ── Token endpoint ──
  app.post('/token', (req: Request, res: Response) => {
    const b = req.body || {};
    if (b.grant_type === 'authorization_code') {
      const grant = take('code', String(b.code || ''), true);
      if (!grant) { res.status(400).json({ error: 'invalid_grant' }); return; }
      if (grant.client_id !== b.client_id || (b.redirect_uri && grant.redirect_uri !== b.redirect_uri)) {
        res.status(400).json({ error: 'invalid_grant' }); return;
      }
      const challenge = b64url(createHash('sha256').update(String(b.code_verifier || '')).digest());
      if (challenge !== grant.code_challenge) { res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }); return; }
      const access = randomUUID(), refresh = randomUUID();
      put('token', access, { client_id: grant.client_id, scope: grant.scope }, 3600 * 24 * 30);
      put('refresh', refresh, { client_id: grant.client_id, scope: grant.scope }, 3600 * 24 * 180);
      res.json({ access_token: access, token_type: 'Bearer', expires_in: 3600 * 24 * 30, refresh_token: refresh, scope: grant.scope });
    } else if (b.grant_type === 'refresh_token') {
      const grant = take('refresh', String(b.refresh_token || ''), true);
      if (!grant) { res.status(400).json({ error: 'invalid_grant' }); return; }
      const access = randomUUID(), refresh = randomUUID();
      put('token', access, grant, 3600 * 24 * 30);
      put('refresh', refresh, grant, 3600 * 24 * 180);
      res.json({ access_token: access, token_type: 'Bearer', expires_in: 3600 * 24 * 30, refresh_token: refresh, scope: grant.scope });
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });

  console.log('  OAuth endpoints mounted (/authorize, /token, /register, /.well-known)');
}
