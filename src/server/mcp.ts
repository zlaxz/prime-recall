#!/usr/bin/env node

/**
 * Prime Recall MCP Server
 *
 * Uses the official @modelcontextprotocol/sdk for Claude Desktop compatibility.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { v4 as uuid } from 'uuid';

const server = new McpServer({
  name: "prime-recall",
  version: "0.1.0",
});

server.tool(
  "prime_search",
  "Search the user's business knowledge base — emails, meetings, contacts, commitments, relationships.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().default(10).describe("Max results"),
    source: z.string().optional().describe("Filter: gmail, calendar, otter, claude, file, manual"),
    project: z.string().optional().describe("Filter by project name"),
  },
  async ({ query, limit, source, project }) => {
    const db = await getDb();
    const apiKey = getConfig(db, 'openai_api_key');
    let results: any[];
    if (apiKey) {
      try {
        const queryEmb = await generateEmbedding(query, apiKey);
        results = searchByEmbedding(db, queryEmb, limit || 10, 0.3);
      } catch {
        results = searchByText(db, query, limit || 10);
      }
    } else {
      results = searchByText(db, query, limit || 10);
    }
    if (source) results = results.filter(r => r.source === source);
    if (project) results = results.filter(r => r.project?.toLowerCase().includes(project.toLowerCase()));

    const text = results.length === 0
      ? `No results found for "${query}"`
      : results.map((r, i) => {
          const sim = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : '';
          const contacts = Array.isArray(r.contacts) ? r.contacts : JSON.parse(r.contacts || '[]');
          const commitments = Array.isArray(r.commitments) ? r.commitments : JSON.parse(r.commitments || '[]');
          let entry = `[${i + 1}] ${r.title}${sim}\n   ${r.summary}\n   Source: ${r.source}`;
          if (contacts.length) entry += `\n   Contacts: ${contacts.join(', ')}`;
          if (commitments.length) entry += `\n   Commitments: ${commitments.join('; ')}`;
          return entry;
        }).join('\n\n');
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_ask",
  "Ask a question about the user's business. AI answer grounded in knowledge base with cited sources.",
  { question: z.string().describe("Question about the user's business") },
  async ({ question }) => {
    const db = await getDb();
    const { answer, sources } = await askWithSources(db, question);
    const sourceList = sources.slice(0, 8).map(s => `[${s.num}] ${s.title} (${s.source})`).join('\n');
    return { content: [{ type: "text" as const, text: `${answer}\n\nSources:\n${sourceList}` }] };
  }
);

server.tool(
  "prime_remember",
  "Save knowledge — a decision, commitment, fact, or insight. Automatically extracts contacts and tags.",
  {
    content: z.string().describe("What to remember"),
    project: z.string().optional().describe("Project to associate with"),
    importance: z.enum(["low", "normal", "high", "critical"]).optional().describe("Importance level"),
  },
  async ({ content, project, importance }) => {
    const db = await getDb();
    const apiKey = getConfig(db, 'openai_api_key');
    if (!apiKey) return { content: [{ type: "text" as const, text: "No API key. Run: recall init" }] };
    const extracted = await extractIntelligence(content, apiKey);
    const embText = `${extracted.title}\n${extracted.summary}\n${content}`;
    const embedding = await generateEmbedding(embText, apiKey);
    const item: KnowledgeItem = {
      id: uuid(), title: extracted.title, summary: extracted.summary,
      source: 'mcp', source_ref: `mcp:${Date.now()}`,
      source_date: new Date().toISOString(),
      contacts: extracted.contacts, organizations: extracted.organizations,
      decisions: extracted.decisions, commitments: extracted.commitments,
      action_items: extracted.action_items, tags: extracted.tags,
      project: project || extracted.project,
      importance: importance || extracted.importance, embedding,
    };
    insertKnowledge(db, item);
    return { content: [{ type: "text" as const, text: `✓ Remembered: ${item.title}` }] };
  }
);

server.tool("prime_get_contacts", "List all known contacts sorted by mention frequency.", {}, async () => {
  const db = await getDb();
  const all = searchByText(db, '', 1000);
  const contacts = new Map<string, number>();
  for (const item of all) {
    const c = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    for (const name of c) contacts.set(name, (contacts.get(name) || 0) + 1);
  }
  const text = Array.from(contacts.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join('\n');
  return { content: [{ type: "text" as const, text: text || "No contacts found." }] };
});

server.tool("prime_get_commitments", "List all outstanding commitments and promises.", {}, async () => {
  const db = await getDb();
  const all = searchByText(db, '', 1000);
  const commitments: string[] = [];
  for (const item of all) {
    const c = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
    for (const t of c) commitments.push(`• ${t} (${item.source})`);
  }
  return { content: [{ type: "text" as const, text: commitments.length ? commitments.join('\n') : "No commitments tracked." }] };
});

server.tool("prime_get_projects", "List projects identified in the knowledge base.", {}, async () => {
  const db = await getDb();
  const all = searchByText(db, '', 1000);
  const projects = new Map<string, number>();
  for (const item of all) { if (item.project) projects.set(item.project, (projects.get(item.project) || 0) + 1); }
  const text = Array.from(projects.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c} items)`).join('\n');
  return { content: [{ type: "text" as const, text: text || "No projects detected." }] };
});

server.tool("prime_status", "Knowledge base statistics.", {}, async () => {
  const db = await getDb();
  const stats = getStats(db);
  let text = `Prime Recall: ${stats.total_items} knowledge items\n`;
  for (const s of stats.by_source) text += `  ${s.source}: ${s.count}\n`;
  return { content: [{ type: "text" as const, text }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
