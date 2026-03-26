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

  const db = await getDb();

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
        const existing = contacts.get(name) || { name, count: 0, sources: [] };
        existing.count++;
        if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
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
