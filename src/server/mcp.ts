#!/usr/bin/env node

/**
 * Prime Recall MCP Server
 *
 * Uses the official @modelcontextprotocol/sdk for Claude Desktop compatibility.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, getConnectionStats, getCommitments, getCommitmentStats, type KnowledgeItem } from '../db.js';
import { getContactGraph, getConnections } from '../ai/connections.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { generateBriefing } from '../ai/briefing.js';
import { v4 as uuid } from 'uuid';

const server = new McpServer({
  name: "prime-recall",
  version: "0.1.0",
  description: "Prime Recall is the user's unified business knowledge base. It contains indexed data from Gmail emails, Google Calendar events, Claude.ai conversations (across ALL projects and organizations), meeting notes, and manual entries. IMPORTANT: Always search Prime Recall BEFORE answering questions about the user's business, contacts, deals, projects, relationships, commitments, or prior conversations. The user's real context lives here, not in your training data.",
});

server.tool(
  "prime_search",
  "ALWAYS USE THIS FIRST when the user asks about their business, contacts, deals, projects, emails, meetings, or prior work. Searches across all sources: Gmail threads, Claude.ai conversations (all projects/orgs), calendar events, meeting notes, and manual entries. Use this before relying on conversation context alone.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().default(10).describe("Max results"),
    source: z.string().optional().describe("Filter: gmail, calendar, otter, claude, file, manual"),
    project: z.string().optional().describe("Filter by project name"),
  },
  async ({ query, limit, source, project }) => {
    const db = getDb();
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

    const now = new Date();
    const text = results.length === 0
      ? `No results found for "${query}"`
      : results.map((r, i) => {
          const sim = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : '';
          const contacts = Array.isArray(r.contacts) ? r.contacts : JSON.parse(r.contacts || '[]');
          const commitments = Array.isArray(r.commitments) ? r.commitments : JSON.parse(r.commitments || '[]');

          // Date and staleness
          let dateInfo = '';
          if (r.source_date) {
            const date = new Date(r.source_date);
            const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86400000);
            dateInfo = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (daysAgo > 30) dateInfo += ` ⚠ STALE (${daysAgo}d old)`;
            else if (daysAgo > 0) dateInfo += ` (${daysAgo}d ago)`;
          }

          let entry = `[${i + 1}] ${r.title}${sim}`;
          entry += `\n   ${r.summary}`;
          entry += `\n   Source: ${r.source} | Date: ${dateInfo || 'unknown'}${r.project ? ` | Project: ${r.project}` : ''}`;
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
    const db = getDb();
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
    const db = getDb();
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
  const db = getDb();
  const all = searchByText(db, '', 1000);
  const contacts = new Map<string, number>();
  for (const item of all) {
    const c = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    for (const name of c) contacts.set(name, (contacts.get(name) || 0) + 1);
  }
  const text = Array.from(contacts.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join('\n');
  return { content: [{ type: "text" as const, text: text || "No contacts found." }] };
});

server.tool(
  "prime_get_commitments",
  "List all commitments and promises with state tracking (overdue, active, fulfilled, dropped).",
  {
    state: z.string().optional().describe("Filter by state: detected, active, fulfilled, overdue, dropped"),
    project: z.string().optional().describe("Filter by project name"),
    overdue_only: z.boolean().optional().describe("Show only overdue commitments"),
  },
  async ({ state, project, overdue_only }) => {
    const db = getDb();
    const stats = getCommitmentStats(db);

    // If no commitments in the table, fall back to knowledge item scan
    if (stats.total === 0) {
      const all = searchByText(db, '', 1000);
      const commitments: string[] = [];
      for (const item of all) {
        const c = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
        for (const t of c) commitments.push(`- ${t} (${item.source}${item.project ? ', ' + item.project : ''})`);
      }
      return { content: [{ type: "text" as const, text: commitments.length ? `Commitments (from knowledge items, run 'recall refine' to enable state tracking):\n${commitments.join('\n')}` : "No commitments tracked." }] };
    }

    const commitments = overdue_only
      ? getCommitments(db, { overdue: true })
      : getCommitments(db, { state, project });

    if (commitments.length === 0) {
      return { content: [{ type: "text" as const, text: "No commitments match the filter." }] };
    }

    const now = new Date();
    const lines = commitments.map((c: any) => {
      let line = `[${(c.state as string).toUpperCase()}] ${c.text}`;
      if (c.due_date) {
        const dueDate = new Date(c.due_date);
        const diffDays = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
        const dateStr = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (c.state === 'overdue') {
          line += ` -- ${diffDays} days overdue (due ${dateStr})`;
        } else {
          line += ` (due ${dateStr})`;
        }
      }
      const parts: string[] = [];
      if (c.project) parts.push(`Project: ${c.project}`);
      if (c.owner) parts.push(`Owner: ${c.owner}`);
      if (c.assigned_to) parts.push(`Assigned: ${c.assigned_to}`);
      if (c.context) parts.push(c.context);
      if (parts.length > 0) line += `\n  ${parts.join(' | ')}`;
      return line;
    });

    const header = `Commitments: ${stats.total} total (${stats.overdueCount} overdue)\n`;
    const stateBreakdown = Object.entries(stats.byState).map(([s, n]) => `${s}: ${n}`).join(', ');

    return { content: [{ type: "text" as const, text: `${header}States: ${stateBreakdown}\n\n${lines.join('\n\n')}` }] };
  }
);

server.tool("prime_get_projects", "List projects identified in the knowledge base.", {}, async () => {
  const db = getDb();
  const all = searchByText(db, '', 1000);
  const projects = new Map<string, number>();
  for (const item of all) { if (item.project) projects.set(item.project, (projects.get(item.project) || 0) + 1); }
  const text = Array.from(projects.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c} items)`).join('\n');
  return { content: [{ type: "text" as const, text: text || "No projects detected." }] };
});

server.tool("prime_status", "Knowledge base statistics.", {}, async () => {
  const db = getDb();
  const stats = getStats(db);
  let text = `Prime Recall: ${stats.total_items} knowledge items\n`;
  for (const s of stats.by_source) text += `  ${s.source}: ${s.count}\n`;
  return { content: [{ type: "text" as const, text }] };
});

server.tool(
  "prime_get_connections",
  "Get connections graph for a contact or knowledge item. Shows how people, topics, and projects are linked.",
  {
    query: z.string().describe("Contact name or topic to find connections for"),
    depth: z.number().optional().default(2).describe("Graph traversal depth (1=direct only, 2=connections of connections)"),
  },
  async ({ query, depth }) => {
    const db = getDb();

    // First try to find as a contact
    const allItems = searchByText(db, '', 1000);
    const contactCounts = new Map<string, number>();
    for (const item of allItems) {
      const contacts = Array.isArray(item.contacts) ? item.contacts : (() => { try { return JSON.parse(item.contacts || '[]'); } catch { return []; } })();
      for (const name of contacts) {
        contactCounts.set(name, (contactCounts.get(name) || 0) + 1);
      }
    }

    const queryLower = query.toLowerCase().trim();
    const matchedContact = Array.from(contactCounts.keys()).find(
      c => c.toLowerCase().includes(queryLower)
    );

    if (matchedContact) {
      const graph = getContactGraph(db, matchedContact);
      let text = `Connections for "${matchedContact}":\n\n`;

      if (graph.directItems.length > 0) {
        text += `Direct (${graph.directItems.length} items):\n`;
        for (const item of graph.directItems.slice(0, 15)) {
          const dateStr = item.source_date
            ? new Date(item.source_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
          text += `  ${item.title} (${item.source}${dateStr ? ', ' + dateStr : ''})\n`;
        }
        if (graph.directItems.length > 15) {
          text += `  ... and ${graph.directItems.length - 15} more\n`;
        }
      }

      if (graph.connectedItems.length > 0) {
        text += `\nConnected (${graph.connectedItems.length} items):\n`;
        for (const item of graph.connectedItems.slice(0, 10)) {
          const via = item._via || 'connection';
          text += `  → ${item.title} (${via})\n`;
        }
        if (graph.connectedItems.length > 10) {
          text += `  ... and ${graph.connectedItems.length - 10} more\n`;
        }
      }

      if (graph.projects.length > 0) {
        text += `\nProjects: ${graph.projects.join(', ')}\n`;
      }
      if (graph.relationships.length > 0) {
        text += `Relationships: ${graph.relationships.map(r => `${r.type} (${r.count})`).join(', ')}\n`;
      }

      return { content: [{ type: "text" as const, text }] };
    } else {
      // Item mode — search for best match and show connections
      const results = searchByText(db, query, 1);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results found for "${query}"` }] };
      }

      const item = results[0];
      const connections = getConnections(db, item.id, depth);

      let text = `Connections for "${item.title}":\n\n`;

      if (connections.length === 0) {
        text += 'No connections found. Run: recall refine  to build connections.\n';
        return { content: [{ type: "text" as const, text }] };
      }

      // Group by depth
      const byDepth = new Map<number, typeof connections>();
      for (const conn of connections) {
        const group = byDepth.get(conn.depth) || [];
        group.push(conn);
        byDepth.set(conn.depth, group);
      }

      for (const [d, conns] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
        const label = d === 1 ? 'Direct connections' : `${d}-hop connections`;
        text += `${label} (${conns.length}):\n`;
        for (const conn of conns.slice(0, 10)) {
          const conf = conn.confidence < 1 ? ` [${(conn.confidence * 100).toFixed(0)}%]` : '';
          text += `  [${conn.relationship}${conf}] ${conn.item.title}\n`;
        }
        if (conns.length > 10) {
          text += `  ... and ${conns.length - 10} more\n`;
        }
      }

      // Relationship summary
      const relCounts = new Map<string, number>();
      for (const conn of connections) {
        relCounts.set(conn.relationship, (relCounts.get(conn.relationship) || 0) + 1);
      }
      text += `\nRelationships: ${Array.from(relCounts.entries()).map(([r, c]) => `${r} (${c})`).join(', ')}\n`;

      return { content: [{ type: "text" as const, text }] };
    }
  }
);

server.tool(
  "prime_briefing",
  "Generate a daily intelligence briefing — priorities, commitments, dropped balls, relationship health.",
  { days: z.number().optional().default(7).describe("Days to look back") },
  async ({ days }) => {
    const db = getDb();
    try {
      const result = await generateBriefing(db, { days, save: true });
      const meta = [
        `Items analyzed: ${result.meta.itemsAnalyzed}`,
        `Dropped balls: ${result.meta.droppedBalls}`,
        `Cold relationships: ${result.meta.coldRelationships}`,
        `Active commitments: ${result.meta.activeCommitments}`,
        `Calendar events: ${result.meta.calendarEvents}`,
      ].join(' | ');
      return { content: [{ type: "text" as const, text: `${result.briefing}\n\n---\n${meta}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error generating briefing: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_alerts",
  "URGENT: Get all current alerts — dropped balls (people waiting on user), overdue commitments, approaching deadlines, cold relationships. Call this proactively when the user asks about priorities or what needs attention.",
  {},
  async () => {
    const db = getDb();
    const { getAlerts } = await import('../ai/intelligence.js');
    const alerts = getAlerts(db);

    if (alerts.length === 0) {
      return { content: [{ type: "text" as const, text: "✓ All clear. No urgent alerts." }] };
    }

    const icons: Record<string, string> = {
      dropped_ball: '🔴', overdue_commitment: '🟠',
      deadline_approaching: '🟡', cold_relationship: '🔵',
    };

    const text = alerts.map(a => {
      const icon = icons[a.type] || '⚪';
      const sev = a.severity === 'critical' ? ' [CRITICAL]' : a.severity === 'high' ? ' [HIGH]' : '';
      return `${icon}${sev} ${a.title}\n   ${a.detail}${a.project ? ` | ${a.project}` : ''}`;
    }).join('\n\n');

    return { content: [{ type: "text" as const, text: `⚠️ ${alerts.length} ALERTS:\n\n${text}` }] };
  }
);

server.tool(
  "prime_prep",
  "Generate an intelligence dossier on a person, deal, topic, or upcoming meeting. Pulls everything from all sources: emails, Claude conversations, meetings, commitments. USE THIS before meetings or when the user asks about a specific person or topic.",
  { query: z.string().describe("Person name, topic, deal name, or meeting subject") },
  async ({ query }) => {
    const db = getDb();
    const { generatePrep } = await import('../ai/intelligence.js');
    try {
      const result = await generatePrep(db, query);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error generating prep: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_catchup",
  "What happened while the user was away. Generates a narrative catch-up briefing. Use when the user says 'catch me up', 'what did I miss', or 'what happened'.",
  { days: z.number().optional().default(3).describe("Days to catch up on") },
  async ({ days }) => {
    const db = getDb();
    const { generateCatchup } = await import('../ai/intelligence.js');
    try {
      const result = await generateCatchup(db, { days });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error generating catchup: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_relationships",
  "Relationship health dashboard. Shows all contacts with their status (active/warm/cooling/cold/dormant), last interaction date, and mention frequency. Use when the user asks about contacts, relationships, or who to follow up with.",
  { cold_only: z.boolean().optional().describe("Show only cold/dormant contacts") },
  async ({ cold_only }) => {
    const db = getDb();
    const { getRelationshipHealth } = await import('../ai/intelligence.js');
    let contacts = getRelationshipHealth(db);

    if (cold_only) contacts = contacts.filter(c => c.status === 'cold' || c.status === 'dormant');

    const icons: Record<string, string> = { active: '🟢', warm: '🟡', cooling: '🟠', cold: '🔴', dormant: '⚫' };
    const text = contacts.slice(0, 30).map(c => {
      const proj = c.projects.length ? ` | ${c.projects.join(', ')}` : '';
      return `${icons[c.status]} ${c.name} — ${c.daysSince}d ago (${c.mentions} mentions, ${c.sources.join('+')}${proj})`;
    }).join('\n');

    return { content: [{ type: "text" as const, text: text || "No contacts tracked." }] };
  }
);

server.tool(
  "prime_deal",
  "Comprehensive deal/project intelligence dossier. Pulls all knowledge items, people, decisions, commitments, and timeline for a specific project or deal. Use when the user asks about a deal, project status, or needs to prepare for a strategic discussion.",
  { project: z.string().describe("Project or deal name to analyze") },
  async ({ project }) => {
    const db = getDb();
    const { generateDealBrief } = await import('../ai/intelligence.js');
    try {
      const result = await generateDealBrief(db, project);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error generating deal brief: ${err.message}` }] };
    }
  }
);

server.tool(
  "prime_notify",
  "Send a notification to the user. Routes by urgency: CRITICAL → iMessage + email, HIGH → iMessage, NORMAL → email, FYI → save only. Use when an agent has something important to communicate.",
  {
    title: z.string().describe("Short notification title"),
    body: z.string().describe("Notification body — what happened and why it matters"),
    urgency: z.enum(["critical", "high", "normal", "fyi"]).describe("Notification urgency"),
    agent: z.string().optional().describe("Which agent is sending (e.g., 'carefront-pm')"),
    project: z.string().optional().describe("Related project"),
    action_required: z.string().optional().describe("What the user needs to do"),
  },
  async ({ title, body, urgency, agent, project, action_required }) => {
    const db = getDb();
    const { notify } = await import('../notify.js');
    const result = await notify(db, {
      title, body, urgency: urgency as any,
      agent, project, actionRequired: action_required,
    });
    const text = result.channels.length > 0
      ? `✓ Notified via: ${result.channels.join(', ')}${result.errors.length ? ` (errors: ${result.errors.join('; ')})` : ''}`
      : `⚠ No channels available. ${result.errors.join('; ')}`;
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_spawn_agent",
  "Spawn an agent to work on a task in the background. The agent has full access to Prime Recall and will save its report when done. Use for research, drafting, analysis, or any work the user delegates.",
  {
    task: z.string().describe("What the agent should do — be specific"),
    agent: z.string().optional().describe("Agent type: 'cos', 'follow-up', or custom name (default: 'research')"),
    project: z.string().optional().describe("Project context"),
    urgency: z.enum(["critical", "high", "normal", "fyi"]).optional().describe("Task urgency"),
  },
  async ({ task, agent, project, urgency }) => {
    const db = getDb();
    const { spawnAgent } = await import('../agents.js');
    const result = await spawnAgent(db, {
      task, agent, project, urgency: urgency as any, background: true,
    });
    if (result.status === 'spawned') {
      return { content: [{ type: "text" as const, text: `✓ Agent "${agent || 'research'}" spawned.\nTask: ${task}\nID: ${result.taskId}\n\nThe agent will save its report to Prime Recall when done. Ask me "what did the agent find?" to check.` }] };
    } else {
      return { content: [{ type: "text" as const, text: `✗ Failed to spawn agent: ${result.result}` }] };
    }
  }
);

server.tool(
  "prime_agent_activity",
  "Show recent agent activity — reports, notifications, and pending tasks. Use when the user asks 'what did my agents do?' or 'any updates?'",
  {
    agent: z.string().optional().describe("Filter by specific agent name"),
    limit: z.number().optional().default(10).describe("Number of items to show"),
  },
  async ({ agent, limit }) => {
    const db = getDb();
    const { getAgentActivity } = await import('../agents.js');
    const activity = getAgentActivity(db, { agent, limit });

    if (activity.length === 0) {
      return { content: [{ type: "text" as const, text: "No recent agent activity." }] };
    }

    const text = activity.map(a => {
      const tags = a.tags || [];
      const meta = a.metadata || {};
      const age = a.source_date ? `${Math.floor((Date.now() - new Date(a.source_date).getTime()) / 3600000)}h ago` : '';
      const agentName = meta.agent || tags.find((t: string) => t.startsWith('agent:'))?.replace('agent:', '') || '?';
      return `[${agentName}] ${a.title} (${age})\n  ${a.summary?.slice(0, 200)}`;
    }).join('\n\n');

    return { content: [{ type: "text" as const, text }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
