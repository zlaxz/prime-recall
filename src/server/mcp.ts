/**
 * Prime MCP Server
 *
 * Exposes Prime's knowledge base as MCP tools that Claude Desktop,
 * Cowork, Claude Code, and any MCP-compatible tool can use natively.
 *
 * Tools:
 * - prime_search(query) — Semantic search
 * - prime_ask(question) — AI-powered Q&A
 * - prime_remember(content, type) — Quick capture
 * - prime_get_contacts() — List known contacts
 * - prime_get_commitments() — Outstanding commitments
 * - prime_get_projects() — Project list
 * - prime_log_decision(decision, context) — Record a decision
 * - prime_status() — Knowledge base stats
 *
 * To use: Add to claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "prime": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/prime/src/server/mcp.ts"]
 *     }
 *   }
 * }
 */

import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { v4 as uuid } from 'uuid';

// MCP stdio protocol implementation
async function main() {
  const db = await getDb();

  // MCP tool definitions
  const tools = [
    {
      name: 'prime_search',
      description: 'Search the knowledge base using semantic similarity. Returns contacts, decisions, commitments, and other intelligence from email, meetings, and conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
          source: { type: 'string', description: 'Filter by source: gmail, calendar, otter, claude, file, manual' },
          project: { type: 'string', description: 'Filter by project name' },
        },
        required: ['query'],
      },
    },
    {
      name: 'prime_ask',
      description: 'Ask a question about the user\'s business. Uses knowledge base + AI reasoning to provide grounded answers with specific names, dates, and facts.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question about the user\'s business' },
        },
        required: ['question'],
      },
    },
    {
      name: 'prime_remember',
      description: 'Save a piece of knowledge — a decision, commitment, fact, or insight. Prime extracts contacts, organizations, and tags automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to remember' },
          project: { type: 'string', description: 'Project to associate with' },
          importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'How important this is' },
        },
        required: ['content'],
      },
    },
    {
      name: 'prime_get_contacts',
      description: 'Get a list of all known contacts from the knowledge base, sorted by frequency of mention.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'prime_get_commitments',
      description: 'Get all outstanding commitments and promises tracked in the knowledge base.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'prime_get_projects',
      description: 'Get a list of projects identified in the knowledge base.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'prime_status',
      description: 'Get knowledge base statistics — total items, items by source, sync status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  // Handle MCP stdio protocol
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk;

    // Process complete JSON-RPC messages
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/);
      if (!contentLengthMatch) break;

      const contentLength = parseInt(contentLengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      handleMessage(JSON.parse(body), db).catch(console.error);
    }
  });

  function sendResponse(response: any) {
    const body = JSON.stringify(response);
    const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    process.stdout.write(message);
  }

  async function handleMessage(message: any, db: any) {
    const { id, method, params } = message;

    if (method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'prime', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { tools },
      });
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      let result: any;

      try {
        const apiKey = getConfig(db, 'openai_api_key');

        switch (name) {
          case 'prime_search': {
            let results: any[];
            if (apiKey) {
              try {
                const queryEmb = await generateEmbedding(args.query, apiKey);
                results = searchByEmbedding(db, queryEmb, args.limit || 10, 0.3);
              } catch {
                results = searchByText(db, args.query, args.limit || 10);
              }
            } else {
              results = searchByText(db, args.query, args.limit || 10);
            }
            if (args.source) results = results.filter((r: any) => r.source === args.source);
            if (args.project) results = results.filter((r: any) => r.project?.toLowerCase().includes(args.project.toLowerCase()));
            result = results.map((r: any) => ({
              title: r.title,
              summary: r.summary,
              source: r.source,
              source_ref: r.source_ref,
              contacts: r.contacts,
              commitments: r.commitments,
              importance: r.importance,
              similarity: r.similarity,
            }));
            break;
          }

          case 'prime_ask': {
            const askResult = await askWithSources(db, args.question);
            result = askResult.answer + '\n\nSources:\n' + askResult.sources.map(s => `[${s.num}] ${s.title} (${s.source})`).join('\n');
            break;
          }

          case 'prime_remember': {
            if (!apiKey) throw new Error('No API key');
            const extracted = await extractIntelligence(args.content, apiKey);
            const embText = `${extracted.title}\n${extracted.summary}\n${args.content}`;
            const embedding = await generateEmbedding(embText, apiKey);

            const item: KnowledgeItem = {
              id: uuid(),
              title: extracted.title,
              summary: extracted.summary,
              source: 'mcp',
              source_ref: `mcp:${Date.now()}`,
              source_date: new Date().toISOString(),
              contacts: extracted.contacts,
              organizations: extracted.organizations,
              decisions: extracted.decisions,
              commitments: extracted.commitments,
              action_items: extracted.action_items,
              tags: extracted.tags,
              project: args.project || extracted.project,
              importance: args.importance || extracted.importance,
              embedding,
            };
            insertKnowledge(db, item);
            result = { saved: true, title: item.title, id: item.id };
            break;
          }

          case 'prime_get_contacts': {
            const all = searchByText(db, '', 1000);
            const contacts = new Map<string, number>();
            for (const item of all) {
              const c = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
              for (const name of c) {
                contacts.set(name, (contacts.get(name) || 0) + 1);
              }
            }
            result = Array.from(contacts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => ({ name, mentions: count }));
            break;
          }

          case 'prime_get_commitments': {
            const all = searchByText(db, '', 1000);
            const commitments: any[] = [];
            for (const item of all) {
              const c = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
              for (const text of c) {
                commitments.push({ text, source: item.source, date: item.source_date, project: item.project });
              }
            }
            result = commitments;
            break;
          }

          case 'prime_get_projects': {
            const all = searchByText(db, '', 1000);
            const projects = new Map<string, number>();
            for (const item of all) {
              if (item.project) projects.set(item.project, (projects.get(item.project) || 0) + 1);
            }
            result = Array.from(projects.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([name, items]) => ({ name, items }));
            break;
          }

          case 'prime_status': {
            result = getStats(db);
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (err: any) {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          },
        });
        return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        },
      });
    }
  }
}

main().catch(console.error);
