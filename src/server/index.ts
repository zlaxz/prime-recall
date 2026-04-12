import express from 'express';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getDb, searchByText, searchByEmbedding, insertKnowledge, getStats, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';
import { askWithSources } from '../ai/ask.js';
import { v4 as uuid } from 'uuid';
import { processOtterMeeting } from '../connectors/otter.js';
import { startScheduler } from '../scheduler.js';
import { registerPrimeTools, MCP_SERVER_CONFIG } from './mcp.js';
import { getAmbientDisplayHTML } from './ambient-display.js';
import { mutateSoulFromCorrection } from '../soul-mutation.js';

export async function startServer(port: number = 3210, options: { sync?: boolean; syncInterval?: number } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ── SECURITY: API Key Authentication ──
  // API_KEY loaded after db init (see below)

  // CORS — restrict to known origins
  const ALLOWED_ORIGINS = [
    'http://localhost:5173',                    // Local dev
    'http://localhost:3000',                    // Local dev alt
    'https://prime.recaptureinsurance.com',     // Self (tunnel)
  ];

  app.use((_req, res, next) => {
    const origin = _req.headers.origin || '';
    // Allow known origins + any lovable.app subdomain
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.lovable.app')) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, mcp-session-id');
    if (_req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Auth middleware — require API key for untrusted requests
  app.use((req, res, next) => {
    // Skip auth for health/status/MCP
    if (req.path === '/api/health' || req.path === '/api/status' || req.path.startsWith('/mcp')) return next();
    // Skip auth for localhost
    const ip = req.ip || req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    // Skip auth for trusted web app origins (CORS already restricts to known origins)
    const origin = req.headers.origin || '';
    if (origin.endsWith('.lovable.app') || ALLOWED_ORIGINS.includes(origin)) return next();
    // Require API key for everything else
    if (API_KEY) {
      const key = (req.headers['x-api-key'] as string) || req.headers.authorization?.replace('Bearer ', '');
      if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }
    next();
  });

  const db = getDb();
  const API_KEY = process.env.PRIME_API_KEY || getConfig(db, 'prime_api_key');

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

  // Retrieve full source content — "go to the shelf"
  app.post('/api/retrieve', async (req, res) => {
    try {
      const { source_ref } = req.body;
      if (!source_ref) {
        res.status(400).json({ error: 'source_ref required' });
        return;
      }
      // Look up the knowledge item to get source + metadata
      const item = db.prepare('SELECT source, source_ref, metadata FROM knowledge WHERE source_ref = ?').get(source_ref) as any;
      if (!item) {
        res.json({ content: null, error: `No knowledge item found for source_ref: ${source_ref}` });
        return;
      }
      const { retrieveSourceContent } = await import('../source-retrieval.js');
      const result = await retrieveSourceContent(db, {
        source: item.source,
        source_ref: item.source_ref,
        metadata: typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata,
      });
      if (result) {
        res.json({ content: result.content, content_type: result.content_type, source: result.source });
      } else {
        res.json({ content: null, error: 'Could not retrieve source content' });
      }
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
    const _dRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'dismissed_projects'").get() as any)?.value;
    const dismissed: string[] = _dRaw ? JSON.parse(_dRaw) : [];
    const projects = new Map<string, { name: string; items: number; importance: string }>();

    for (const item of results) {
      if (item.project && !dismissed.includes(item.project)) {
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

  // ── Ambient State API (powers all display surfaces) ─────
  app.get('/api/ambient', (_req, res) => {
    try {
      // ============================================================
      // PRIORITY ENGINE — Business-driven, not reply-driven
      //
      // Tier 1: Strategic milestones (deadlines, launches, obligations)
      // Tier 2: Active deal work (what moves deals forward)
      // Tier 3: Genuine dropped balls (filtered — no solicitations)
      // ============================================================

      const priorities: any[] = [];

      // ---- TIER 1: Strategic milestones ----
      // Overdue and upcoming commitments with due dates
      const urgentCommitments = db.prepare(`
        SELECT id, text, state, due_date, owner, project, context
        FROM commitments
        WHERE state IN ('active', 'overdue')
        AND due_date IS NOT NULL
        AND due_date < datetime('now', '+7 days')
        ORDER BY due_date ASC
        LIMIT 5
      `).all() as any[];

      for (const c of urgentCommitments) {
        const daysUntil = Math.round((new Date(c.due_date).getTime() - Date.now()) / 86400000);
        const isOverdue = daysUntil < 0;
        priorities.push({
          id: `commitment-${c.id}`,
          tier: 1,
          type: 'milestone',
          summary: c.text,
          reasoning: isOverdue
            ? `${Math.abs(daysUntil)} days overdue. ${c.context || ''}`
            : `Due in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}. ${c.context || ''}`,
          project: c.project,
          urgency: isOverdue ? 'critical' : daysUntil <= 2 ? 'high' : 'medium',
          due_date: c.due_date,
        });
      }

      // Project profiles — accelerating projects need next actions surfaced
      let projectProfiles: any[] = [];
      try {
        const profilesRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any;
        if (profilesRaw) projectProfiles = JSON.parse(profilesRaw.value);
      } catch (_e) {}

      // Surface ALL projects with next actions — the system already figured out what matters
      const statusUrgency: Record<string, string> = {
        accelerating: 'critical',  // Carefront launch — highest urgency
        stalling: 'high',          // Stalling deals need unblocking
        active: 'medium',
        steady: 'low',
      };

      // Skip projects that are just maintenance or have been paused
      const skipProjects = new Set(['COI Processing Automation', 'Prime']);

      for (const p of projectProfiles) {
        if (!p.next_action) continue;
        if (skipProjects.has(p.project)) continue;
        if (p.next_action.toLowerCase().includes('no action needed')) continue;

        // Don't duplicate if project already in commitments
        const alreadyShown = priorities.some(pr => pr.project === p.project && pr.tier === 1);

        priorities.push({
          id: `project-${p.project}`,
          tier: alreadyShown ? 2 : 1, // Demote to tier 2 if commitment already covers it
          type: 'strategic',
          summary: p.next_action,
          reasoning: `${p.project} [${p.status}]: ${p.status_reasoning?.slice(0, 150)}`,
          project: p.project,
          urgency: statusUrgency[p.status] || 'medium',
        });
      }

      // ---- TIER 2: Staged actions (quality-gated) ----
      const rawActions = db.prepare(
        "SELECT id, type, summary, reasoning, project, payload, created_at, deep_session_id, theme, sequence_order, status FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY sequence_order, id"
      ).all() as any[];

      for (const a of rawActions) {
        let payload: any = {};
        try { payload = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {}); } catch (_e) {}

        // QUALITY GATE: Skip actions targeting dismissed/noise entities
        if (payload.to) {
          const isDismissed = db.prepare(
            "SELECT 1 FROM entities WHERE (email = ? OR canonical_name LIKE ?) AND user_dismissed = 1"
          ).get(payload.to, `%${payload.to.split('@')[0]}%`);
          if (isDismissed) continue;

          // QUALITY GATE: Skip if there's been new communication since action was created
          // (action may be stale)
          const newActivity = db.prepare(`
            SELECT COUNT(*) as cnt FROM knowledge
            WHERE source_date > ? AND (contacts LIKE ? OR summary LIKE ?)
          `).get(a.created_at, `%${payload.to}%`, `%${payload.to.split('@')[0]}%`) as any;

          if (newActivity?.cnt > 0) {
            // Mark as stale but don't skip entirely — show with warning
            a._stale = true;
          }
        }

        // QUALITY GATE: Expire old actions (7 days for deep session actions, 72h for others)
        const ageHours = (Date.now() - new Date(a.created_at).getTime()) / 3600000;
        const maxAge = a.deep_session_id ? 168 : 72; // 7 days vs 72 hours
        if (ageHours > maxAge) {
          db.prepare("UPDATE staged_actions SET status = 'expired' WHERE id = ?").run(a.id);
          continue;
        }

        priorities.push({
          id: `action-${a.id}`,
          tier: 2,
          type: a.type || 'task',
          summary: a.summary,
          reasoning: a.reasoning,
          project: a.project,
          urgency: 'medium',
          created_at: a.created_at,
          to: payload.to || null,
          subject: payload.subject || null,
          body: payload.body || null,
          gmail_link: payload.to ? `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(payload.to)}&su=${encodeURIComponent(payload.subject || '')}&body=${encodeURIComponent(payload.body || '')}` : null,
          stale: a._stale || false,
          action_id: a.id,
          deep_session_id: a.deep_session_id || null,
          theme: a.theme || null,
          sequence_order: a.sequence_order || null,
          status: a.status || 'pending',
        });
      }

      // ---- TIER 3: Entity alerts (genuine concerns only) ----
      try {
        const entityAlerts = db.prepare(`
          SELECT e.canonical_name, e.user_label, ep.alert_verdict, ep.communication_nature, ep.last_verified_at
          FROM entity_profiles ep
          JOIN entities e ON ep.entity_id = e.id
          WHERE ep.alert_verdict = 'genuine_concern'
          AND e.user_dismissed = 0
          AND e.user_label NOT IN ('noise', 'solicitation')
          ORDER BY ep.last_verified_at DESC LIMIT 3
        `).all() as any[];

        for (const ea of entityAlerts) {
          priorities.push({
            id: `entity-${ea.canonical_name}`,
            tier: 3,
            type: 'relationship',
            summary: `${ea.canonical_name} — ${ea.communication_nature || 'needs attention'}`,
            reasoning: `Relationship type: ${ea.user_label || 'unknown'}. Alert: ${ea.alert_verdict}`,
            urgency: 'low',
            created_at: ea.last_verified_at,
          });
        }
      } catch (_e) {}

      // ---- RECENCY WEIGHTING ----
      // Same formula as search.ts: score * 1/(1 + days_old * 0.05)
      // 7-day-old item scores 74% of a fresh one, 30-day-old scores 40%
      const RECENCY_BIAS = 0.05;
      for (const p of priorities) {
        const dateStr = p.due_date || p.created_at || null;
        if (dateStr) {
          const daysOld = Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 86400000);
          p._recency_weight = 1 / (1 + daysOld * RECENCY_BIAS);
        } else {
          p._recency_weight = 1.0;
        }
      }

      // Sort by URGENCY first (what matters most), then recency within same urgency+tier
      const urgencyOrder: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
      priorities.sort((a, b) => {
        const urgA = urgencyOrder[a.urgency] ?? 5;
        const urgB = urgencyOrder[b.urgency] ?? 5;
        if (urgA !== urgB) return urgA - urgB;
        if (a.tier !== b.tier) return a.tier - b.tier;
        // Within same urgency+tier, fresher items rank higher
        return (b._recency_weight ?? 1) - (a._recency_weight ?? 1);
      });

      // ---- INTELLIGENCE BRIEF OVERRIDES ----
      // Intelligence cycle outputs take priority over stale pipeline data
      let oneThing = 'No urgent priorities. Focus on what matters most to you.';
      let intelActions: any[] = [];
      try {
        const intelRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
        if (intelRaw) {
          const intel = JSON.parse(intelRaw);
          if (intel.the_one_thing) oneThing = intel.the_one_thing;
        }
        const actionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
        if (actionsRaw) intelActions = JSON.parse(actionsRaw);
      } catch (_e) {}
      // Fallback to old staged_actions if no intelligence brief
      if (oneThing === 'No urgent priorities. Focus on what matters most to you.' && priorities.length > 0) {
        const top = priorities[0];
        oneThing = top.summary;
        if (top.due_date) {
          const daysUntil = Math.round((new Date(top.due_date).getTime() - Date.now()) / 86400000);
          if (daysUntil < 0) oneThing += ` — ${Math.abs(daysUntil)} days overdue`;
          else if (daysUntil === 0) oneThing += ' — due today';
          else oneThing += ` — due in ${daysUntil} days`;
        }
      }

      // ---- CONTEXT ----
      const narrativeState = db.prepare("SELECT value, updated_at FROM graph_state WHERE key = 'world_narrative'").get() as any;
      const narrativeAge = narrativeState ? (Date.now() - new Date(narrativeState.updated_at).getTime()) / 3600000 : 999;

      const predAccuracy = db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_accuracy'").get() as any;
      const accuracy = predAccuracy ? JSON.parse(predAccuracy.value) : null;

      const threads = db.prepare(
        "SELECT title, current_state, next_action, project, source_count, item_count FROM narrative_threads WHERE status = 'active' ORDER BY latest_source_date DESC LIMIT 5"
      ).all() as any[];

      const reflection = db.prepare("SELECT value FROM graph_state WHERE key = 'strategic_reflection_latest'").get() as any;
      const metaInsight = reflection ? JSON.parse(reflection.value)?.meta_insight : null;

      const lastDream = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_run'").get() as any)?.value;
      const dreamAge = lastDream ? (Date.now() - new Date(lastDream).getTime()) / 3600000 : 999;

      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
      const todayEvents = db.prepare(`
        SELECT title, source_date, metadata FROM knowledge_primary
        WHERE source = 'calendar' AND source_date >= ? AND source_date <= ?
        ORDER BY source_date ASC LIMIT 5
      `).all(todayStart.toISOString(), todayEnd.toISOString()) as any[];

      const stats = getStats(db);

      // Display state based on priority tiers
      const hasCritical = priorities.some(p => p.urgency === 'critical');
      const hasActions = priorities.some(p => p.tier === 2);
      let displayState = 'ambient';
      if (hasCritical) displayState = 'crisis';
      else if (hasActions || priorities.length > 3) displayState = 'pulse';
      else if (narrativeAge < 1) displayState = 'briefing';

      // Load detected gaps for display
      let detectedGaps: any[] = [];
      try {
        const gapsRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'detected_gaps'").get() as any;
        if (gapsRaw) detectedGaps = JSON.parse(gapsRaw.value);
      } catch (_e) {}

      // Load pending questions for display
      let pendingQuestions: any[] = [];
      try {
        const qRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'pending_questions'").get() as any;
        if (qRaw) pendingQuestions = JSON.parse(qRaw.value);
      } catch (_e) {}

      res.json({
        display_state: displayState,
        one_thing: oneThing,
        actions_pending: intelActions.length > 0 ? intelActions.length : priorities.length,
        actions: intelActions.length > 0 ? intelActions : priorities.slice(0, 8),
        threads: threads.map((t: any) => ({ title: t.title, state: t.current_state, next: t.next_action, items: t.item_count })),
        calendar_today: todayEvents.map((e: any) => {
          const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata || {};
          return { title: e.title, time: meta.start_time || e.source_date };
        }),
        detected_gaps: detectedGaps.slice(0, 10),
        gaps_summary: detectedGaps.length > 0 ? {
          total: detectedGaps.length,
          critical: detectedGaps.filter((g: any) => g.severity === 'critical').length,
          high: detectedGaps.filter((g: any) => g.severity === 'high').length,
        } : null,
        questions: pendingQuestions.slice(0, 5),
        prediction_accuracy: accuracy ? Math.round(accuracy.accuracy_rate * 100) : null,
        meta_insight: metaInsight,
        dream_age_hours: Math.round(dreamAge),
        knowledge_items: stats.total_items,
        upcoming_meetings: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'upcoming_meeting_prep'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        cross_project_patterns: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'cross_project_patterns'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        detected_contradictions: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'detected_contradictions'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        proactive_alerts: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'proactive_alerts'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        questions_pending: pendingQuestions.length,
        cos_ready_brief: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'cos_ready_brief'").get() as any)?.value;
            return raw ? JSON.parse(raw) : null;
          } catch { return null; }
        })(),
        intelligence_brief: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
            return raw ? JSON.parse(raw) : null;
          } catch { return null; }
        })(),
        active_hypotheses: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'active_hypotheses'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        weak_signals: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'weak_signals'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        intelligence_actions: (() => {
          try {
            const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })(),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Worker Task Queue (autonomous multi-session coordination) ──
  app.get('/api/v1/tasks', (_req, res) => {
    try {
      const status = (_req.query.status as string) || 'pending';
      const tasks = db.prepare('SELECT * FROM worker_tasks WHERE status = ? ORDER BY priority ASC, created_at ASC').all(status);
      res.json({ tasks });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/v1/tasks', async (req, res) => {
    try {
      const { v4: uuidv4 } = await import('uuid');
      const { title, description, assigned_to, priority, created_by } = req.body;
      const id = uuidv4();
      db.prepare('INSERT INTO worker_tasks (id, title, description, assigned_to, priority, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, title, description || '', assigned_to || null, priority || 5, created_by || 'supervisor');
      res.json({ id, status: 'pending' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/v1/tasks/:id/claim', (req, res) => {
    try {
      const { worker } = req.body;
      const result = db.prepare("UPDATE worker_tasks SET status = 'in_progress', assigned_to = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(worker, req.params.id);
      res.json({ claimed: (result as any).changes > 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/v1/tasks/:id/complete', (req, res) => {
    try {
      const { result } = req.body;
      db.prepare("UPDATE worker_tasks SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?")
        .run(result || '', req.params.id);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Chat API (replaces Claude Desktop as primary interface) ──
  app.get('/api/v1/chat/sidebar', async (_req, res) => {
    try {
      const { getChatSidebar } = await import('../ai/chat.js');
      res.json(getChatSidebar(db));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/v1/chat/sessions', (req, res) => {
    try {
      const project = req.query.project as string | undefined;
      const query = project
        ? "SELECT * FROM chat_sessions WHERE status = 'active' AND primary_project = ? ORDER BY updated_at DESC LIMIT 50"
        : "SELECT * FROM chat_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50";
      const sessions = project ? db.prepare(query).all(project) : db.prepare(query).all();
      res.json({ sessions });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/v1/chat/sessions/:id', (req, res) => {
    try {
      const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(req.params.id);
      const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(req.params.id);
      res.json({ session, messages });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/v1/chat/message', async (req, res) => {
    try {
      const { chatMessage } = await import('../ai/chat.js');
      const { session_id, message, project, thread_id } = req.body;
      if (!message) { res.status(400).json({ error: 'message required' }); return; }
      const result = await chatMessage(db, { session_id, message, project, thread_id });
      res.json(result);
    } catch (err: any) {
      console.error('[Chat] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/v1/chat/sessions/:id', (req, res) => {
    try {
      db.prepare("UPDATE chat_sessions SET status = 'archived' WHERE id = ?").run(req.params.id);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Prime Direct Conversational Interface ──
  // Talk to Prime directly. Each session_id is a persistent conversation
  // with accumulated context and full access to Prime's tools.
  app.post('/api/prime', async (req, res) => {
    try {
      const { message, session_id } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      // Store user feedback immediately — don't wait for COS response
      // This ensures "I handled this" / "that's wrong" gets into the knowledge base
      try {
        const userLower = message.toLowerCase();
        const isDecision = /\b(decided|done|handled|completed|paused|stopped|cancelled|postponed|approved|rejected|signed|confirmed|changed|updated|moved|dropped)\b/.test(userLower);
        const isCorrection = /\b(wrong|incorrect|not right|actually|no that's|stop showing|already|don't|doesn't|isn't|not going|not traveling|cancel|dismiss|ignore|skip)\b/.test(userLower);
        // Store ALL substantive CEO messages — not just keyword matches
        // Anything over 15 chars that isn't a system prefix is worth keeping
        const isSubstantive = message.trim().length > 15 && !message.startsWith('[');
        if (isDecision || isCorrection || isSubstantive) {
          const { v4: uuidv4 } = await import('uuid');
          const { insertKnowledge } = await import('../db.js');
          insertKnowledge(db, {
            id: uuidv4(),
            title: `User update: ${message.slice(0, 120)}`,
            summary: message,
            source: 'user-feedback',
            source_ref: `prime:${session_id || 'new'}:${Date.now()}`,
            source_date: new Date().toISOString(),
            tags: isCorrection ? ['user-correction', 'feedback'] : isDecision ? ['user-decision', 'feedback'] : ['ceo-input', 'feedback'],
            importance: isCorrection ? 'critical' : 'high',
            provenance: 'primary',
            metadata: { session_id, type: isCorrection ? 'correction' : isDecision ? 'decision' : 'ceo-statement' },
          });
          if (isCorrection) {
            db.prepare(`INSERT OR IGNORE INTO strategic_lessons (id, lesson_date, lesson_type, lesson, domain, severity, correction_rule) VALUES (?, date('now'), 'user_correction', ?, 'general', 'high', ?)`)
              .run(uuidv4(), `User said: ${message.slice(0, 200)}`, message.slice(0, 500));
          }
        }
      } catch { /* non-critical */ }

      const { request: httpReq } = await import('http');
      const body = JSON.stringify({ message, session_id: session_id || '', timeout: 120 });

      const result = await new Promise<any>((resolve, reject) => {
        const cosReq = httpReq('http://localhost:3211/prime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 130000,
        }, (cosRes) => {
          let data = '';
          cosRes.on('data', (d: Buffer) => { data += d.toString(); });
          cosRes.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve({ content: data, session_id: '' }); }
          });
        });
        cosReq.on('error', reject);
        cosReq.on('timeout', () => { cosReq.destroy(); reject(new Error('COS proxy timeout')); });
        cosReq.write(body);
        cosReq.end();
      });

      res.json(result);
    } catch (err: any) {
      // Fallback to direct ask if proxy unavailable
      try {
        const { chatMessage } = await import('../ai/chat.js');
        const result = await chatMessage(db, { message: req.body.message, session_id: req.body.session_id });
        res.json(result);
      } catch (fallbackErr: any) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // ── User feedback — votes, confirmations, corrections on any content ──
  app.post('/api/feedback', async (req, res) => {
    try {
      const { type, content, vote, reason, project } = req.body;
      // type: 'hypothesis', 'weak_signal', 'contradiction', 'action', 'insight'
      // vote: 'confirmed', 'rejected', 'useful', 'not_useful'
      // content: the text/claim being voted on
      // reason: optional explanation

      if (!type || !content || !vote) {
        res.status(400).json({ error: 'type, content, and vote are required' });
        return;
      }

      const { v4: uuidv4 } = await import('uuid');
      const { insertKnowledge } = await import('../db.js');

      // Store as knowledge item
      insertKnowledge(db, {
        id: uuidv4(),
        title: `Feedback: ${vote} — ${content.slice(0, 100)}`,
        summary: `User ${vote} this ${type}: "${content}"${reason ? `. Reason: ${reason}` : ''}`,
        source: 'user-feedback',
        source_ref: `feedback:${type}:${Date.now()}`,
        source_date: new Date().toISOString(),
        tags: ['user-feedback', `feedback-${vote}`, `feedback-${type}`],
        project: project || undefined,
        importance: vote === 'rejected' ? 'high' : 'normal',
        metadata: { type, vote, content, reason },
      });

      // If rejected, also create a correction rule
      if (vote === 'rejected') {
        db.prepare(`
          INSERT OR IGNORE INTO strategic_lessons (id, lesson_date, lesson_type, lesson, domain, severity, correction_rule)
          VALUES (?, date('now'), 'user_correction', ?, ?, 'high', ?)
        `).run(uuidv4(), `User rejected ${type}: "${content.slice(0, 200)}"`, type, reason || `Do not repeat this ${type}`);
      }

      res.json({ stored: true, vote });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Action approval (for ambient display + API clients) ──
  app.post('/api/approve-action', async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { executeAction } = await import('../actions.js');
      const result = await executeAction(db, id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dismiss action with feedback → creates correction rule ──
  app.post('/api/dismiss-action', async (req, res) => {
    try {
      const { id, reason, explanation } = req.body;
      if (!id || !reason) return res.status(400).json({ error: 'id and reason required' });

      // Mark the staged action as dismissed
      db.prepare("UPDATE staged_actions SET status = 'dismissed', acted_at = datetime('now') WHERE id = ? OR id = ?")
        .run(id, String(id).replace('action-', ''));

      // Get the action details for context
      const action = db.prepare("SELECT summary, project, payload FROM staged_actions WHERE id = ? OR id = ?")
        .get(id, String(id).replace('action-', '')) as any;

      const payload = action?.payload ? (typeof action.payload === 'string' ? JSON.parse(action.payload) : action.payload) : {};
      const entityName = payload.to?.split('@')[0] || action?.summary?.split(' ').slice(0, 3).join(' ') || 'unknown';

      // Create a correction rule — ACTION-specific, not entity-wide
      // Dismissing an action about Charlie does NOT suppress all Charlie-related actions
      const actionDesc = action?.summary?.slice(0, 80) || 'unknown action';
      const ruleMap: Record<string, string> = {
        'already_handled': `Action "${actionDesc}" is already done. Do not regenerate this specific action.${explanation ? ' Context: ' + explanation : ''}`,
        'on_hold': `Action "${actionDesc}" is on hold.${explanation ? ' Reason: ' + explanation : ''} Do not resurface this specific action until conditions change.`,
        'wrong_person': `Action "${actionDesc}" was associated with the wrong person or project. ${explanation || ''}`,
        'not_mine': `"${actionDesc}" is not the user's responsibility.`,
        'not_relevant': `"${actionDesc}" is not relevant right now. ${explanation || ''}`,
        'noise': `"${actionDesc}" is noise. Do not regenerate this specific action.`,
      };

      const correctionRule = ruleMap[reason] || `User dismissed: ${reason}. ${explanation || ''}`;

      // Store as a strategic lesson
      db.prepare(`
        INSERT INTO strategic_lessons (id, lesson_date, lesson_type, lesson, domain, root_cause, severity, correction_rule)
        VALUES (?, date('now'), 'user_correction', ?, 'entity', ?, 'medium', ?)
      `).run(
        uuid(),
        `User dismissed "${action?.summary}" with reason: ${reason}`,
        explanation || reason,
        correctionRule
      );

      // Also save as a knowledge item so agents see it
      const { insertKnowledge } = await import('../db.js');
      insertKnowledge(db, {
        id: uuid(),
        title: `User correction: ${action?.summary?.slice(0, 60)}`,
        summary: `Zach dismissed this action. Reason: ${reason}. ${explanation || ''}. The system should not resurface this.`,
        source: 'user-feedback',
        source_ref: `dismiss:${id}`,
        source_date: new Date().toISOString(),
        tags: ['user-correction', 'dismissal', reason],
        project: action?.project,
        importance: 'high', // User corrections are high importance — the system must learn
      });

      // NEVER dismiss an entity just because an action was dismissed.
      // Entity dismissal is a separate explicit action (via prime_correct or entity management).
      // Dismissing "Follow up with Charlie" should NOT dismiss Charlie as a person.

      // If reason is 'on_hold', update entity_signals
      if (reason === 'on_hold') {
        const entity = db.prepare("SELECT id FROM entities WHERE email = ? OR canonical_name LIKE ?")
          .get(payload.to, `%${entityName}%`) as any;
        if (entity) {
          db.prepare("INSERT OR REPLACE INTO entity_signals (id, entity_id, signal_type, count, last_seen) VALUES (?, ?, 'on_hold', 1, datetime('now'))")
            .run(uuid(), entity.id);
        }
      }

      // Rebuild active correction rules in graph_state
      const allRules = db.prepare(`
        SELECT lesson_type, correction_rule, domain FROM strategic_lessons
        WHERE correction_rule IS NOT NULL AND superseded_by IS NULL
        ORDER BY lesson_date DESC LIMIT 50
      `).all();
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_correction_rules', ?, datetime('now'))")
        .run(JSON.stringify(allRules));

      res.json({ ok: true, reason, correction_rule: correctionRule });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Ambient Display (full-screen kiosk app) ────────────
  app.get('/ambient', (_req, res) => {
    res.send(getAmbientDisplayHTML());
  });

  // ── Legacy Dashboard ───────────────────────────────────
  app.get('/dashboard', async (_req, res) => {
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

  // ── Claude.ai live conversation access (all orgs) ──────

  app.get('/api/claude/conversations', async (req, res) => {
    try {
      const sessionKey = getConfig(db, 'claude_session_key');
      if (!sessionKey) return res.status(400).json({ error: 'No claude session key' });
      const { claudeApiGet } = await import('../connectors/claude.js');
      const orgs = getConfig(db, 'claude_organizations') || [];
      const q = (req.query.q as string || '').toLowerCase();
      const results: any[] = [];
      const seenUuids = new Set<string>();

      // SOURCE 1: Knowledge base (semantic + keyword search — finds indexed convos by content)
      if (q) {
        try {
          const { search } = await import('../ai/search.js');
          const searchResults = await search(db, q, { limit: 15, source: 'claude' });
          for (const item of (searchResults?.items || [])) {
            const ref = item.source_ref;
            if (ref?.startsWith('claude:')) {
              const uuid = ref.replace('claude:', '').split(':')[0];
              if (!seenUuids.has(uuid)) {
                seenUuids.add(uuid);
                results.push({
                  uuid, name: item.title, summary: item.summary?.slice(0, 200),
                  source_date: item.source_date, project: item.project,
                  match_source: 'knowledge_base', similarity: item.similarity,
                });
              }
            }
          }
        } catch (_e) {}
      }

      // SOURCE 2: Live Claude.ai API (finds un-indexed + title/summary matches)
      for (const org of (orgs as any[])) {
        try {
          const convos = await (claudeApiGet as any)(`/organizations/${org.uuid}/chat_conversations`, sessionKey, db) as any[];
          for (const c of (convos || [])) {
            if (seenUuids.has(c.uuid)) continue;
            const matches = !q || c.name?.toLowerCase().includes(q) || c.summary?.toLowerCase().includes(q);
            if (matches) {
              seenUuids.add(c.uuid);
              results.push({
                uuid: c.uuid, name: c.name, summary: c.summary,
                created_at: c.created_at, updated_at: c.updated_at,
                project: c.project?.name, org: org.name,
                match_source: 'live_api',
              });
            }
          }
        } catch (_e) {}
      }

      res.json({ conversations: results.slice(0, 50), total: results.length, sources: { knowledge_base: results.filter(r => r.match_source === 'knowledge_base').length, live_api: results.filter(r => r.match_source === 'live_api').length } });
    } catch (err: any) {
      res.status(500).json({ error: err.message?.slice(0, 200) });
    }
  });

  app.get('/api/claude/conversations/:uuid', async (req, res) => {
    try {
      const sessionKey = getConfig(db, 'claude_session_key');
      if (!sessionKey) return res.status(400).json({ error: 'No claude session key' });
      const { claudeApiGet } = await import('../connectors/claude.js');
      const orgs = getConfig(db, 'claude_organizations') || [];

      let convo: any = null;
      for (const org of (orgs as any[])) {
        try {
          convo = await (claudeApiGet as any)(`/organizations/${org.uuid}/chat_conversations/${req.params.uuid}`, sessionKey, db);
          if (convo?.chat_messages) break;
        } catch (_e) {}
      }
      if (!convo?.chat_messages) return res.status(404).json({ error: 'Conversation not found' });

      const messages = convo.chat_messages.map((m: any) => ({
        sender: m.sender,
        text: typeof m.text === 'string' ? m.text : (Array.isArray(m.text) ? m.text.map((t: any) => t.text || t.content || '').join('\n') : String(m.text || '')),
        created_at: m.created_at,
      }));
      res.json({ uuid: convo.uuid, name: convo.name, message_count: messages.length, messages });
    } catch (err: any) {
      res.status(500).json({ error: err.message?.slice(0, 200) });
    }
  });

  // ── Claude.ai file listing per conversation ──────
  app.get('/api/claude/conversations/:uuid/files', async (req, res) => {
    try {
      const sessionKey = getConfig(db, 'claude_session_key');
      if (!sessionKey) return res.status(400).json({ error: 'No session key' });
      const { claudeApiGet } = await import('../connectors/claude.js');
      const orgs = getConfig(db, 'claude_organizations') || [];

      let convo: any = null;
      let orgId: string = '';
      for (const org of (orgs as any[])) {
        try {
          convo = await (claudeApiGet as any)(`/organizations/${org.uuid}/chat_conversations/${req.params.uuid}`, sessionKey, db);
          if (convo?.chat_messages) { orgId = org.uuid; break; }
        } catch (_e) {}
      }
      if (!convo?.chat_messages) return res.status(404).json({ error: 'Not found' });

      const files: any[] = [];
      for (const msg of convo.chat_messages) {
        if (msg.files?.length) {
          for (const f of msg.files) {
            files.push({
              uuid: f.file_uuid,
              name: f.file_name,
              kind: f.file_kind,
              created_at: f.created_at,
              download_url: `/api/claude/files/${orgId}/${f.file_uuid}`,
            });
          }
        }
      }
      res.json({ conversation: convo.name, files, total: files.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message?.slice(0, 200) });
    }
  });

  // ── Claude.ai file proxy (download files from conversations) ──────
  app.get('/api/claude/files/:orgId/:fileId', async (req, res) => {
    try {
      const sessionKey = getConfig(db, 'claude_session_key');
      if (!sessionKey) return res.status(400).json({ error: 'No session key' });
      const url = `https://claude.ai/api/${req.params.orgId}/files/${req.params.fileId}/preview`;
      const response = await fetch(url, {
        headers: {
          'Cookie': `sessionKey=${sessionKey}`,
          'User-Agent': 'Mozilla/5.0',
        },
      });
      if (!response.ok) return res.status(response.status).json({ error: 'File not found' });
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message?.slice(0, 200) });
    }
  });

  // ── Ripple Engine — cascading impact analysis ────────
  app.post('/api/ripple', async (req, res) => {
    try {
      const { event } = req.body;
      if (!event) return res.status(400).json({ error: 'event required' });

      const { traceRipple } = await import('../ripple.js');
      const result = await traceRipple(db, event);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Deep Context — one-call multi-hop retrieval ────────
  app.post('/api/deep-context', async (req, res) => {
    try {
      const { topic, project, entity } = req.body;
      if (!topic) return res.status(400).json({ error: 'topic required' });

      const { search } = await import('../ai/search.js');
      const { retrieveSourceContent } = await import('../source-retrieval.js');

      // ── Step 1: Primary search (semantic + FTS) ──
      const primaryResults = await search(db, topic, {
        limit: 15,
        strategy: 'auto',
        project: project || undefined,
      });
      const primaryItems = primaryResults.items || [];

      // ── Step 2: Retrieve raw_content for top 3 results ──
      const topItems = primaryItems.slice(0, 3);
      const keyDocuments: any[] = [];
      for (const item of topItems) {
        let rawContent: string | null = null;
        if (item.source_ref) {
          try {
            const full = db.prepare('SELECT source, source_ref, metadata, raw_content FROM knowledge WHERE source_ref = ?').get(item.source_ref) as any;
            if (full?.raw_content) {
              rawContent = full.raw_content.slice(0, 5000);
            } else if (full) {
              const retrieved = await retrieveSourceContent(db, {
                source: full.source,
                source_ref: full.source_ref,
                metadata: typeof full.metadata === 'string' ? JSON.parse(full.metadata || '{}') : full.metadata,
              });
              if (retrieved?.content) rawContent = retrieved.content.slice(0, 5000);
            }
          } catch (_e) {}
        }
        keyDocuments.push({
          title: item.title,
          summary: item.summary,
          source: item.source,
          source_ref: item.source_ref,
          source_date: item.source_date,
          project: item.project,
          importance: item.importance,
          raw_content_preview: rawContent,
        });
      }

      // ── Step 3: Extract entity names from primary results ──
      const entityNames = new Set<string>();
      for (const item of primaryItems) {
        const contacts = Array.isArray(item.contacts) ? item.contacts : [];
        const orgs = Array.isArray(item.organizations) ? item.organizations : [];
        for (const c of contacts) entityNames.add(c);
        for (const o of orgs) entityNames.add(o);
      }
      if (entity) entityNames.add(entity);

      // ── Step 4: Second search for cross-references on discovered entities ──
      const crossRefItems: any[] = [];
      const entityQueries = Array.from(entityNames).slice(0, 5); // cap at 5
      for (const eName of entityQueries) {
        try {
          const eResults = await search(db, eName, { limit: 5, strategy: 'auto' });
          for (const item of (eResults.items || [])) {
            if (!primaryItems.some((p: any) => p.id === item.id)) {
              crossRefItems.push(item);
            }
          }
        } catch (_e) {}
      }
      // Deduplicate cross-refs
      const seenIds = new Set(primaryItems.map((i: any) => i.id));
      const uniqueCrossRefs = crossRefItems.filter(item => {
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      }).slice(0, 10);

      // ── Step 5: Narrative threads related to topic ──
      let activeThreads: any[] = [];
      try {
        const threadRows = db.prepare(
          `SELECT id, title, current_state, next_action, project, source_count, item_count, latest_source_date, summary
           FROM narrative_threads
           WHERE status = 'active'
           AND (title LIKE ? OR summary LIKE ? OR project LIKE ?)
           ORDER BY latest_source_date DESC LIMIT 5`
        ).all(`%${topic}%`, `%${topic}%`, `%${topic}%`) as any[];
        // Also match on entity name if provided
        if (entity) {
          const entityThreads = db.prepare(
            `SELECT id, title, current_state, next_action, project, source_count, item_count, latest_source_date, summary
             FROM narrative_threads
             WHERE status = 'active'
             AND (title LIKE ? OR summary LIKE ?)
             ORDER BY latest_source_date DESC LIMIT 3`
          ).all(`%${entity}%`, `%${entity}%`) as any[];
          const threadIds = new Set(threadRows.map(t => t.id));
          for (const t of entityThreads) {
            if (!threadIds.has(t.id)) threadRows.push(t);
          }
        }
        activeThreads = threadRows.map(t => ({
          title: t.title,
          state: t.current_state,
          next_action: t.next_action,
          project: t.project,
          sources: t.source_count,
          items: t.item_count,
          latest_date: t.latest_source_date,
        }));
      } catch (_e) {}

      // ── Step 6: Commitments related to topic/entity ──
      let commitments: any[] = [];
      try {
        const patterns = [topic];
        if (entity) patterns.push(entity);
        if (project) patterns.push(project);
        const orClauses = patterns.map(() => '(text LIKE ? OR owner LIKE ? OR project LIKE ? OR context LIKE ?)').join(' OR ');
        const params = patterns.flatMap(p => [`%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`]);
        const commitmentRows = db.prepare(
          `SELECT id, text, state, due_date, owner, project, context, importance
           FROM commitments
           WHERE (${orClauses})
           ORDER BY
             CASE state WHEN 'overdue' THEN 0 WHEN 'active' THEN 1 WHEN 'detected' THEN 2 ELSE 3 END,
             due_date ASC
           LIMIT 10`
        ).all(...params) as any[];
        commitments = commitmentRows.map(c => ({
          text: c.text,
          state: c.state,
          due: c.due_date,
          owner: c.owner,
          project: c.project,
          importance: c.importance,
        }));
      } catch (_e) {}

      // ── Step 7: Entity graph relationships ──
      let entitiesInvolved: any[] = [];
      try {
        for (const eName of entityQueries) {
          const entityRow = db.prepare(
            `SELECT id, type, canonical_name, email, relationship_type, relationship_confidence, last_seen_date, properties
             FROM entities
             WHERE canonical_name LIKE ? AND user_dismissed = 0
             LIMIT 1`
          ).get(`%${eName}%`) as any;
          if (entityRow) {
            // Get edges for this entity
            const edges = db.prepare(
              `SELECT ee.edge_type, ee.confidence, e2.canonical_name AS related_name, e2.type AS related_type
               FROM entity_edges ee
               JOIN entities e2 ON (ee.target_entity_id = e2.id AND ee.source_entity_id = ?)
                                OR (ee.source_entity_id = e2.id AND ee.target_entity_id = ?)
               WHERE e2.user_dismissed = 0
               ORDER BY ee.confidence DESC LIMIT 5`
            ).all(entityRow.id, entityRow.id) as any[];

            let props: any = {};
            try { props = typeof entityRow.properties === 'string' ? JSON.parse(entityRow.properties) : entityRow.properties || {}; } catch (_e) {}

            entitiesInvolved.push({
              name: entityRow.canonical_name,
              type: entityRow.type,
              email: entityRow.email,
              role: props.role || entityRow.relationship_type,
              last_activity: entityRow.last_seen_date,
              confidence: entityRow.relationship_confidence,
              relationships: edges.map((e: any) => ({
                type: e.edge_type,
                with: e.related_name,
                confidence: e.confidence,
              })),
            });
          }
        }
      } catch (_e) {}

      // ── Step 8: Build timeline from all gathered items ──
      const allItems = [...primaryItems, ...uniqueCrossRefs];
      const timeline = allItems
        .filter(i => i.source_date)
        .sort((a, b) => (a.source_date || '').localeCompare(b.source_date || ''))
        .slice(-15) // last 15 events
        .map(i => ({
          date: i.source_date,
          event: i.title,
          source: i.source,
        }));

      // ── Step 9: Assemble brief (raw data, no LLM) ──
      const totalSourcesFound = primaryItems.length + uniqueCrossRefs.length;
      const briefParts: string[] = [];
      briefParts.push(`Topic: ${topic}`);
      if (project) briefParts.push(`Project: ${project}`);
      briefParts.push(`${totalSourcesFound} sources found across ${new Set(allItems.map(i => i.source)).size} source types.`);
      if (primaryItems.length > 0) {
        briefParts.push(`\nTop results:`);
        for (const item of primaryItems.slice(0, 5)) {
          briefParts.push(`- [${item.source}] ${item.title} (${item.source_date || 'undated'}): ${item.summary?.slice(0, 200)}`);
        }
      }
      if (uniqueCrossRefs.length > 0) {
        briefParts.push(`\nCross-references (from entity discovery):`);
        for (const item of uniqueCrossRefs.slice(0, 5)) {
          briefParts.push(`- [${item.source}] ${item.title} (${item.source_date || 'undated'}): ${item.summary?.slice(0, 200)}`);
        }
      }
      if (commitments.length > 0) {
        briefParts.push(`\nCommitments: ${commitments.length} found`);
      }
      if (activeThreads.length > 0) {
        briefParts.push(`\nActive threads: ${activeThreads.length} ongoing narratives`);
      }

      // ── Open questions: things the data doesn't clearly answer ──
      const openQuestions: string[] = [];
      if (commitments.some(c => c.state === 'active' && !c.due)) openQuestions.push('Some commitments have no due date — when are they expected?');
      if (entitiesInvolved.length === 0 && entityNames.size > 0) openQuestions.push(`Entity graph has no records for: ${Array.from(entityNames).slice(0, 3).join(', ')}`);
      if (primaryItems.length === 0) openQuestions.push(`No knowledge items found for "${topic}" — has this been ingested?`);
      if (activeThreads.length === 0) openQuestions.push(`No active narrative threads found — is this topic currently being tracked?`);

      res.json({
        topic,
        sources_found: totalSourcesFound,
        sources_used: keyDocuments.length + uniqueCrossRefs.length,
        brief: briefParts.join('\n'),
        entities_involved: entitiesInvolved,
        active_threads: activeThreads,
        commitments,
        key_documents: keyDocuments,
        timeline,
        cross_references: uniqueCrossRefs.slice(0, 5).map(i => ({
          title: i.title,
          source: i.source,
          source_ref: i.source_ref,
          source_date: i.source_date,
          summary: i.summary?.slice(0, 300),
        })),
        open_questions: openQuestions,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MCP over SSE (for remote Claude Desktop) ───────────
  // GET /mcp establishes SSE stream, POST /mcp/messages sends JSON-RPC
  const mcpTransports = new Map<string, SSEServerTransport>();

  app.get('/mcp', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/mcp/messages', res);
      const sessionId = transport.sessionId;
      mcpTransports.set(sessionId, transport);

      transport.onclose = () => {
        mcpTransports.delete(sessionId);
      };

      const mcpServer = new McpServer(MCP_SERVER_CONFIG);
      registerPrimeTools(mcpServer);
      await mcpServer.connect(transport);

      console.log(`[MCP] SSE session established: ${sessionId}`);
    } catch (error: any) {
      console.error('[MCP] SSE error:', error.message);
      if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
    }
  });

  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error: any) {
      console.error('[MCP] Message error:', error.message);
      if (!res.headersSent) res.status(500).send('Error handling request');
    }
  });

  // ============================================================
  // Command Dispatch — unified natural language interface
  // ============================================================
  app.post('/api/v1/command', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) { res.status(400).json({ error: 'text required' }); return; }

      const cmd = text.trim().toLowerCase();

      // Pattern-match commands (instant, no LLM)
      if (cmd === 'status') {
        res.json({ intent: 'status', result: getStats(db) });
        return;
      }

      if (cmd === 'commitments' || cmd.startsWith('commitment')) {
        const rows = db.prepare("SELECT * FROM commitments WHERE state IN ('active','overdue') ORDER BY due_date ASC LIMIT 10").all();
        res.json({ intent: 'commitments', result: rows });
        return;
      }

      if (cmd === 'briefing' || cmd === 'brief') {
        const { askWithSources: ask } = await import('../ai/ask.js');
        const answer = await ask(db, 'Generate a morning briefing: top priorities, commitments due, dropped balls, relationship health.');
        res.json({ intent: 'briefing', result: answer });
        return;
      }

      if (cmd === 'calendar' || cmd === 'today') {
        const rows = db.prepare("SELECT title, summary, source_date, contacts, project FROM knowledge WHERE source = 'calendar' AND source_date >= date('now') AND source_date < date('now', '+2 days') ORDER BY source_date ASC LIMIT 10").all();
        res.json({ intent: 'calendar', result: rows });
        return;
      }

      if (cmd.startsWith('predict ') || cmd.startsWith('prediction ')) {
        const entity = text.replace(/^predict(ion)?\s+/i, '').trim();
        const { getEntityPrediction, ensurePredictorSchema } = await import('../ai/predict.js');
        ensurePredictorSchema(db);
        const pred = getEntityPrediction(db, entity);
        res.json({ intent: 'predict', entity, result: pred });
        return;
      }

      if (cmd.startsWith('search ')) {
        const query = text.replace(/^search\s+/i, '').trim();
        const apiKey = getConfig(db, 'openai_api_key');
        let results: any[];
        if (apiKey) {
          try {
            const emb = await generateEmbedding(query, apiKey);
            results = searchByEmbedding(db, emb, 10, 0.3);
          } catch {
            results = searchByText(db, query, 10);
          }
        } else {
          results = searchByText(db, query, 10);
        }
        res.json({ intent: 'search', query, result: results });
        return;
      }

      if (cmd.startsWith('ask ')) {
        const question = text.replace(/^ask\s+/i, '').trim();
        const { askWithSources: ask } = await import('../ai/ask.js');
        const answer = await ask(db, question);
        res.json({ intent: 'ask', result: answer });
        return;
      }

      if (cmd.startsWith('capture ') || cmd.startsWith('remember ')) {
        const content = text.replace(/^(capture|remember)\s+/i, '').trim();
        const apiKey = getConfig(db, 'openai_api_key');
        const extracted = await extractIntelligence(content, apiKey);
        const emb = await generateEmbedding(`${extracted.title}\n${extracted.summary}`, apiKey!);
        const item: KnowledgeItem = {
          id: uuid(), title: extracted.title, summary: extracted.summary,
          source: 'command', source_ref: `command:${Date.now()}`,
          source_date: new Date().toISOString(),
          contacts: extracted.contacts, organizations: extracted.organizations,
          decisions: extracted.decisions, commitments: extracted.commitments,
          action_items: extracted.action_items, tags: extracted.tags,
          project: extracted.project, importance: extracted.importance, embedding: emb,
        };
        insertKnowledge(db, item);
        res.json({ intent: 'capture', result: { id: item.id, title: item.title } });
        return;
      }

      if (cmd.startsWith('approve ')) {
        const id = text.replace(/^approve\s+/i, '').trim();
        try {
          const { executeAction } = await import('../actions.js');
          const result = await executeAction(db, id);
          res.json({ intent: 'approve', result });
        } catch (err: any) {
          res.json({ intent: 'approve', error: err.message });
        }
        return;
      }

      // Unrecognized — try as a search
      const results = searchByText(db, text, 5);
      if (results.length > 0) {
        res.json({ intent: 'search_fallback', query: text, result: results });
      } else {
        res.json({
          intent: 'unknown',
          preview: `I didn't understand "${text}". Try: search, ask, commitments, predict, capture, approve, briefing, calendar, status`,
          needs_disambiguation: true,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // Corrections API
  // ============================================================
  app.get('/api/v1/corrections', (_req, res) => {
    try {
      const corrections = db.prepare(
        `SELECT id, original_claim, corrected_claim, correction_type, affected_entity_id, affected_project,
                timestamp, propagation_status, propagated_at
         FROM brain_corrections ORDER BY timestamp DESC LIMIT 50`
      ).all();
      res.json({ corrections, total: corrections.length });
    } catch (err: any) {
      res.json({ corrections: [], total: 0, error: err.message });
    }
  });

  // ============================================================
  // Predictions API
  // ============================================================
  app.get('/api/v1/predictions', async (_req, res) => {
    try {
      const { getAnomalies, ensurePredictorSchema } = await import('../ai/predict.js');
      ensurePredictorSchema(db);
      const anomalies = getAnomalies(db);
      res.json({ anomalies, total: anomalies.length });
    } catch (err: any) {
      res.json({ anomalies: [], total: 0, error: err.message });
    }
  });

  // ============================================================
  // Questions API — answer questions generated by dream pipeline
  // ============================================================
  app.get('/api/v1/questions', (_req, res) => {
    try {
      const status = (_req.query.status as string) || 'pending';
      const questions = db.prepare(
        `SELECT id, question, category, project, entity, context, priority, status, answer, created_at, answered_at
         FROM prime_questions WHERE status = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT 20`
      ).all(status);
      res.json({ questions, total: questions.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/v1/questions/:id/answer', async (req, res) => {
    try {
      const { answer } = req.body;
      if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
        res.status(400).json({ error: 'answer (non-empty string) required' });
        return;
      }

      const questionId = req.params.id;
      const question = db.prepare('SELECT * FROM prime_questions WHERE id = ?').get(questionId) as any;
      if (!question) {
        res.status(404).json({ error: 'question not found' });
        return;
      }

      // 1. Update the question row
      db.prepare(
        "UPDATE prime_questions SET answer = ?, status = 'answered', answered_at = datetime('now') WHERE id = ?"
      ).run(answer.trim(), questionId);

      // 2. Store the answer as a knowledge item so it feeds into future dream pipeline analysis
      const { v4: uuidv4 } = await import('uuid');
      const { insertKnowledge } = await import('../db.js');
      // CEO answers are ground truth — primary provenance, critical importance
      insertKnowledge(db, {
        id: uuidv4(),
        title: `CEO Answer: ${question.question.slice(0, 100)}`,
        summary: `Q: ${question.question}\nA: ${answer.trim()}`,
        source: "user-feedback",
        source_ref: `prime-question:${questionId}`,
        source_date: new Date().toISOString(),
        contacts: question.entity ? [question.entity] : [],
        tags: ["user-answer", "ceo-input", question.category].filter(Boolean),
        project: question.project || undefined,
        importance: "critical",
        provenance: "primary",
        metadata: { question_id: questionId, question_text: question.question, category: question.category, entity: question.entity },
      });

      // Mark affected wiki pages stale so they recompile with this new info
      if (question.project) {
        db.prepare("UPDATE compiled_pages SET stale = 1 WHERE subject_id = ?").run(question.project);
      }

      // 3. If the question was about a prediction review, update the prediction outcome
      let predictionUpdated = false;
      if (question.category === 'prediction_review') {
        // Find matching pending prediction by subject or entity
        const matchField = question.entity || question.project;
        if (matchField) {
          const pred = db.prepare(
            "SELECT id FROM predictions WHERE outcome = 'pending' AND (subject LIKE ? OR project LIKE ?) ORDER BY prediction_date DESC LIMIT 1"
          ).get(`%${matchField}%`, `%${matchField}%`) as any;
          if (pred) {
            // Determine outcome from the answer text
            const lowerAnswer = answer.toLowerCase();
            let outcome = 'partially_correct';
            if (lowerAnswer.includes('correct') || lowerAnswer.includes('yes') || lowerAnswer.includes('confirmed') || lowerAnswer.includes('accurate')) {
              outcome = 'correct';
            } else if (lowerAnswer.includes('wrong') || lowerAnswer.includes('incorrect') || lowerAnswer.includes('no') || lowerAnswer.includes('missed')) {
              outcome = 'incorrect';
            }
            db.prepare(
              "UPDATE predictions SET outcome = ?, outcome_evidence = ?, outcome_date = datetime('now') WHERE id = ?"
            ).run(outcome, `User answer to Q:${questionId}: ${answer.trim().slice(0, 500)}`, pred.id);
            predictionUpdated = true;
          }
        }
      }

      // 4. Refresh the pending_questions cache in graph_state
      const pending = db.prepare(
        "SELECT id, question, category, project, entity, context, priority, created_at FROM prime_questions WHERE status = 'pending' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT 10"
      ).all();
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('pending_questions', ?, datetime('now'))").run(JSON.stringify(pending));

      res.json({ ok: true, question_id: questionId, prediction_updated: predictionUpdated, pending_remaining: pending.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // Calendar context API
  // ============================================================
  app.get('/api/v1/calendar', (_req, res) => {
    try {
      const events = db.prepare(`
        SELECT title, summary, source_date, contacts, project, metadata
        FROM knowledge
        WHERE source = 'calendar'
        AND source_date >= datetime('now', '-1 hour')
        AND source_date < datetime('now', '+2 days')
        ORDER BY source_date ASC
        LIMIT 10
      `).all();

      // Parse JSON fields
      for (const e of events as any[]) {
        for (const f of ['contacts', 'metadata']) {
          if (e[f] && typeof e[f] === 'string') {
            try { e[f] = JSON.parse(e[f]); } catch (_e) {}
          }
        }
      }

      res.json({ events, count: events.length });
    } catch (err: any) {
      res.json({ events: [], count: 0, error: err.message });
    }
  });

  // ── Decisions API ──

  app.post('/api/v1/decisions', (req, res) => {
    try {
      const { decision, reasoning, category, project, entity_name, supersedes_id, source } = req.body;
      if (!decision) return res.status(400).json({ error: 'decision required' });

      const id = uuid();

      // If superseding an older decision, mark it inactive
      if (supersedes_id) {
        db.prepare("UPDATE decisions SET active = 0 WHERE id = ?").run(supersedes_id);
      }

      db.prepare(`
        INSERT INTO decisions (id, decision, reasoning, category, project, entity_name, supersedes_id, active, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(id, decision, reasoning || null, category || null, project || null, entity_name || null, supersedes_id || null, source || 'user');

      res.json({ id, decision: decision.slice(0, 60) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/v1/decisions', (req, res) => {
    try {
      const { project, entity_name, category, active } = req.query;
      let sql = 'SELECT * FROM decisions WHERE 1=1';
      const params: any[] = [];

      if (active !== '0') {
        sql += ' AND active = 1';
      }
      if (project) {
        sql += ' AND project = ?';
        params.push(project);
      }
      if (entity_name) {
        sql += ' AND entity_name = ?';
        params.push(entity_name);
      }
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }

      sql += ' ORDER BY created_at DESC LIMIT 50';
      const decisions = db.prepare(sql).all(...params);
      res.json({ decisions, count: decisions.length });
    } catch (err: any) {
      res.json({ decisions: [], count: 0, error: err.message });
    }
  });

  // ── Deep Session endpoints ──

  app.post('/api/deep-session', async (req, res) => {
    try {
      const { topic, project } = req.body;
      if (!topic) {
        res.status(400).json({ error: 'topic is required' });
        return;
      }
      const { runDeepSession } = await import('../deep-session.js');
      const result = await runDeepSession(db, topic, 'api', project);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/deep-session/:id', (req, res) => {
    try {
      const session = db.prepare('SELECT * FROM deep_sessions WHERE id = ?').get(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/deep-session/:id/files/:filename', (req, res) => {
    try {
      const session: any = db.prepare('SELECT output_dir FROM deep_sessions WHERE id = ?').get(req.params.id);
      if (!session?.output_dir) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const safeName = basename(req.params.filename);
      const filePath = join(session.output_dir, safeName);
      if (!existsSync(filePath)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.type('text/markdown').send(readFileSync(filePath, 'utf-8'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/deep-sessions', (req, res) => {
    try {
      const sessions = db.prepare(
        'SELECT id, title, project, status, duration_seconds, actions_created, turns_used, created_at, completed_at FROM deep_sessions ORDER BY created_at DESC LIMIT 20'
      ).all();
      res.json({ sessions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Deep Session File Save — persist edited deliverables ──

  app.put('/api/deep-session/:id/files/:filename', (req, res) => {
    try {
      const session: any = db.prepare('SELECT output_dir FROM deep_sessions WHERE id = ?').get(req.params.id);
      if (!session?.output_dir) { res.status(404).json({ error: 'Session not found' }); return; }
      const safeName = basename(req.params.filename);
      const filePath = join(session.output_dir, safeName);
      writeFileSync(filePath, req.body.content || '', 'utf-8');
      res.json({ saved: true, filename: safeName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Shadow Board — four parallel AI advisors evaluate a decision ──

  app.post('/api/shadow-board', async (req, res) => {
    try {
      const { decision, context } = req.body;
      if (!decision) { res.status(400).json({ error: 'decision is required' }); return; }
      const { evaluateDecision } = await import('../shadow-board.js');
      const result = await evaluateDecision(db, decision, context);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Deep Session Actions — get staged actions for a specific session ──

  app.get('/api/deep-session/:id/actions', (req, res) => {
    try {
      const actions = db.prepare(`
        SELECT id, type, summary, payload, reasoning, project, status, theme, sequence_order, deep_session_id, created_at
        FROM staged_actions WHERE deep_session_id = ? ORDER BY sequence_order, id
      `).all(req.params.id) as any[];

      const mapped = actions.map((a: any) => {
        let payload: any = {};
        try { payload = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {}); } catch (_e) {}
        return {
          ...a,
          action_id: a.id,
          to: payload.to || null,
          subject: payload.subject || null,
          body: payload.body || null,
          gmail_link: payload.to ? `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(payload.to)}&su=${encodeURIComponent(payload.subject || '')}&body=${encodeURIComponent(payload.body || '')}` : null,
        };
      });

      res.json({ actions: mapped });
    } catch (err: any) {
      res.json({ actions: [], error: err.message });
    }
  });

  // ── Deep Session Suggestions — agents propose, Zach decides ──

  app.get('/api/deep-session-suggestions', (req, res) => {
    try {
      const suggestions = db.prepare(
        `SELECT * FROM deep_session_suggestions WHERE status IN ('pending', 'running') ORDER BY
          CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
          created_at DESC
        LIMIT 20`
      ).all();
      res.json({ suggestions });
    } catch (err: any) {
      res.json({ suggestions: [], error: err.message });
    }
  });

  app.post('/api/deep-session-suggestions', (req, res) => {
    try {
      const { suggested_by, topic, project, reasoning, urgency } = req.body;
      if (!topic || !suggested_by) {
        res.status(400).json({ error: 'topic and suggested_by are required' });
        return;
      }
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO deep_session_suggestions (id, suggested_by, topic, project, reasoning, urgency)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, suggested_by, topic, project || null, reasoning || null, urgency || 'normal');
      res.json({ id, status: 'pending' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/deep-session-suggestions/:id/approve', async (req, res) => {
    try {
      const suggestion: any = db.prepare('SELECT * FROM deep_session_suggestions WHERE id = ?').get(req.params.id);
      if (!suggestion) { res.status(404).json({ error: 'Not found' }); return; }
      db.prepare(`UPDATE deep_session_suggestions SET status = 'running', acted_at = datetime('now') WHERE id = ?`).run(req.params.id);
      const { runDeepSession } = await import('../deep-session.js');
      const result = await runDeepSession(db, suggestion.topic, suggestion.suggested_by, suggestion.project);
      db.prepare(`UPDATE deep_session_suggestions SET status = 'completed', deep_session_id = ? WHERE id = ?`).run(result.id, req.params.id);
      res.json(result);
    } catch (err: any) {
      db.prepare(`UPDATE deep_session_suggestions SET status = 'pending' WHERE id = ?`).run(req.params.id);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/deep-session-suggestions/:id/dismiss', (req, res) => {
    try {
      db.prepare(`UPDATE deep_session_suggestions SET status = 'dismissed', acted_at = datetime('now') WHERE id = ?`).run(req.params.id);
      res.json({ status: 'dismissed' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET endpoints for remote access (claude.ai WebFetch, phone, any browser) ──

  app.get('/api/search', async (req, res) => {
    try {
      const q = (req.query.q || req.query.query) as string;
      if (!q) { res.status(400).json({ error: 'q parameter required' }); return; }
      const { search } = await import('../ai/search.js');
      const result = await search(db, q, { limit: 10, strategy: 'auto', rerank: true });
      res.json({
        query: q,
        count: result.items?.length || 0,
        results: (result.items || []).map((item: any) => ({
          title: item.title,
          summary: item.summary?.slice(0, 500),
          source: item.source,
          source_ref: item.source_ref,
          source_date: item.source_date,
          project: item.project,
          score: item.score,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/ask', async (req, res) => {
    try {
      const q = (req.query.q || req.query.query) as string;
      if (!q) { res.status(400).json({ error: 'q parameter required' }); return; }
      const { askWithSources } = await import('../ai/ask.js');
      const result = await askWithSources(db, q);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/retrieve', async (req, res) => {
    try {
      const ref = req.query.ref as string;
      if (!ref) { res.status(400).json({ error: 'ref parameter required' }); return; }
      const { retrieveSourceContent } = await import('../source-retrieval.js');
      const item = db.prepare('SELECT * FROM knowledge WHERE source_ref = ?').get(ref) as any;
      if (!item) { res.status(404).json({ error: 'Not found' }); return; }
      const result = await retrieveSourceContent(db, item);
      res.json({ title: item.title, source: item.source, content: result?.content?.slice(0, 50000) || item.summary, content_type: result?.content_type });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/briefing', async (req, res) => {
    try {
      const { generateBriefing } = await import('../ai/briefing.js');
      const briefing = await generateBriefing(db);
      res.json(briefing);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Wiki Pages + PM Reports API ──
  
  // Get all compiled wiki pages
  app.get('/api/wiki', (req, res) => {
    const pages = db.prepare(
      "SELECT page_type, subject_name, content, compiled_at, version FROM compiled_pages ORDER BY page_type, compiled_at DESC"
    ).all();
    res.json({ pages });
  });

  // Get a specific wiki page
  app.get('/api/wiki/:type/:subject', (req, res) => {
    const page = db.prepare(
      "SELECT * FROM compiled_pages WHERE page_type = ? AND subject_id = ?"
    ).get(req.params.type, req.params.subject);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  });

  // Get PM agent state (memory, concerns, session info)
  app.get('/api/pm/:project', (req, res) => {
    const state = db.prepare(
      "SELECT * FROM agent_state WHERE agent_type = 'pm' AND subject_id = ?"
    ).get(req.params.project);
    if (!state) return res.status(404).json({ error: 'PM not found' });
    res.json(state);
  });

  // Submit a correction from the web UI
  app.post('/api/correct', async (req, res) => {
    const { claim, correction, project, entity } = req.body;
    if (!claim || !correction) return res.status(400).json({ error: 'claim and correction required' });
    
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO brain_corrections (id, original_claim, corrected_claim, correction_type, affected_project, propagation_status) VALUES (?, ?, ?, 'fact', ?, 'pending')"
    ).run(id, claim, correction, project || null);

    // Also store as a knowledge item so agents find it immediately
    const { v4: uuidv4 } = await import('uuid');
    db.prepare(
      "INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, importance, provenance, project) VALUES (?, ?, ?, 'correction', ?, datetime('now'), 'critical', 'correction', ?)"
    ).run(uuidv4(), 'CORRECTION: ' + correction.slice(0, 80), correction, 'correction:' + id, project || null);

    // Mark affected wiki pages stale
    if (project) {
      db.prepare("UPDATE compiled_pages SET stale = 1 WHERE subject_id = ?").run(project);
    }


    // Mutate SOUL.md files based on the correction (async, non-blocking)
    mutateSoulFromCorrection(db, { claim, correction, project }).catch(err =>
      console.error("[soul-mutation] Failed:", err.message)
    );

    res.json({ success: true, id });
  });

  // ── Dismissed Projects API ──

  // Dismiss a project from wiki compilation
  app.post('/api/dismiss-project', (req, res) => {
    try {
      const { project } = req.body;
      if (!project) { res.status(400).json({ error: 'project required' }); return; }

      // Load current list
      const raw = (db.prepare(
        "SELECT value FROM graph_state WHERE key = 'dismissed_projects'"
      ).get() as any)?.value;
      const dismissed: string[] = raw ? JSON.parse(raw) : [];

      if (!dismissed.includes(project)) {
        dismissed.push(project);
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('dismissed_projects', ?, datetime('now'))"
        ).run(JSON.stringify(dismissed));
      }

      // Delete any existing compiled pages for this project
      db.prepare("DELETE FROM compiled_pages WHERE subject_id = ?").run(project);

      res.json({ success: true, dismissed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get list of dismissed projects

  // Restore a dismissed project
  app.post("/api/restore-project", (req, res) => {
    try {
      const { project } = req.body;
      if (!project) { res.status(400).json({ error: "project required" }); return; }
      const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'dismissed_projects'" ).get() as any)?.value;
      const dismissed: string[] = raw ? JSON.parse(raw) : [];
      const updated = dismissed.filter(p => p !== project);
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('dismissed_projects', ?, datetime('now')").run(JSON.stringify(updated));
      res.json({ success: true, dismissed: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dismissed-projects', (req, res) => {
    try {
      const raw = (db.prepare(
        "SELECT value FROM graph_state WHERE key = 'dismissed_projects'"
      ).get() as any)?.value;
      const dismissed: string[] = raw ? JSON.parse(raw) : [];
      res.json({ projects: dismissed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/entity', async (req, res) => {
    try {
      const name = req.query.name as string;
      if (!name) { res.status(400).json({ error: 'name parameter required' }); return; }
      const { getEntityProfile } = await import('../entities.js');
      const profile = getEntityProfile(db, name);
      res.json(profile || { error: 'Entity not found' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Living Entity Profile — complete intelligence dossier ──
  app.get('/api/entity/:name', async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      if (!name) { res.status(400).json({ error: 'name parameter required' }); return; }
      const { getLivingProfile } = await import('../entities.js');
      const profile = getLivingProfile(db, name);
      if (!profile) { res.status(404).json({ error: 'Entity not found', query: name }); return; }
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Top Entities — mini-profiles for sidebar/list ──
  app.get('/api/entities/top', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 15, 50);
      const { getTopEntities } = await import('../entities.js');
      const entities = getTopEntities(db, limit);
      res.json({ entities, count: entities.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Meeting Prep API — assembles intelligence brief for a meeting ──
  app.get('/api/meeting-prep/:eventTitle', async (req, res) => {
    try {
      const eventTitle = decodeURIComponent(req.params.eventTitle);
      const { getEntity, getEntityProfile } = await import('../entities.js');

      // 1. Find the calendar event matching this title
      const event = db.prepare(`
        SELECT title, summary, source_date, contacts, metadata, project
        FROM knowledge
        WHERE source = 'calendar' AND title LIKE ?
        ORDER BY source_date DESC LIMIT 1
      `).get(`%${eventTitle}%`) as any;

      // 2. Search knowledge base for the meeting title
      const topicResults = searchByText(db, eventTitle, 10);

      // 3. Extract attendee names from event or fallback to topic search contacts
      let attendeeNames: string[] = [];
      if (event) {
        const contacts = typeof event.contacts === 'string' ? JSON.parse(event.contacts || '[]') : (event.contacts || []);
        attendeeNames = contacts.filter((c: string) => !c.toLowerCase().includes('zach stock'));
      }
      if (attendeeNames.length === 0) {
        // Try extracting from topic results
        for (const r of topicResults.slice(0, 5)) {
          const contacts = typeof r.contacts === 'string' ? JSON.parse(r.contacts || '[]') : (r.contacts || []);
          for (const c of contacts) {
            if (!c.toLowerCase().includes('zach stock') && !attendeeNames.includes(c)) {
              attendeeNames.push(c);
            }
          }
        }
      }

      // 4. For each attendee, pull entity profile, recent items, commitments
      const attendees = attendeeNames.slice(0, 5).map((name: string) => {
        const profile = getEntityProfile(db, name);

        // Get last 5 knowledge items involving this person
        let recentItems: any[] = [];
        if (profile) {
          recentItems = db.prepare(`
            SELECT k.title, k.source, k.source_date, k.summary
            FROM knowledge_primary k
            JOIN entity_mentions em ON k.id = em.knowledge_item_id
            WHERE em.entity_id = ?
            ORDER BY k.source_date DESC LIMIT 5
          `).all(profile.id) as any[];
        }

        // Get commitments involving this person
        const commitments = db.prepare(`
          SELECT text, state, due_date FROM commitments
          WHERE (owner LIKE ? OR assigned_to LIKE ?)
            AND state IN ('active', 'overdue', 'detected')
        `).all(`%${name}%`, `%${name}%`) as any[];

        // Get last meeting notes (Otter/Fireflies)
        let lastMeetingNotes: any = null;
        if (profile) {
          lastMeetingNotes = db.prepare(`
            SELECT k.title, k.source_date, k.summary
            FROM knowledge_primary k
            JOIN entity_mentions em ON k.id = em.knowledge_item_id
            WHERE em.entity_id = ? AND k.source IN ('otter', 'fireflies', 'meeting-notes')
            ORDER BY k.source_date DESC LIMIT 1
          `).get(profile.id) as any;
        }

        return {
          name,
          profile: profile ? {
            relationship_type: profile.user_label || profile.relationship_type,
            email: profile.email,
            domain: profile.domain,
            status: profile.status,
            days_since: profile.days_since,
            mention_count: profile.mention_count,
            projects: profile.projects,
          } : null,
          recent_items: recentItems.map((i: any) => ({
            title: i.title,
            source: i.source,
            date: i.source_date?.slice(0, 10),
            summary: i.summary?.slice(0, 200),
          })),
          commitments: commitments.map((c: any) => ({
            text: c.text,
            state: c.state,
            due_date: c.due_date,
          })),
          last_meeting_notes: lastMeetingNotes ? {
            title: lastMeetingNotes.title,
            date: lastMeetingNotes.source_date?.slice(0, 10),
            summary: lastMeetingNotes.summary?.slice(0, 300),
          } : null,
        };
      });

      // 5. Related knowledge items about this meeting/topic
      const relatedKnowledge = topicResults.slice(0, 5).map((r: any) => ({
        title: r.title,
        source: r.source,
        date: r.source_date?.slice(0, 10),
        summary: r.summary?.slice(0, 200),
      }));

      res.json({
        event_title: eventTitle,
        event_time: event?.source_date || null,
        event_summary: event?.summary || null,
        attendees,
        related_knowledge: relatedKnowledge,
        attendee_count: attendees.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Simulation Room ───────────────────────────────────────
  // Practice conversations with simulated counterparties.
  // Builds persona from entity intelligence in the knowledge base.
  // ────────────────────────────────────────────────────────────

  app.post('/api/simulate', async (req, res) => {
    try {
      const { entity, scenario, message, reset } = req.body;
      if (!entity || !scenario) {
        res.status(400).json({ error: 'entity and scenario are required' });
        return;
      }

      const { runSimulation, resetSimulation } = await import('../simulation.js');

      // Allow resetting a simulation to start fresh
      if (reset) {
        resetSimulation(db, entity);
      }

      const result = await runSimulation(db, entity, scenario, message);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stripe Webhook ─────────────────────────────────────────
  // Handles checkout.session.completed, customer.subscription.deleted,
  // and invoice.payment_failed for managed installation customers.
  // Stripe sends raw body — we parse JSON ourselves for signature verification later.
  // ────────────────────────────────────────────────────────────
  app.post('/api/stripe/webhook', async (req, res) => {
    try {
      const event = req.body;
      if (!event || !event.type) {
        res.status(400).json({ error: 'Invalid webhook payload' });
        return;
      }

      const eventType = event.type as string;

      if (eventType === 'checkout.session.completed') {
        const session = event.data?.object;
        if (!session) {
          res.status(400).json({ error: 'Missing session data' });
          return;
        }

        const customerId = uuid();
        const apiKey = `prime_${uuid().replace(/-/g, '')}`;
        const trialEnd = new Date(Date.now() + 14 * 86400000).toISOString();

        db.prepare(`
          INSERT OR IGNORE INTO customers (id, email, name, stripe_customer_id, stripe_subscription_id, plan, status, trial_ends_at, api_key)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(
          customerId,
          session.customer_email || session.customer_details?.email || '',
          session.customer_details?.name || null,
          session.customer || null,
          session.subscription || null,
          session.metadata?.plan || 'professional',
          trialEnd,
          apiKey
        );

        console.log(`[stripe] New customer: ${session.customer_email} (${customerId})`);
        res.json({ ok: true, event: eventType, customer_id: customerId });

      } else if (eventType === 'customer.subscription.deleted') {
        const subscription = event.data?.object;
        if (subscription?.id) {
          db.prepare(`UPDATE customers SET status = 'cancelled' WHERE stripe_subscription_id = ?`).run(subscription.id);
          console.log(`[stripe] Subscription cancelled: ${subscription.id}`);
        }
        res.json({ ok: true, event: eventType });

      } else if (eventType === 'invoice.payment_failed') {
        const invoice = event.data?.object;
        if (invoice?.customer) {
          db.prepare(`UPDATE customers SET status = 'past_due' WHERE stripe_customer_id = ?`).run(invoice.customer);
          console.log(`[stripe] Payment failed for customer: ${invoice.customer}`);
        }
        res.json({ ok: true, event: eventType });

      } else {
        // Unhandled event type — acknowledge receipt
        res.json({ ok: true, event: eventType, handled: false });
      }
    } catch (err: any) {
      console.error(`[stripe] Webhook error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── API Key Authentication ────────────────────────────────
  // Validates customer API keys for managed installation access.
  // ──────────────────────────────────────────────────────────
  app.post('/api/v1/auth/key', (req, res) => {
    try {
      const { api_key } = req.body;
      if (!api_key) {
        res.status(400).json({ error: 'api_key required' });
        return;
      }

      const customer = db.prepare(`
        SELECT id, email, name, plan, status, trial_ends_at, created_at
        FROM customers WHERE api_key = ? AND status IN ('active', 'trial')
      `).get(api_key) as any;

      if (!customer) {
        res.status(401).json({ error: 'Invalid or inactive API key' });
        return;
      }

      // Check trial expiration
      if (customer.status === 'trial' && customer.trial_ends_at) {
        if (new Date(customer.trial_ends_at) < new Date()) {
          db.prepare(`UPDATE customers SET status = 'cancelled' WHERE id = ?`).run(customer.id);
          res.status(401).json({ error: 'Trial expired' });
          return;
        }
      }

      res.json({ valid: true, customer });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API key middleware for /api/v1/* routes (commercial mode only)
  // In personal mode (PRIME_MODE !== 'cloud'), skip API key validation
  app.use('/api/v1', (req, res, next) => {
    if (req.path === '/auth/key') return next();
    if (process.env.PRIME_MODE !== 'cloud') return next(); // personal mode — no auth needed

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!apiKey) {
      res.status(401).json({ error: 'API key required. Pass via x-api-key header.' });
      return;
    }

    const customer = db.prepare(`
      SELECT id, email, plan, status, trial_ends_at FROM customers WHERE api_key = ?
    `).get(apiKey) as any;

    if (!customer || !['active', 'trial'].includes(customer.status)) {
      res.status(401).json({ error: 'Invalid or inactive API key' });
      return;
    }

    if (customer.status === 'trial' && customer.trial_ends_at && new Date(customer.trial_ends_at) < new Date()) {
      res.status(401).json({ error: 'Trial expired' });
      return;
    }

    // Attach customer to request for downstream use
    (req as any).customer = customer;
    next();
  });

  // ── Mount MCP over HTTP for claude.ai remote access ──
  try {
    const { mountMcpHttp } = await import('./mcp-http.js');
    mountMcpHttp(app);
  } catch (err: any) {
    console.log(`  MCP HTTP mount failed: ${err.message?.slice(0, 100)}`);
  }

  app.listen(port, '0.0.0.0', () => {
    const stats = getStats(db);
    console.log(`\n⚡ Prime server running on http://0.0.0.0:${port}`);
    console.log(`  Knowledge base: ${stats.total_items} items\n`);
    console.log('  Endpoints:');
    console.log('    POST /api/search    — Semantic search');
    console.log('    POST /api/ask       — AI conversation');
    console.log('    POST /api/ingest    — Add knowledge');
    console.log('    POST /api/remember  — Quick capture');
    console.log('    GET  /api/status    — Knowledge base stats');
    console.log('    GET  /api/query/*   — Structured queries');
    console.log('    ALL  /mcp           — MCP over HTTP (for remote Claude Desktop)');
    console.log('    POST /api/webhooks/otter — Otter.ai webhook');
    console.log('    POST /api/simulate   — Simulation Room (practice conversations)');
    console.log('    POST /api/stripe/webhook — Stripe webhook');
    console.log('    POST /api/v1/auth/key    — API key validation\n');

    if (options.sync !== false) {
      startScheduler(options.syncInterval || 15);
    }
  });
}
