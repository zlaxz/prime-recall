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
    strategy: z.enum(["auto", "semantic", "keyword", "graph", "temporal", "hierarchical"]).optional().default("auto").describe("Search strategy"),
  },
  async ({ query, limit, source, project, strategy }) => {
    const db = getDb();
    const { search } = await import('../ai/search.js');

    const searchResult = await search(db, query, {
      limit: limit || 10,
      strategy: strategy || 'auto',
      source,
      project,
      rerank: true,
    });

    const results = searchResult.items;
    const now = new Date();

    let header = '';
    if (results.length > 0) {
      const conf = (searchResult.confidence * 100).toFixed(0);
      header = `Search: ${searchResult.strategy_used} | Confidence: ${conf}% | Recency: ${searchResult.coverage.recency} | Agreement: ${searchResult.coverage.agreement}\n\n`;
    }

    const text = results.length === 0
      ? `No results found for "${query}"`
      : header + results.map((r, i) => {
          const score = r._score != null ? ` (${(r._score * 100).toFixed(0)}%)` : (r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : '');
          const contacts = Array.isArray(r.contacts) ? r.contacts : (() => { try { return JSON.parse(r.contacts || '[]'); } catch { return []; } })();
          const commitments = Array.isArray(r.commitments) ? r.commitments : (() => { try { return JSON.parse(r.commitments || '[]'); } catch { return []; } })();

          // Date and staleness
          let dateInfo = '';
          if (r.source_date) {
            const date = new Date(r.source_date);
            const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86400000);
            dateInfo = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (daysAgo > 30) dateInfo += ` ⚠ STALE (${daysAgo}d old)`;
            else if (daysAgo > 0) dateInfo += ` (${daysAgo}d ago)`;
          }

          let entry = `[${i + 1}] ${r.title}${score}`;
          entry += `\n   ${r.summary}`;
          entry += `\n   Source: ${r.source} | Date: ${dateInfo || 'unknown'}${r.project ? ` | Project: ${r.project}` : ''}`;
          if (contacts.length) entry += `\n   Contacts: ${contacts.join(', ')}`;
          if (commitments.length) entry += `\n   Commitments: ${commitments.join('; ')}`;
          if (r._via) entry += `\n   Via: ${r._via}`;
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
  "Save knowledge — a decision, commitment, fact, insight, or agent report. For agent reports, include the FULL report text in the content field. Automatically extracts contacts and tags.",
  {
    content: z.string().describe("What to remember — include the FULL text, not a summary"),
    title: z.string().optional().describe("Title for this item (auto-generated if not provided)"),
    source: z.string().optional().describe("Source type: 'mcp', 'agent-report', 'directive', 'manual'"),
    project: z.string().optional().describe("Project to associate with"),
    importance: z.enum(["low", "normal", "high", "critical"]).optional().describe("Importance level"),
    tags: z.array(z.string()).optional().describe("Tags for this item (e.g., ['agent:cos', 'agent-report'])"),
    agent: z.string().optional().describe("Agent name if this is an agent report"),
  },
  async ({ content, title, source, project, importance, tags, agent }) => {
    const db = getDb();
    const apiKey = getConfig(db, 'openai_api_key');
    if (!apiKey) return { content: [{ type: "text" as const, text: "No API key. Run: recall init" }] };
    const extracted = await extractIntelligence(content, apiKey);
    const embText = `${title || extracted.title}\n${content.slice(0, 2000)}`;
    const embedding = await generateEmbedding(embText, apiKey);

    const isAgentReport = source === 'agent-report' || (tags && tags.some(t => t.includes('agent-report')));

    const item: KnowledgeItem = {
      id: uuid(),
      title: title || extracted.title,
      summary: isAgentReport ? content.slice(0, 2000) : extracted.summary,
      source: source || 'mcp',
      source_ref: `${source || 'mcp'}:${Date.now()}`,
      source_date: new Date().toISOString(),
      contacts: extracted.contacts, organizations: extracted.organizations,
      decisions: extracted.decisions, commitments: extracted.commitments,
      action_items: extracted.action_items,
      tags: [...(extracted.tags || []), ...(tags || [])],
      project: project || extracted.project,
      importance: importance || extracted.importance, embedding,
      metadata: {
        ...(agent ? { agent, role: agent } : {}),
        ...(isAgentReport ? { full_report: content } : {}),
      },
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

server.tool(
  "prime_get_artifact",
  "Find the LATEST version of a Claude artifact by name. Use this BEFORE creating or editing any document, design, or code artifact to ensure you have the most recent version.",
  {
    query: z.string().describe("Artifact name or topic to search for (e.g., 'Carefront brand guidelines', 'agent flyer')"),
    all_versions: z.boolean().optional().default(false).describe("Show all versions, not just latest"),
  },
  async ({ query, all_versions }) => {
    const db = getDb();

    // Search for artifacts matching the query
    const allArtifacts = db.prepare(
      `SELECT * FROM knowledge
       WHERE tags LIKE '%claude-artifact%'
       AND (title LIKE ? OR summary LIKE ? OR tags LIKE ?)
       ORDER BY source_date DESC`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`) as any[];

    if (allArtifacts.length === 0) {
      return { content: [{ type: "text" as const, text: `No artifacts found matching "${query}". This may be a new artifact — create it fresh.` }] };
    }

    // Group by base title (strip version suffix)
    const byTitle = new Map<string, any[]>();
    for (const a of allArtifacts) {
      const baseTitle = (a.title as string).replace(/\s*\(v\d+\)$/, '').replace(/^Artifact:\s*/, '');
      const group = byTitle.get(baseTitle) || [];
      group.push(a);
      byTitle.set(baseTitle, group);
    }

    let text = '';
    for (const [title, versions] of byTitle) {
      const latest = versions[0]; // Already sorted by date DESC
      const meta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata) : (latest.metadata || {});

      text += `## ${title}\n`;
      text += `Latest version: v${meta.version || 1} | ${latest.source_date} | ${meta.artifact_type || 'unknown'}\n`;
      text += `Project: ${latest.project || 'none'} | Conversation: ${meta.conversation_name || 'unknown'}\n`;
      text += `Source: ${latest.source_ref}\n`;

      if (meta.content_preview) {
        text += `\nContent:\n${meta.content_preview}\n`;
      } else {
        text += `\nSummary: ${latest.summary}\n`;
      }

      if (all_versions && versions.length > 1) {
        text += `\nVersion history (${versions.length} versions):\n`;
        for (const v of versions) {
          const vm = typeof v.metadata === 'string' ? JSON.parse(v.metadata) : (v.metadata || {});
          text += `  v${vm.version || '?'} — ${v.source_date} — ${vm.conversation_name || 'unknown'}\n`;
        }
      }
      text += '\n---\n\n';
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_entity",
  "Get the full profile of a person, project, or organization — mentions, communication patterns, projects, commitments, connected entities. Use when the user asks about a specific person or when you need context about someone.",
  { name: z.string().describe("Person name, email, project name, or organization") },
  async ({ name }) => {
    const db = getDb();
    const { getEntityProfile } = await import('../entities.js');
    const profile = getEntityProfile(db, name);
    if (!profile) return { content: [{ type: "text" as const, text: `Entity "${name}" not found.` }] };

    let text = `${profile.canonical_name} (${profile.type})\n`;
    if (profile.email) text += `Email: ${profile.email}\n`;
    if (profile.user_label) text += `Label: ${profile.user_label} (user-set)\n`;
    else if (profile.relationship_type) text += `Relationship: ${profile.relationship_type} (${(profile.relationship_confidence * 100).toFixed(0)}%)\n`;
    text += `Status: ${profile.status} (${profile.days_since}d ago)\n`;
    text += `Mentions: ${profile.mention_count} (${profile.inbound} in, ${profile.outbound} out)\n`;
    if (profile.projects.length) text += `Projects: ${profile.projects.join(', ')}\n`;
    if (profile.commitments.length) {
      text += `\nOpen commitments:\n`;
      for (const c of profile.commitments) text += `  • ${c.text} [${c.state}]\n`;
    }
    if (profile.connected.length) {
      text += `\nConnected to: ${profile.connected.map((c: any) => `${c.canonical_name}(${c.co_occurrence_count})`).join(', ')}\n`;
    }
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "prime_correct",
  "Update the entity graph when the user corrects, labels, dismisses, or merges entities. Use when the user says things like 'Forrest is my employee', 'ignore Laura Crowley', 'merge Forrest S. Pullen into Forrest Pullen'.",
  {
    action: z.enum(["label", "dismiss", "merge", "note"]).describe("What to do"),
    entity_name: z.string().describe("Entity name to update"),
    label: z.string().optional().describe("For label action: employee, partner, client, vendor, advisor, noise"),
    merge_with: z.string().optional().describe("For merge action: target entity name"),
    note: z.string().optional().describe("For note action: free-text note"),
    reason: z.string().optional().describe("For dismiss action: why"),
  },
  async ({ action, entity_name, label, merge_with, note, reason }) => {
    const db = getDb();

    if (action === 'label' && label) {
      const { labelEntity } = await import('../entities.js');
      const ok = labelEntity(db, entity_name, label);
      return { content: [{ type: "text" as const, text: ok ? `✓ ${entity_name} labeled as ${label}` : `Entity "${entity_name}" not found` }] };
    }

    if (action === 'dismiss') {
      const { dismissEntity } = await import('../entities.js');
      const ok = dismissEntity(db, entity_name, reason);
      return { content: [{ type: "text" as const, text: ok ? `✓ ${entity_name} dismissed permanently` : `Entity "${entity_name}" not found` }] };
    }

    if (action === 'merge' && merge_with) {
      const { mergeEntities } = await import('../entities.js');
      const ok = mergeEntities(db, entity_name, merge_with);
      return { content: [{ type: "text" as const, text: ok ? `✓ Merged "${entity_name}" into "${merge_with}"` : `One or both entities not found` }] };
    }

    if (action === 'note' && note) {
      const { getEntity } = await import('../entities.js');
      const entity = getEntity(db, entity_name);
      if (!entity) return { content: [{ type: "text" as const, text: `Entity "${entity_name}" not found` }] };
      db.prepare('UPDATE entities SET user_notes = ?, updated_at = datetime(\'now\') WHERE id = ?').run(note, entity.id);
      return { content: [{ type: "text" as const, text: `✓ Note saved for ${entity_name}` }] };
    }

    return { content: [{ type: "text" as const, text: `Invalid action or missing parameters` }] };
  }
);

server.tool(
  "prime_world",
  "Get the current world model — a structured, cited view of all people, projects, alerts, dismissed entities, and cross-project connections. Use this FIRST before answering any question about the user's business. Every claim in the world model cites a source ID.",
  {},
  async () => {
    const db = getDb();
    const { getWorldModelForPrompt } = await import('../ai/world.js');
    const md = getWorldModelForPrompt(db);
    return { content: [{ type: "text" as const, text: md }] };
  }
);

server.tool(
  "prime_artifact",
  "Find and retrieve artifacts (code, documents, designs) created in Claude conversations. Returns the LATEST VERSION with full content. Use when the user asks about a document, code, design, or anything they created in Claude.",
  {
    query: z.string().describe("Artifact title, identifier, or search term"),
    full_content: z.boolean().optional().default(true).describe("Return full content (default true)"),
  },
  async ({ query, full_content }) => {
    const db = getDb();
    const { getArtifact, searchArtifacts } = await import('../artifacts.js');

    const artifact = getArtifact(db, query);
    if (artifact) {
      let text = `Artifact: ${artifact.title} (v${artifact.version}, ${artifact.type})\n`;
      text += `Project: ${artifact.project || 'none'}\n`;
      text += `Conversation: ${artifact.conversation_name || 'unknown'}\n`;
      text += `Size: ${artifact.content_length} chars\n`;
      if (artifact.conversation_uuid) {
        text += `Open in browser: https://claude.ai/chat/${artifact.conversation_uuid}\n`;
      }
      if (full_content) {
        text += `\n--- Content ---\n${artifact.content}`;
      } else {
        text += `\n--- Preview ---\n${artifact.content.slice(0, 1000)}`;
      }
      return { content: [{ type: "text" as const, text }] };
    }

    // Fallback: search
    const results = searchArtifacts(db, query, 5);
    if (results.length > 0) {
      const text = `No exact match for "${query}". Found ${results.length} similar artifacts:\n\n` +
        results.map((r: any) => `- ${r.title} (v${r.version}, ${r.type}) | ${r.content_length} chars | ${r.project || 'no project'}`).join('\n');
      return { content: [{ type: "text" as const, text }] };
    }

    return { content: [{ type: "text" as const, text: `No artifacts found matching "${query}"` }] };
  }
);

server.tool(
  "prime_send_email",
  "Send an email on behalf of the user via Gmail. Use when the user approves sending a follow-up, reply, or new email. Always confirm with the user before sending. The email is logged in Prime Recall automatically.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
    reply_to_thread: z.string().optional().describe("Thread ID to reply to (from knowledge item metadata)"),
  },
  async ({ to, subject, body, cc, reply_to_thread }) => {
    const db = getDb();
    const { sendEmail } = await import('../connectors/gmail.js');
    const result = await sendEmail(db, {
      to, subject, body, cc,
      replyToThreadId: reply_to_thread,
    });

    if (result.success) {
      return { content: [{ type: "text" as const, text: `✓ Email sent to ${to}\nSubject: ${subject}\nThread: ${result.threadId || 'new'}` }] };
    } else {
      return { content: [{ type: "text" as const, text: `✗ Failed to send: ${result.error}` }] };
    }
  }
);

server.tool(
  "prime_schedule_meeting",
  "Schedule a meeting on the user's Google Calendar. Use when the user approves scheduling a call or meeting. Always confirm details before creating.",
  {
    title: z.string().describe("Meeting title"),
    start_time: z.string().describe("Start time in ISO format (e.g., 2026-03-28T14:00:00-06:00)"),
    duration_minutes: z.number().optional().default(30).describe("Duration in minutes"),
    attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
    description: z.string().optional().describe("Meeting description/agenda"),
    location: z.string().optional().describe("Location or video call link"),
  },
  async ({ title, start_time, duration_minutes, attendees, description, location }) => {
    const db = getDb();
    const tokens = getConfig(db, 'gmail_tokens'); // shared with calendar
    if (!tokens) return { content: [{ type: "text" as const, text: "Calendar not connected" }] };

    try {
      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID || '',
        process.env.GOOGLE_CLIENT_SECRET || '',
        'http://localhost:9876/callback'
      );
      oauth2Client.setCredentials(tokens);

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const startDate = new Date(start_time);
      const endDate = new Date(startDate.getTime() + (duration_minutes || 30) * 60000);

      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          description: description || '',
          location: location || '',
          start: { dateTime: startDate.toISOString() },
          end: { dateTime: endDate.toISOString() },
          attendees: attendees?.map(email => ({ email })),
        },
      });

      // Log to Prime Recall
      const { v4: uuidv4 } = await import('uuid');
      const { insertKnowledge } = await import('../db.js');
      insertKnowledge(db, {
        id: uuidv4(),
        title: `Scheduled: ${title}`,
        summary: `Meeting scheduled for ${startDate.toLocaleString()} with ${attendees?.join(', ') || 'no attendees'}`,
        source: 'calendar',
        source_ref: `event:${event.data.id}`,
        source_date: startDate.toISOString(),
        contacts: attendees || [],
        tags: ['scheduled', 'agent-action'],
        importance: 'normal',
      });

      return { content: [{ type: "text" as const, text: `✓ Meeting scheduled: ${title}\nWhen: ${startDate.toLocaleString()}\nDuration: ${duration_minutes} min\nAttendees: ${attendees?.join(', ') || 'none'}\nLink: ${event.data.htmlLink || ''}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `✗ Failed to schedule: ${err.message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
