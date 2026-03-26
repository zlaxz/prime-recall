import express from 'express';
import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { v4 as uuid } from 'uuid';
import { processOtterMeeting } from '../connectors/otter.js';
import { startScheduler } from '../scheduler.js';

export async function startServer(port: number = 3210, options: { sync?: boolean; syncInterval?: number } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS for any client
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  const db = getDb();

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Status
  app.get('/api/status', (_req, res) => {
    const stats = getStats(db);
    res.json(stats);
  });

  // Search
  app.post('/api/search', async (req, res) => {
    try {
      const { query, limit = 10, filters = {} } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });

      const apiKey = getConfig(db, 'openai_api_key');
      let results: any[];

      if (apiKey) {
        try {
          const queryEmb = await generateEmbedding(query, apiKey);
          results = searchByEmbedding(db, queryEmb, limit, 0.3);
        } catch {
          results = searchByText(db, query, limit);
        }
      } else {
        results = searchByText(db, query, limit);
      }

      // Apply filters
      if (filters.source) results = results.filter(r => r.source === filters.source);
      if (filters.project) results = results.filter(r => r.project?.toLowerCase().includes(filters.project.toLowerCase()));
      if (filters.importance) results = results.filter(r => r.importance === filters.importance);

      res.json({ results, count: results.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ask (search + LLM reasoning)
  app.post('/api/ask', async (req, res) => {
    try {
      const { question, model } = req.body;
      if (!question) return res.status(400).json({ error: 'question required' });

      const result = await askWithSources(db, question, { model });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ingest
  app.post('/api/ingest', async (req, res) => {
    try {
      const { items } = req.body;
      if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

      const apiKey = getConfig(db, 'openai_api_key');
      if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

      let ingested = 0;

      for (const raw of items) {
        const content = raw.content || raw.text || '';
        const extracted = raw.title && raw.summary ? raw : await extractIntelligence(content, apiKey);

        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: raw.id || uuid(),
          title: extracted.title,
          summary: extracted.summary,
          source: raw.source || 'api',
          source_ref: raw.source_ref || `api:${Date.now()}`,
          source_date: raw.source_date,
          contacts: extracted.contacts || raw.contacts || [],
          organizations: extracted.organizations || raw.organizations || [],
          decisions: extracted.decisions || raw.decisions || [],
          commitments: extracted.commitments || raw.commitments || [],
          action_items: extracted.action_items || raw.action_items || [],
          tags: extracted.tags || raw.tags || [],
          project: raw.project || extracted.project,
          importance: raw.importance || extracted.importance || 'normal',
          embedding,
          metadata: raw.metadata,
        };

        insertKnowledge(db, item);
        ingested++;
      }

      res.json({ ingested, total: getStats(db).total_items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remember (quick capture)
  app.post('/api/remember', async (req, res) => {
    try {
      const { text, type, project } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      const apiKey = getConfig(db, 'openai_api_key');
      if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

      const extracted = await extractIntelligence(text, apiKey);
      const embText = `${extracted.title}\n${extracted.summary}\n${text}`;
      const embedding = await generateEmbedding(embText, apiKey);

      const item: KnowledgeItem = {
        id: uuid(),
        title: extracted.title,
        summary: extracted.summary,
        source: 'manual',
        source_ref: `manual:${Date.now()}`,
        source_date: new Date().toISOString(),
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: extracted.tags,
        project: project || extracted.project,
        importance: extracted.importance,
        embedding,
      };

      insertKnowledge(db, item);
      res.json({ id: item.id, title: item.title });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Webhooks
  app.post('/api/webhooks/otter', async (req, res) => {
    try {
      const result = await processOtterMeeting(db, req.body);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Query endpoints
  app.get('/api/query/contacts', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const contacts = new Map<string, { name: string; count: number; sources: string[] }>();

    for (const item of results) {
      const itemContacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
      for (const name of itemContacts) {
        const existing = contacts.get(name) || { name, count: 0, sources: [] as string[] };
        existing.count++;
        if (!existing.sources.includes(item.source as string)) existing.sources.push(item.source as string);
        contacts.set(name, existing);
      }
    }

    res.json({
      contacts: Array.from(contacts.values()).sort((a, b) => b.count - a.count),
    });
  });

  app.get('/api/query/commitments', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const commitments: any[] = [];

    for (const item of results) {
      const itemCommitments = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
      for (const c of itemCommitments) {
        commitments.push({
          text: c,
          source: item.source,
          source_ref: item.source_ref,
          date: item.source_date,
          project: item.project,
        });
      }
    }

    res.json({ commitments });
  });

  app.get('/api/query/projects', (_req, res) => {
    const results = searchByText(db, '', 1000);
    const projects = new Map<string, { name: string; items: number; importance: string }>();

    for (const item of results) {
      if (item.project) {
        const existing = projects.get(item.project) || { name: item.project, items: 0, importance: 'normal' };
        existing.items++;
        if (item.importance === 'critical' || (item.importance === 'high' && existing.importance !== 'critical')) {
          existing.importance = item.importance;
        }
        projects.set(item.project, existing);
      }
    }

    res.json({
      projects: Array.from(projects.values()).sort((a, b) => b.items - a.items),
    });
  });

  // ── Dashboard ────────────────────────────────────────────
  app.get('/dashboard', (_req, res) => {
    const stats = getStats(db);

    // Get agent reports
    const agentReports = db.prepare(
      "SELECT * FROM knowledge WHERE source = 'agent-report' ORDER BY source_date DESC LIMIT 10"
    ).all() as any[];

    // Get alerts
    const alertItems = db.prepare(
      "SELECT * FROM knowledge WHERE source = 'agent-notification' ORDER BY source_date DESC LIMIT 10"
    ).all() as any[];

    // Get team config
    const { readdirSync, readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const { homedir } = require('os');
    const agentsDir = join(homedir(), '.prime', 'agents');
    let agents: any[] = [];
    if (existsSync(agentsDir)) {
      agents = readdirSync(agentsDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => {
          try { return JSON.parse(readFileSync(join(agentsDir, f), 'utf-8')); } catch { return null; }
        })
        .filter(Boolean);
    }

    const formatAge = (dateStr: string) => {
      if (!dateStr) return 'never';
      const h = Math.floor((Date.now() - new Date(dateStr).getTime()) / 3600000);
      if (h < 1) return 'just now';
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    };

    const reportCards = agentReports.map(r => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      const fullReport = (meta.full_report || r.summary || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <div class="card">
          <div class="card-header">
            <span class="badge">${meta.agent || '?'}</span>
            <span class="age">${formatAge(r.source_date)}</span>
          </div>
          <h3>${(r.title || '').replace(/</g, '&lt;')}</h3>
          <pre class="report">${fullReport}</pre>
        </div>`;
    }).join('');

    const teamCards = agents.map((a: any) => `
      <div class="team-member">
        <span class="status ${a.enabled ? 'active' : 'disabled'}"></span>
        <strong>${a.role}</strong> (${a.name})
        <div class="meta">
          Schedule: ${a.schedule} | Last run: ${formatAge(a.last_run)} | Notify: ${a.notify}+
          ${a.project ? `<br>Project: ${a.project}` : ''}
        </div>
      </div>`).join('');

    const alertCards = alertItems.map(a => {
      const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {});
      return `
        <div class="alert-item ${meta.urgency || 'normal'}">
          <strong>${(a.title || '').replace(/</g, '&lt;')}</strong>
          <span class="age">${formatAge(a.source_date)}</span>
        </div>`;
    }).join('') || '<p class="muted">No recent notifications</p>';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Prime Recall — Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 20px; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
    .sidebar { display: flex; flex-direction: column; gap: 16px; }

    .section { margin-bottom: 24px; }
    .section h2 { font-size: 16px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }

    .stats { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; flex: 1; text-align: center; }
    .stat .number { font-size: 32px; font-weight: bold; color: #fff; }
    .stat .label { font-size: 12px; color: #888; margin-top: 4px; }

    .card { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .card h3 { font-size: 15px; margin-bottom: 8px; color: #fff; }
    .badge { background: #2a2a4a; color: #8888ff; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .age { color: #666; font-size: 12px; }
    .report { font-size: 13px; line-height: 1.5; color: #bbb; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }

    .team-member { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
    .team-member .meta { font-size: 12px; color: #666; margin-top: 4px; }
    .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status.active { background: #4ade80; }
    .status.disabled { background: #666; }

    .alert-item { padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 13px; display: flex; justify-content: space-between; }
    .alert-item.critical { background: #2a0a0a; border-left: 3px solid #ef4444; }
    .alert-item.high { background: #2a1a0a; border-left: 3px solid #f97316; }
    .alert-item.normal { background: #0a1a2a; border-left: 3px solid #3b82f6; }
    .muted { color: #555; font-size: 13px; }

    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Prime Recall</h1>
  <p class="subtitle">${stats.total_items} knowledge items · ${agents.length} agents · Auto-refreshes every 2 min</p>

  <div class="stats">
    <div class="stat"><div class="number">${stats.total_items}</div><div class="label">Knowledge Items</div></div>
    <div class="stat"><div class="number">${agents.length}</div><div class="label">AI Employees</div></div>
    <div class="stat"><div class="number">${agentReports.length}</div><div class="label">Recent Reports</div></div>
    <div class="stat"><div class="number">${alertItems.length}</div><div class="label">Notifications</div></div>
  </div>

  <div class="grid">
    <div class="main">
      <div class="section">
        <h2>Agent Reports</h2>
        ${reportCards || '<p class="muted">No agent reports yet. Run: recall run-agent cos</p>'}
      </div>
    </div>

    <div class="sidebar">
      <div class="section">
        <h2>Your Team</h2>
        ${teamCards || '<p class="muted">No agents hired</p>'}
      </div>

      <div class="section">
        <h2>Notifications</h2>
        ${alertCards}
      </div>

      <div class="section">
        <h2>Sources</h2>
        ${(stats.by_source || []).map((s: any) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;"><span>${s.source}</span><span style="color:#888">${s.count}</span></div>`).join('')}
      </div>
    </div>
  </div>
</body>
</html>`);
  });

  app.listen(port, () => {
    const stats = getStats(db);
    console.log(`\n⚡ Prime API server running on http://localhost:${port}`);
    console.log(`  Knowledge base: ${stats.total_items} items\n`);
    console.log('  Endpoints:');
    console.log('    POST /api/search    — Semantic search');
    console.log('    POST /api/ask       — AI conversation');
    console.log('    POST /api/ingest    — Add knowledge');
    console.log('    POST /api/remember  — Quick capture');
    console.log('    GET  /api/status    — Knowledge base stats');
    console.log('    GET  /api/query/*   — Structured queries');
    console.log('    POST /api/webhooks/otter — Otter.ai webhook\n');

    if (options.sync !== false) {
      startScheduler(options.syncInterval || 15);
    }
  });
}
