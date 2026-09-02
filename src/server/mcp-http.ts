/**
 * MCP over HTTP — allows claude.ai to connect to Prime's MCP tools remotely.
 *
 * Mounts at /mcp on the existing Express server.
 * Uses StreamableHTTPServerTransport from the MCP SDK.
 *
 * Setup in claude.ai:
 *   Settings → Connectors → Add → paste your tunnel URL + /mcp
 */

import { randomUUID } from 'crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPrimeTools, MCP_SERVER_CONFIG } from './mcp.js';
import { isValidBearer } from './oauth.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MCP_PATH = process.env.PRIME_MCP_PATH || '/mcp';

// Track active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

// Desktop/claude.ai reconnects without ever sending DELETE, so transports
// accumulate forever without this — each holds a live McpServer. Sweep any
// session with no request activity for SESSION_IDLE_TIMEOUT_MS.
const lastActivity = new Map<string, number>();
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function touchSession(sessionId: string) {
  lastActivity.set(sessionId, Date.now());
}

function sweepIdleSessions() {
  const now = Date.now();
  for (const [sid, ts] of lastActivity) {
    if (now - ts <= SESSION_IDLE_TIMEOUT_MS) continue;
    const transport = transports.get(sid);
    if (transport) {
      transport.close().catch(() => {});
    }
    transports.delete(sid);
    lastActivity.delete(sid);
  }
}

export function mountMcpHttp(app: Express) {
  setInterval(sweepIdleSessions, SESSION_SWEEP_INTERVAL_MS);

  // Handle MCP requests (POST for messages, GET for SSE stream, DELETE for cleanup)
  app.all(MCP_PATH, async (req: Request, res: Response) => {
    // OAuth-protected resource (RFC 9728): unauthenticated requests get a 401 challenge
    const authHeader = String(req.headers.authorization || '');
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!bearer || !isValidBearer(bearer)) {
      res.status(401)
        .set('WWW-Authenticate', "Bearer realm=\"prime\", resource_metadata=\"https://prime.recaptureinsurance.com/.well-known/oauth-protected-resource\"")
        .json({ error: 'unauthorized', error_description: 'valid bearer token required' });
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      // Check for existing session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        touchSession(sessionId);
        // express.json() already consumed the stream — must pass the parsed body
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session — create transport + server
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Session id is assigned DURING handleRequest(initialize) — storing the
        // transport before that ran left the map empty and every follow-up
        // request hit a fresh uninitialized transport.
        onsessioninitialized: (sid: string) => { transports.set(sid, transport); touchSession(sid); },
      });

      const server = new McpServer(MCP_SERVER_CONFIG);
      registerPrimeTools(server);

      transport.onclose = () => {
        const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
        if (sid) { transports.delete(sid); lastActivity.delete(sid); }
      };

      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);

    } else if (req.method === 'GET') {
      // SSE stream for server-initiated messages
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Missing or invalid session ID' });
        return;
      }
      const transport = transports.get(sessionId)!;
      touchSession(sessionId);
      await transport.handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      // Session cleanup
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
        lastActivity.delete(sessionId);
      } else {
        res.status(200).end();
      }

    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  });

  console.log('  MCP HTTP endpoint mounted at ' + MCP_PATH.slice(0, 8) + (MCP_PATH.length > 8 ? '…' : ''));
}
