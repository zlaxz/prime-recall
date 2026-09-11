#!/usr/bin/env node

/**
 * Prime Recall MCP Proxy
 *
 * For LAPTOP use: forwards all MCP tool calls to the Mac Mini's REST API.
 * Falls back to local SQLite if the server is unreachable.
 *
 * This solves the split-brain problem: Claude Desktop on the laptop
 * always reads the Mac Mini's fresh data instead of a stale local copy.
 *
 * Architecture:
 *   Claude Desktop → MCP (stdio) → this proxy → HTTP → Mac Mini:3210/api/*
 *                                              ↘ fallback → local SQLite
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from 'http';
import https from 'https';

// Mac Mini server — try LAN first, then tunnel
const SERVERS = [
  'http://Zachs-Mac-mini.local:3210',   // LAN (fast, <5ms)
  'https://prime.recaptureinsurance.com', // Cloudflare named tunnel (works from anywhere)
];

let _activeServer: string | null = null;
let _lastCheck = 0;

/**
 * Find a reachable server. Caches for 60 seconds.
 */
async function getServer(): Promise<string | null> {
  if (_activeServer && Date.now() - _lastCheck < 60000) return _activeServer;

  for (const server of SERVERS) {
    try {
      const ok = await httpGet(`${server}/api/health`, 3000);
      if (ok) {
        _activeServer = server;
        _lastCheck = Date.now();
        return server;
      }
    } catch (_e) {}
  }

  _activeServer = null;
  return null;
}

// Auth header for the Mac Mini's serve. Set via Claude Desktop's MCP env block
// (claude_desktop_config.json -> mcpServers.prime-recall.env.PRIME_API_KEY).
// The serve enforces this on all /api/* routes except /api/health, /api/status,
// and /mcp/*. Without it the proxy gets {"error":"unauthorized"} on most calls
// and silently shows empty results because most tool handlers do
// `(result.foo || []).map(...)` — only prime_search surfaces the JSON error.
const API_KEY = process.env.PRIME_API_KEY || '';
const authHeaders: Record<string, string> = API_KEY ? { 'X-API-Key': API_KEY } : {};

/**
 * HTTP GET with timeout. Returns parsed JSON or null.
 */
function httpGet(url: string, timeout = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout,
      headers: authHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * HTTP POST with JSON body. Returns parsed JSON.
 */
function httpPost(url: string, body: any, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const parsed = new URL(url);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...authHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// MCP Server — proxies to Mac Mini REST API
// ============================================================

const server = new McpServer({
  name: "prime-recall",
  version: "2.0.0",
  description: `Prime — Zach's AI Chief of Staff running on Mac Mini (8K+ knowledge items, entity graph, intelligence cycle).

INTERACTION MODEL: You are a RELAY to Prime, not an interpreter. When Zach asks about business, projects, people, or priorities:
1. Call the relevant Prime tool
2. Return the result AS-IS — do not summarize, reinterpret, or add commentary
3. Prime has already done the thinking. You are the voice, not the analyst.

WHEN TO ADD YOUR OWN THINKING: Only when Zach explicitly asks you to analyze, strategize, or think through something. Then you become a collaborative partner using Prime's data as context.

KEY TOOLS:
- prime_briefing: THE intelligence brief — headline, actions with drafts, hypotheses, theories of mind
- prime_entity [name]: Living profile on any person — motivations, behavior, predicted next move
- prime_simulate [entity, scenario]: Practice a conversation with a simulated counterparty
- prime_shadow_board [decision]: 4 AI advisors evaluate a decision in parallel
- prime_ripple [event]: Trace cascading implications across all projects
- prime_search [query]: Find anything in the knowledge base
- prime_ask [question]: Deep question answering with cited sources

NEVER do these without being asked: draft emails, suggest actions, generate upgrade requests, call multiple tools in sequence. Let Prime's pre-built intelligence speak for itself.`,
});

// Helper: proxy a search request
async function proxySearch(query: string, limit: number = 10, strategy?: string): Promise<string> {
  const srv = await getServer();
  if (!srv) return 'Prime Recall server unreachable. Mac Mini may be offline.';

  try {
    const result = await httpPost(`${srv}/api/search`, { query, limit, strategy }, 120000);
    if (result.results) {
      return result.results.map((r: any, i: number) => {
        const sim = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : '';
        const contacts = Array.isArray(r.contacts) ? r.contacts : [];
        const commitments = Array.isArray(r.commitments) ? r.commitments : [];
        let entry = `[${i + 1}] ${r.title}${sim}`;
        entry += `\n   ${r.summary}`;
        entry += `\n   Source: ${r.source} | Date: ${r.source_date || 'unknown'}${r.project ? ` | Project: ${r.project}` : ''}`;
        if (contacts.length) entry += `\n   Contacts: ${contacts.join(', ')}`;
        if (commitments.length) entry += `\n   Commitments: ${commitments.join('; ')}`;
        return entry;
      }).join('\n\n');
    }
    return JSON.stringify(result);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// ---- Tools ----

server.tool(
  "prime_search",
  "Search the knowledge base — emails, conversations, meetings, files. Returns relevant items with similarity scores. MULTI-HOP: If first results don't fully answer the question, search AGAIN with refined terms from what you found. For example: search 'Foresite deal' → find mention of 'Costas term sheet' → search 'Costas term sheet' for specifics. ALWAYS use prime_retrieve on top results for full content before making claims. If results are still poor, call prime_remember with 'SYSTEM GAP: [what was missing]'.",
  {
    query: z.string().describe("What to search for"),
    limit: z.number().optional().default(10),
    strategy: z.string().optional().describe("Search strategy: auto, semantic, keyword, graph, temporal, hierarchical"),
  },
  async ({ query, limit, strategy }) => {
    const text = await proxySearch(query, limit, strategy);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_ask",
  "Ask Prime anything about the user's business. Returns an AI-generated answer with cited sources.",
  {
    question: z.string().describe("The question to ask"),
  },
  async ({ question }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/ask`, { question }, 120000); // 2 min — Claude reasoning takes time
      return { content: [{ type: "text" as const, text: result.answer || JSON.stringify(result) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_remember",
  "Save something to the knowledge base — a fact, decision, correction, or observation. Has strict write discipline: checks for duplicates and contradictions before saving. Use for SYSTEM GAP, SYSTEM SUGGESTION, corrections, and user-stated facts.",
  {
    text: z.string().describe("What to remember"),
    project: z.string().optional().describe("Project to associate with"),
    importance: z.string().optional().describe("low, normal, high, or critical"),
  },
  async ({ text, project, importance }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      // Strict write discipline: check for duplicates first
      const searchResult = await httpPost(`${srv}/api/search`, { query: text.slice(0, 200), limit: 3 }, 30000);
      const results = searchResult?.results || [];
      const isDuplicate = results.some((r: any) => r.similarity > 0.92);
      if (isDuplicate) {
        const match = results.find((r: any) => r.similarity > 0.92);
        return { content: [{ type: "text" as const, text: `NOT SAVED — very similar item already exists (${Math.round(match.similarity * 100)}% match): "${match.title}". Use prime_correct to update existing items instead.` }] };
      }

      const result = await httpPost(`${srv}/api/remember`, { text, project, importance }, 120000);
      return { content: [{ type: "text" as const, text: `Remembered: ${result.title || text.slice(0, 60)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_status",
  "Show knowledge base statistics — item counts, sources, sync state.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/status`);
      let text = `Knowledge items: ${result.total_items}\n`;
      if (result.by_source) {
        text += '\nBy source:\n' + result.by_source.map((s: any) => `  ${s.source}: ${s.count}`).join('\n');
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_commitments",
  "Show all commitments — overdue, due soon, active, fulfilled.",
  {
    state: z.string().optional().describe("Filter by state: active, overdue, fulfilled, dropped"),
    project: z.string().optional(),
  },
  async ({ state, project }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/commitments`);
      let text = '';
      for (const c of (result.commitments || [])) {
        if (state && c.state !== state) continue;
        if (project && c.project !== project) continue;
        const due = c.due_date ? ` (due ${c.due_date})` : '';
        text += `[${c.state}] ${c.text}${due}\n  Owner: ${c.owner || '?'} | Project: ${c.project || '?'}\n\n`;
      }
      return { content: [{ type: "text" as const, text: text || 'No commitments match.' }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_contacts",
  "List contacts by mention frequency.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/contacts`);
      const text = (result.contacts || []).slice(0, 20)
        .map((c: any) => `${c.name} (${c.count} mentions)`)
        .join('\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_projects",
  "List active projects.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/query/projects`);
      const text = (result.projects || [])
        .map((p: any) => `${p.name} (${p.items} items)`)
        .join('\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_questions",
  "Get pending questions that Prime needs the user to answer. These are strategic questions only the user can answer — about deal status, relationship context, business decisions. When questions exist, ASK THEM. When the user answers, call prime_answer_question with the answer.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/v1/questions`);
      const questions = result.questions || result || [];
      if (questions.length === 0) return { content: [{ type: "text" as const, text: 'No pending questions.' }] };
      const text = questions.map((q: any, i: number) => {
        let entry = `[${i + 1}] (${q.priority || 'medium'}) ${q.question}`;
        if (q.project) entry += `\n   Project: ${q.project}`;
        if (q.context) entry += `\n   Context: ${q.context}`;
        entry += `\n   ID: ${q.id}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `${questions.length} pending questions:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_answer_question",
  "Submit the user's answer to a pending Prime question. The answer becomes knowledge that improves future reasoning.",
  {
    question_id: z.string().describe("The question ID from prime_questions"),
    answer: z.string().describe("The user's answer"),
  },
  async ({ question_id, answer }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/v1/questions/${question_id}/answer`, { answer }, 30000);
      return { content: [{ type: "text" as const, text: `Answer saved. Prime will use this in future reasoning.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_briefing",
  "Get Prime's intelligence briefing — the headline, the ONE action to take right now, ranked actions with email drafts/talking points, top hypotheses, theories of mind, contradictions, and upcoming calendar. This is pre-built by the dream pipeline's intelligence cycle (Claude Opus reasoning on 28K+ chars of business context). Call this FIRST when the user sits down.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/ambient`, 30000);
      const brief = result.cos_ready_brief;
      const intel = result.intelligence_brief;
      const actions = result.intelligence_actions || [];

      if (!brief && !intel) {
        return { content: [{ type: "text" as const, text: 'No intelligence brief available. The dream pipeline needs to run first.' }] };
      }

      // Format the brief for COS consumption
      const parts: string[] = [];

      // Headline
      parts.push(`## ${brief?.headline || intel?.headline || 'No headline'}\n`);
      parts.push(`**THE ONE THING:** ${brief?.the_one_thing || intel?.the_one_thing || 'Run dream pipeline'}\n`);

      // Actions with drafts
      if (actions.length > 0) {
        parts.push('---\n### ACTIONS (ready to execute)\n');
        for (const a of actions) {
          parts.push(`**#${a.priority} [${a.type} | ${a.deadline}] ${a.title}**`);
          if (a.target_person) parts.push(`Target: ${a.target_person}`);
          parts.push(`Why: ${a.rationale}`);
          if (a.draft) parts.push(`\n> DRAFT:\n> ${a.draft.replace(/\n/g, '\n> ')}\n`);
          if (a.depends_on) parts.push(`Depends on: ${a.depends_on}`);
          parts.push('');
        }
      }

      // Top hypotheses
      const hypotheses = brief?.top_hypotheses || intel?.hypotheses?.slice(0, 3) || [];
      if (hypotheses.length > 0) {
        parts.push('---\n### HYPOTHESES\n');
        for (const h of hypotheses) {
          parts.push(`- [${h.confidence}%] ${h.claim}`);
          if (h.action) parts.push(`  Action: ${h.action}`);
        }
        parts.push('');
      }

      // Contradictions
      const contradictions = brief?.contradictions || intel?.contradictions || [];
      if (contradictions.length > 0) {
        parts.push('---\n### CONTRADICTIONS\n');
        for (const c of contradictions) {
          parts.push(`- ${c.tension || c.claim_a}`);
          parts.push(`  Resolve: ${c.resolution || c.resolution_needed}`);
        }
        parts.push('');
      }

      // Calendar
      if (brief?.calendar_next) {
        parts.push('---\n### UPCOMING\n');
        parts.push(brief.calendar_next);
        parts.push('');
      }

      return { content: [{ type: "text" as const, text: parts.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_retrieve",
  "Retrieve the FULL original content from ANY source — emails, conversations, meeting transcripts, manual entries, cowork sessions, documents. Works for ALL source types. For large content, use offset/limit to paginate (e.g., offset=0 limit=50000 for first 50K chars, then offset=50000 for the next chunk).",
  {
    source_ref: z.string().describe("The source_ref from a search result"),
    offset: z.number().optional().default(0).describe("Character offset to start reading from (for pagination)"),
    limit: z.number().optional().default(50000).describe("Max characters to return (default 50000)"),
  },
  async ({ source_ref, offset, limit }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/retrieve`, { source_ref }, 60000);
      if (result.content) {
        const total = result.content.length;
        const chunk = result.content.slice(offset, offset + limit);
        const hasMore = (offset + limit) < total;
        let header = `[${result.content_type || 'source'}] ${total} chars total`;
        if (offset > 0 || hasMore) {
          header += ` | showing ${offset}-${offset + chunk.length}`;
        }
        if (hasMore) {
          header += ` | MORE AVAILABLE: call again with offset=${offset + limit}`;
        }
        return { content: [{ type: "text" as const, text: `${header}\n\n${chunk}` }] };
      }
      return { content: [{ type: "text" as const, text: `Could not retrieve source content for ${source_ref}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error retrieving source: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_actions",
  "Get ranked action items from the intelligence cycle. These are specific, prioritized actions with full drafts — emails to send, calls to make, prep to do. Each includes rationale and ready-to-use content.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/ambient`);
      const actions = result.actions || [];
      if (actions.length === 0) return { content: [{ type: "text" as const, text: 'No pending actions. The intelligence cycle may need to run.' }] };
      const text = actions.map((a: any) => {
        let entry = `**#${a.priority} [${a.type} | ${a.deadline}] ${a.title}**`;
        if (a.target_person) entry += `\nTarget: ${a.target_person}`;
        entry += `\nWhy: ${a.rationale}`;
        if (a.draft) entry += `\n\nDraft:\n${a.draft}`;
        if (a.depends_on) entry += `\n\nDepends on: ${a.depends_on}`;
        return entry;
      }).join('\n\n---\n\n');
      return { content: [{ type: "text" as const, text: `${actions.length} actions:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_approve",
  "Approve and execute a staged action — send an email, create a calendar event, etc. Use after reviewing the action with the user.",
  {
    action_id: z.string().describe("The action ID from prime_actions"),
  },
  async ({ action_id }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/approve-action`, { id: action_id }, 30000);
      return { content: [{ type: "text" as const, text: result.message || `Action ${action_id} executed.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_notify",
  "Send a notification to the user (iMessage for critical/high, logged for normal/low).",
  {
    message: z.string().describe("Notification message"),
    urgency: z.string().optional().default("normal").describe("critical, high, normal, low"),
  },
  async ({ message, urgency }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/notify`, { message, urgency });
      return { content: [{ type: "text" as const, text: `Notification sent (${urgency}): ${message.slice(0, 60)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Notification logged locally: ${message.slice(0, 60)}` }] };
    }
  }
);

server.tool(
  "prime_correct",
  "Give feedback to Prime — dismiss an action, correct a classification, put something on hold. This teaches Prime to not make the same mistake again. Use when the user says something like 'that's not relevant' or 'I already handled that' or 'Brayden is on hold'.",
  {
    action_id: z.string().optional().describe("ID of the staged action to dismiss (from search results)"),
    reason: z.enum(["already_handled", "on_hold", "wrong_person", "not_mine", "noise"]).describe("Why this is being dismissed"),
    explanation: z.string().optional().describe("Additional context — helps Prime learn (e.g., 'We decided to pause this on Friday')"),
    entity_name: z.string().optional().describe("Entity name to put on hold or dismiss"),
  },
  async ({ action_id, reason, explanation, entity_name }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/dismiss-action`, {
        id: action_id || `entity-${entity_name}`,
        reason,
        explanation: explanation || '',
      }, 30000);
      return { content: [{ type: "text" as const, text: `Correction saved. Prime will learn: ${result.correction_rule?.slice(0, 150)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_conversations",
  "Search and list Claude.ai conversations across ALL organizations. Use this to find prior conversations about a topic, person, or project. Returns conversation titles, summaries, and UUIDs you can use with prime_claude_read.",
  {
    query: z.string().optional().describe("Search term to filter conversations by title/summary"),
  },
  async ({ query }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const url = query ? `${srv}/api/claude/conversations?q=${encodeURIComponent(query)}` : `${srv}/api/claude/conversations`;
      const result = await httpGet(url);
      const convos = result.conversations || result || [];
      if (convos.length === 0) return { content: [{ type: "text" as const, text: query ? `No conversations matching "${query}".` : 'No conversations found.' }] };
      const text = convos.slice(0, 20).map((c: any, i: number) => {
        let entry = `[${i + 1}] ${c.name || 'Untitled'}`;
        if (c.org) entry += ` (${c.org})`;
        if (c.project) entry += ` [${c.project}]`;
        if (c.summary) entry += `\n   ${c.summary.slice(0, 150)}`;
        entry += `\n   UUID: ${c.uuid}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `${result.total || convos.length} conversations${query ? ` matching "${query}"` : ''}:\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_read",
  "Read the FULL content of a Claude.ai conversation including all messages. Use after prime_claude_conversations to get the UUID. IMPORTANT: Always use this tool when the user asks about content from a prior Claude conversation — summaries are not enough. Also check prime_claude_files for any images, documents, or artifacts in the conversation.",
  {
    uuid: z.string().describe("The conversation UUID from prime_claude_conversations"),
  },
  async ({ uuid }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/claude/conversations/${uuid}`);
      if (!result.messages?.length) return { content: [{ type: "text" as const, text: 'Conversation not found or empty.' }] };
      const text = `Conversation: "${result.name}" (${result.message_count} messages)\n\n` +
        result.messages.map((m: any) =>
          `[${m.sender}] ${m.text?.slice(0, 2000)}`
        ).join('\n\n---\n\n');
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_claude_files",
  "List all files and artifacts (images, PDFs, documents, logos) from a Claude.ai conversation. Returns file names, types, and download URLs. Use when the user needs to find images, logos, documents, or other files from prior conversations.",
  {
    uuid: z.string().describe("The conversation UUID from prime_claude_conversations"),
  },
  async ({ uuid }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/claude/conversations/${uuid}/files`);
      if (!result.files?.length) return { content: [{ type: "text" as const, text: 'No files found in this conversation.' }] };
      const text = `Conversation: "${result.conversation}" — ${result.total} files:\n\n` +
        result.files.map((f: any, i: number) =>
          `[${i + 1}] ${f.name} (${f.kind})\n   Download: ${srv}${f.download_url}`
        ).join('\n\n');
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

// ============================================================
// Start
// ============================================================

server.tool(
  "prime_deep_session",
  "Run a deep strategic work session. This reads everything in Prime about a topic, researches externally, generates creative strategy, and produces FINISHED deliverables (full email drafts, plans, documents). Takes 10-15 minutes. Use when the user needs a comprehensive strategy or plan for a business problem.",
  {
    topic: z.string().describe("The problem to solve (e.g., 'Carefront broker outreach strategy')"),
    project: z.string().optional().describe("Project context if applicable"),
  },
  async ({ topic, project }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/deep-session`, { topic, project }, 3600000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Deep session failed: ${result.error}` }] };
      }
      const summary = [
        `Deep Session Complete: ${result.title}`,
        `${result.deliverables?.length || 0} deliverables, ${result.actions_created} actions`,
        `${result.duration_seconds?.toFixed(0)}s, ${result.turns_used} turns`,
        `Files: ${result.output_dir}`,
      ].join('\n');
      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Deep session error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_proactive_alerts",
  "Check for REAL-TIME proactive alerts — new emails from key entities detected in the last sync cycle. Use at the START of every conversation to see if anything urgent arrived since last check. Also shows upcoming meetings in the next 2 hours.",
  {},
  async () => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/ambient`);
      const alerts: string[] = [];

      // Proactive alerts from sync trigger
      if (result.proactive_alerts?.length) {
        alerts.push('⚡ NEW FROM KEY ENTITIES:');
        for (const a of result.proactive_alerts) {
          alerts.push(`  ${a.entity} — ${a.title} (${a.source_date?.slice(0, 10)})`);
          if (a.context) alerts.push(`    Context: ${a.context}`);
        }
      }

      // Upcoming meetings (with attendees from meeting prep)
      if (result.upcoming_meetings?.length) {
        alerts.push('\n📅 UPCOMING MEETINGS:');
        for (const m of result.upcoming_meetings) {
          alerts.push(`  ${m.time} — ${m.title}`);
          if (m.attendees?.length) alerts.push(`    Attendees: ${m.attendees.join(', ')}`);
          if (m.summary) alerts.push(`    ${m.summary}`);
        }
      }

      // Cross-project patterns
      if (result.cross_project_patterns?.length) {
        alerts.push('\n🔗 CROSS-PROJECT PATTERNS:');
        for (const p of result.cross_project_patterns.slice(0, 5)) {
          alerts.push(`  [${p.type}] ${p.insight}`);
        }
      }

      // Detected contradictions
      if (result.detected_contradictions?.length) {
        const actionable = result.detected_contradictions.filter((c: any) => c.type && c.type !== 'label_change');
        if (actionable.length > 0) {
          alerts.push('\n⚠️ CONTRADICTIONS DETECTED:');
          for (const c of actionable.slice(0, 5)) {
            alerts.push(`  [${c.type}] ${c.entity}: ${c.detail || c.current_label}`);
            if (c.recommended_action) alerts.push(`    → ${c.recommended_action}`);
          }
        }
      }

      // Pending actions count
      if (result.actions_pending) {
        alerts.push(`\n📋 ${result.actions_pending} pending actions`);
      }

      // Pending questions
      if (result.questions_pending) {
        alerts.push(`❓ ${result.questions_pending} questions need your answers`);
      }

      // Pre-built COS brief from dream pipeline (zero-latency)
      // The cos_ready_brief comes from the ambient endpoint's graph_state data
      if (result.cos_ready_brief) {
        const brief = typeof result.cos_ready_brief === 'string' ? JSON.parse(result.cos_ready_brief) : result.cos_ready_brief;
        const briefAge = (Date.now() - new Date(brief.generated_at).getTime()) / 3600000;
        if (briefAge < 8) {
          const briefLines: string[] = [];
          briefLines.push('========================================');
          briefLines.push('DREAM PIPELINE BRIEF (pre-built overnight)');
          briefLines.push('========================================');
          briefLines.push(`\nONE THING TO DO FIRST: ${brief.one_thing}`);
          if (brief.one_thing_draft) {
            briefLines.push(`\nDRAFTED FOR YOU:\n${brief.one_thing_draft}`);
          }
          if (brief.decisions_to_respect?.length) {
            briefLines.push(`\nSTANDING DECISIONS TO RESPECT:`);
            for (const d of brief.decisions_to_respect) {
              briefLines.push(`  - ${d}`);
            }
          }
          if (brief.calendar_next) {
            briefLines.push(`\nNEXT ON CALENDAR: ${brief.calendar_next}`);
          }
          if (brief.alerts?.length) {
            briefLines.push(`\nALERTS:`);
            for (const a of brief.alerts) {
              briefLines.push(`  - ${typeof a === 'string' ? a : a.summary || JSON.stringify(a)}`);
            }
          }
          briefLines.push(`\n(Generated by ${brief.generated_by || 'dream-pipeline'} at ${brief.generated_at})`);
          briefLines.push('========================================\n');
          // Insert brief as FIRST section
          alerts.unshift(briefLines.join('\n'));
        }
      }

      // Active institutional decisions (10 most recent)
      try {
        const decisionsResult = await httpGet(`${srv}/api/v1/decisions`, 5000);
        const decisions = decisionsResult?.decisions || [];
        if (decisions.length > 0) {
          alerts.push('\n📌 STANDING DECISIONS (respect these):');
          for (const d of decisions.slice(0, 10)) {
            const tag = d.entity_name ? `[${d.entity_name}]` : d.project ? `[${d.project}]` : d.category ? `[${d.category}]` : '';
            alerts.push(`  ${tag} ${d.decision}`);
          }
        }
      } catch (_e) {}

      return { content: [{ type: "text" as const, text: alerts.length > 0 ? alerts.join('\n') : 'No proactive alerts. All clear.' }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_decision_log",
  "Log a decision made by the user — approvals, dismissals, corrections, strategic choices. Stores in the institutional decisions table so the COS and dream pipeline respect it automatically. Always call this when the user makes a significant decision.",
  {
    decision: z.string().describe("What was decided"),
    context: z.string().optional().describe("Why this decision was made"),
    category: z.string().optional().describe("strategic, entity, project, operational, correction"),
    project: z.string().optional().describe("Related project"),
    entity_name: z.string().optional().describe("Related entity/person name"),
  },
  async ({ decision, context, category, project, entity_name }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/v1/decisions`, {
        decision,
        reasoning: context,
        category: category || 'strategic',
        project,
        entity_name,
        source: 'user',
      }, 30000);
      return { content: [{ type: "text" as const, text: `Decision logged: ${result.decision || decision.slice(0, 60)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_get_decisions",
  "List active institutional decisions. These are standing constraints the user has set — the COS and dream pipeline respect them automatically. Filter by project, entity, or category.",
  {
    project: z.string().optional().describe("Filter by project"),
    entity_name: z.string().optional().describe("Filter by entity/person name"),
    category: z.string().optional().describe("Filter by category: strategic, entity, project, operational, correction"),
  },
  async ({ project, entity_name, category }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const params = new URLSearchParams();
      if (project) params.set('project', project);
      if (entity_name) params.set('entity_name', entity_name);
      if (category) params.set('category', category);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await httpGet(`${srv}/api/v1/decisions${qs}`);
      const decisions = result.decisions || [];
      if (decisions.length === 0) {
        return { content: [{ type: "text" as const, text: 'No active decisions match the filter.' }] };
      }
      const text = decisions.map((d: any, i: number) => {
        let entry = `[${i + 1}] ${d.decision}`;
        if (d.category) entry += ` [${d.category}]`;
        if (d.project) entry += ` | Project: ${d.project}`;
        if (d.entity_name) entry += ` | Entity: ${d.entity_name}`;
        if (d.reasoning) entry += `\n   Reasoning: ${d.reasoning}`;
        entry += `\n   Source: ${d.source || '?'} | ${d.created_at}`;
        return entry;
      }).join('\n\n');
      return { content: [{ type: "text" as const, text: `ACTIVE DECISIONS (${decisions.length}):\n\n${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_request_upgrade",
  "Request an upgrade or fix to Prime's capabilities. Describe what's broken or missing. Queued for implementation by the development session. Use when you discover a gap, bug, or missing feature.",
  {
    description: z.string().describe("What needs to be built or fixed"),
    category: z.enum(["bug", "search", "intelligence", "connector", "mcp-tool", "prompt", "performance"]).describe("Type of upgrade"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
    context: z.string().optional().describe("Why this matters"),
  },
  async ({ description, category, priority, context }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      await httpPost(`${srv}/api/remember`, {
        text: `UPGRADE REQUEST [${category}] [${priority}]: ${description}${context ? '\nContext: ' + context : ''}`,
        importance: priority === 'critical' ? 'critical' : 'high',
      }, 30000);
      return { content: [{ type: "text" as const, text: `Upgrade queued: [${category}/${priority}] ${description.slice(0, 80)}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_deep_context",
  "Get comprehensive context on any topic, person, or project. Does multi-hop retrieval internally — searches, retrieves source content, finds related entities, checks threads and commitments, and assembles a structured brief. Use this instead of multiple prime_search + prime_retrieve calls when you need deep understanding of a topic.",
  {
    topic: z.string().describe("The topic, person name, or project to get deep context on"),
    project: z.string().optional().describe("Filter to a specific project"),
    entity: z.string().optional().describe("Specific entity name to focus on"),
  },
  async ({ topic, project, entity }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/deep-context`, { topic, project, entity }, 120000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
      }

      // Format the structured response for Claude
      const sections: string[] = [];

      // Brief
      if (result.brief) {
        sections.push(result.brief);
      }

      // Entities involved
      if (result.entities_involved?.length) {
        sections.push('\n--- ENTITIES ---');
        for (const e of result.entities_involved) {
          let entry = `${e.name} (${e.type})`;
          if (e.role) entry += ` — ${e.role}`;
          if (e.email) entry += ` <${e.email}>`;
          if (e.last_activity) entry += ` | Last: ${e.last_activity}`;
          if (e.relationships?.length) {
            entry += '\n  Relationships: ' + e.relationships.map((r: any) => `${r.type} → ${r.with}`).join(', ');
          }
          sections.push(entry);
        }
      }

      // Active threads
      if (result.active_threads?.length) {
        sections.push('\n--- ACTIVE THREADS ---');
        for (const t of result.active_threads) {
          let entry = `${t.title}`;
          if (t.state) entry += ` [${t.state}]`;
          if (t.project) entry += ` | Project: ${t.project}`;
          if (t.next_action) entry += `\n  Next: ${t.next_action}`;
          if (t.latest_date) entry += ` | Latest: ${t.latest_date}`;
          sections.push(entry);
        }
      }

      // Commitments
      if (result.commitments?.length) {
        sections.push('\n--- COMMITMENTS ---');
        for (const c of result.commitments) {
          let entry = `[${c.state}] ${c.text}`;
          if (c.due) entry += ` (due ${c.due})`;
          if (c.owner) entry += ` — ${c.owner}`;
          sections.push(entry);
        }
      }

      // Key documents with raw content
      if (result.key_documents?.length) {
        sections.push('\n--- KEY DOCUMENTS ---');
        for (const d of result.key_documents) {
          let entry = `[${d.source}] ${d.title} (${d.source_date || 'undated'})`;
          if (d.source_ref) entry += `\n  Ref: ${d.source_ref}`;
          if (d.raw_content_preview) {
            entry += `\n  Content:\n${d.raw_content_preview.slice(0, 2000)}`;
          } else {
            entry += `\n  Summary: ${d.summary}`;
          }
          sections.push(entry);
        }
      }

      // Cross-references
      if (result.cross_references?.length) {
        sections.push('\n--- CROSS-REFERENCES ---');
        for (const cr of result.cross_references) {
          sections.push(`[${cr.source}] ${cr.title} (${cr.source_date || 'undated'}): ${cr.summary}`);
        }
      }

      // Timeline
      if (result.timeline?.length) {
        sections.push('\n--- TIMELINE ---');
        for (const t of result.timeline) {
          sections.push(`${t.date} | [${t.source}] ${t.event}`);
        }
      }

      // Open questions
      if (result.open_questions?.length) {
        sections.push('\n--- OPEN QUESTIONS ---');
        for (const q of result.open_questions) {
          sections.push(`? ${q}`);
        }
      }

      sections.push(`\n[${result.sources_found} sources found, ${result.sources_used} used in detail]`);

      return { content: [{ type: "text" as const, text: sections.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_meeting_prep",
  "Get intelligence prep for an upcoming meeting. Pulls all context about attendees, recent communications, open commitments, and last meeting notes. Returns structured brief with entity profiles, interaction history, and open obligations for each attendee.",
  {
    event_title: z.string().describe("The meeting title or search term to match against calendar events"),
  },
  async ({ event_title }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/meeting-prep/${encodeURIComponent(event_title)}`, 30000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
      }

      const sections: string[] = [];
      sections.push(`# Meeting Prep: ${result.event_title}`);
      if (result.event_time) sections.push(`Time: ${result.event_time}`);
      if (result.event_summary) sections.push(`Summary: ${result.event_summary}`);

      if (result.attendees?.length) {
        sections.push('\n--- ATTENDEES ---');
        for (const a of result.attendees) {
          let entry = `\n## ${a.name}`;
          if (a.profile) {
            entry += ` [${a.profile.relationship_type || 'unknown'}]`;
            if (a.profile.email) entry += ` <${a.profile.email}>`;
            if (a.profile.status) entry += ` | Status: ${a.profile.status}`;
            if (a.profile.days_since != null) entry += ` | ${a.profile.days_since}d since last contact`;
            if (a.profile.projects?.length) entry += `\nProjects: ${a.profile.projects.join(', ')}`;
          } else {
            entry += ' (no entity profile)';
          }

          if (a.recent_items?.length) {
            entry += '\nRecent interactions:';
            for (const item of a.recent_items) {
              entry += `\n  ${item.date} [${item.source}] ${item.title}`;
              if (item.summary) entry += `\n    ${item.summary}`;
            }
          }

          if (a.commitments?.length) {
            entry += '\nOpen commitments:';
            for (const c of a.commitments) {
              entry += `\n  [${c.state}] ${c.text}${c.due_date ? ` (due ${c.due_date})` : ''}`;
            }
          }

          if (a.last_meeting_notes) {
            entry += `\nLast meeting: ${a.last_meeting_notes.date} — ${a.last_meeting_notes.title}`;
            if (a.last_meeting_notes.summary) entry += `\n  ${a.last_meeting_notes.summary}`;
          }

          sections.push(entry);
        }
      }

      if (result.related_knowledge?.length) {
        sections.push('\n--- RELATED CONTEXT ---');
        for (const k of result.related_knowledge) {
          sections.push(`${k.date} [${k.source}] ${k.title}: ${k.summary}`);
        }
      }

      return { content: [{ type: "text" as const, text: sections.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_simulate",
  "Practice a conversation with a simulated counterparty. Prime builds their persona from entity intelligence — their motivations, constraints, communication style, and likely responses. Use this before important calls or negotiations. Multi-turn: omit scenario on follow-ups, just send message to continue. Set reset=true to start a fresh simulation.",
  {
    entity: z.string().describe("Name of the person to simulate (e.g. 'Costas Manganiotis')"),
    scenario: z.string().describe("The scenario to simulate (e.g. 'Propose milestone-based equity structure')"),
    message: z.string().optional().describe("Your message to the simulated person. For follow-up turns, just send the message."),
    reset: z.boolean().optional().describe("Set true to reset and start a fresh simulation with this entity"),
  },
  async ({ entity, scenario, message, reset }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/simulate`, { entity, scenario, message, reset }, 180000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
      }

      const sections: string[] = [];
      sections.push(`# Simulation: ${result.entity} (Turn ${result.turn})`);
      sections.push(`Scenario: ${result.scenario}`);
      sections.push(`Session: ${result.session_id?.slice(0, 8)}...`);
      sections.push('');
      sections.push('---');
      sections.push('');
      sections.push(`**${result.entity}:**`);
      sections.push(result.response);
      sections.push('');
      sections.push('---');
      sections.push('*Send another message to continue the conversation. Set reset=true to start over.*');

      return { content: [{ type: "text" as const, text: sections.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_shadow_board",
  "Run a decision through Prime's Shadow Board — four AI advisors (CFO, Risk Officer, Strategist, Relationship Manager) evaluate it simultaneously from different perspectives. Use before any significant decision.",
  {
    decision: z.string().describe("The decision to evaluate"),
    context: z.string().optional().describe("Additional context about the decision"),
  },
  async ({ decision, context }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/shadow-board`, { decision, context }, 300000); // 5 min — runs 5 LLM calls
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_ripple",
  "Trace the cascading implications of an event across ALL projects. Use when something significant happens — a deal closes, a person responds, a deadline changes, a relationship shifts. Shows first, second, and third order effects.",
  { event: z.string().describe("Description of the significant event that occurred") },
  async ({ event }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpPost(`${srv}/api/ripple`, { event }, 300000);
      if (result.error) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };

      const sections: string[] = [];
      sections.push(`# Ripple Analysis: ${result.event}\n`);

      if (result.ripples?.length) {
        sections.push('## Affected Projects\n');
        for (const r of result.ripples) {
          sections.push(`### ${r.project} [${r.new_status}]`);
          sections.push(`Impact: ${r.impact}`);
          sections.push(`Immediate action: ${r.immediate_action}`);
          sections.push(`Downstream: ${r.downstream}\n`);
        }
      } else {
        sections.push('No projects affected.\n');
      }

      if (result.cascading_actions?.length) {
        sections.push('## Cascading Actions\n');
        for (const a of result.cascading_actions) {
          sections.push(`[${a.priority}] (${a.type}) ${a.title}${a.target ? ` → ${a.target}` : ''}`);
          sections.push(`   Why: ${a.rationale}`);
        }
      }

      return { content: [{ type: "text" as const, text: sections.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Ripple analysis failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_entity",
  "Get the complete living profile for any person — their motivations, communication patterns, relationship health, active commitments, and predicted next move. Updated in real-time from all sources. Returns theory of mind, communication trend, risk signals, and tone analysis. Supports partial name matching.",
  {
    name: z.string().describe("Person's name (full or partial — e.g. 'Costas' will match 'Costas Manganiotis')"),
  },
  async ({ name }) => {
    const srv = await getServer();
    if (!srv) return { content: [{ type: "text" as const, text: 'Prime server unreachable.' }] };
    try {
      const result = await httpGet(`${srv}/api/entity/${encodeURIComponent(name)}`, 30000);
      if (result.error) {
        return { content: [{ type: "text" as const, text: `Entity not found: "${name}". Try a different name or partial match.` }] };
      }

      const sections: string[] = [];
      sections.push(`# ${result.name}`);
      sections.push(`Role: ${result.role}`);
      if (result.email) sections.push(`Email: ${result.email}`);
      sections.push(`Relationship Health: ${result.relationship_health}/100`);
      sections.push(`Communication Trend: ${result.communication_trend} (${result.trend_detail})`);
      sections.push(`Last Interaction: ${result.last_interaction || 'unknown'}${result.days_since_contact !== null ? ` (${result.days_since_contact} days ago)` : ''}`);

      if (result.profile) {
        sections.push(`\n## Profile`);
        sections.push(`  Nature: ${result.profile.communication_nature}`);
        sections.push(`  Reply Expectation: ${result.profile.reply_expectation}`);
        sections.push(`  Business Importance: ${result.profile.importance_to_business}`);
        if (result.profile.importance_evidence) sections.push(`  Evidence: ${result.profile.importance_evidence}`);
      }

      if (result.theory_of_mind) {
        const tom = result.theory_of_mind;
        sections.push(`\n## Theory of Mind`);
        if (tom.knows?.length) sections.push(`  Knows: ${tom.knows.join('; ')}`);
        if (tom.wants?.length) sections.push(`  Wants: ${tom.wants.join('; ')}`);
        if (tom.constraints?.length) sections.push(`  Constraints: ${tom.constraints.join('; ')}`);
        if (tom.behavior_hypothesis) sections.push(`  Behavior: ${tom.behavior_hypothesis}`);
        if (tom.likely_next_move) sections.push(`  Likely Next Move: ${tom.likely_next_move}`);
      }

      if (result.active_commitments?.length) {
        sections.push(`\n## Active Commitments (${result.active_commitments.length})`);
        for (const c of result.active_commitments) {
          sections.push(`  - [${c.state}] ${c.text}${c.due_date ? ` (due: ${c.due_date})` : ''}`);
        }
      }

      if (result.recent_communications?.length) {
        sections.push(`\n## Recent Communications (${result.recent_communications.length})`);
        for (const c of result.recent_communications) {
          sections.push(`  - ${c.date?.slice(0, 10) || '?'} [${c.source}] ${c.title}`);
          if (c.summary) sections.push(`    ${c.summary.slice(0, 200)}`);
        }
      }

      if (result.projects?.length) sections.push(`\nProjects: ${result.projects.join(', ')}`);
      if (result.tone?.length) sections.push(`Tone: ${result.tone.join(', ')}`);

      if (result.risk_signals?.length) {
        sections.push(`\n## Risk Signals`);
        for (const r of result.risk_signals) sections.push(`  - ${r}`);
      }

      return { content: [{ type: "text" as const, text: sections.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
    }
  }
);

async function main() {
  // Check server connectivity at startup
  const srv = await getServer();
  if (srv) {
    console.error(`[MCP Proxy] Connected to ${srv}`);
  } else {
    console.error('[MCP Proxy] WARNING: Mac Mini unreachable. Tools will fail until server is available.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
