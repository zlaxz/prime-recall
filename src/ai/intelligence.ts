import type Database from 'better-sqlite3';
import { getConfig, searchByText, searchByEmbedding } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { getDefaultProvider } from './providers.js';

// ============================================================
// Shared helpers
// ============================================================

function queryRows(db: Database.Database, sql: string, params: any[] = []): any[] {
  const rows = db.prepare(sql).all(...params) as any[];
  for (const row of rows) {
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch (_e) {}
      }
    }
  }
  return rows;
}

function parseJson(value: any): any {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (_e) {} }
  return [];
}

function daysBetween(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ============================================================
// ALERTS — what needs attention RIGHT NOW
// ============================================================

export interface AlertItem {
  type: 'dropped_ball' | 'overdue_commitment' | 'cold_relationship' | 'deadline_approaching';
  severity: 'critical' | 'high' | 'normal';
  title: string;
  detail: string;
  contact?: string;
  project?: string;
  daysSince?: number;
  source_ref?: string;
  conversation_uuid?: string;
  item_id?: string;
  confidence?: number;         // 0-1: how confident the system is this needs attention
  reasoning?: string;          // why this alert was surfaced (provenance)
}

// ── Entity filter sets (shared across alert functions) ─────────
interface EntityFilters {
  dismissedEntityIds: Set<string>;
  dismissedDomains: Set<string>;
  employeeEntityIds: Set<string>;
  noiseEntityIds: Set<string>;
}

function loadEntityFilters(db: Database.Database): EntityFilters {
  const filters: EntityFilters = {
    dismissedEntityIds: new Set(),
    dismissedDomains: new Set(),
    employeeEntityIds: new Set(),
    noiseEntityIds: new Set(),
  };

  try {
    // Dismissed entities
    const dismissed = db.prepare('SELECT id, domain FROM entities WHERE user_dismissed = 1').all() as any[];
    for (const d of dismissed) {
      filters.dismissedEntityIds.add(d.id);
      if (d.domain) filters.dismissedDomains.add(d.domain.toLowerCase());
    }

    // Dismissed domains from dismissals table
    const domainPatterns = db.prepare('SELECT domain FROM dismissals WHERE domain IS NOT NULL').all() as any[];
    for (const p of domainPatterns) filters.dismissedDomains.add(p.domain.toLowerCase());

    // Employee entities
    const employees = db.prepare(`
      SELECT id FROM entities
      WHERE (user_label = 'employee' OR relationship_type = 'employee') AND user_dismissed = 0
    `).all() as any[];
    for (const e of employees) filters.employeeEntityIds.add(e.id);

    // Noise entities
    const noise = db.prepare(`
      SELECT id FROM entities
      WHERE (user_label = 'noise' OR relationship_type = 'noise') AND user_dismissed = 0
    `).all() as any[];
    for (const n of noise) filters.noiseEntityIds.add(n.id);
  } catch (_e) {}

  return filters;
}

// ── Person-level context for dropped ball analysis ─────────────
interface PersonContext {
  entity_id: string;
  canonical_name: string;
  relationship_type: string | null;
  user_label: string | null;
  total_mentions: number;
  last_interaction: string | null;
  days_since_last: number;
  recent_7d_count: number;       // interactions in last 7 days (ANY channel)
  recent_14d_count: number;      // interactions in last 14 days
  avg_gap_days: number;          // typical gap between interactions
  has_calendar_event: boolean;   // met recently via calendar
  has_newer_thread: boolean;     // newer email thread exists (this person)
  open_threads: any[];           // the awaiting_reply items for this person
}

function buildPersonContexts(db: Database.Database, filters: EntityFilters): Map<string, PersonContext> {
  const contexts = new Map<string, PersonContext>();
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 86400000).toISOString();

  // Get all awaiting_reply items — PRIMARY SOURCES ONLY (belief system: no agent reports)
  const awaitingItems = queryRows(db, `
    SELECT * FROM knowledge_primary
    WHERE tags LIKE '%awaiting_reply%'
    ORDER BY source_date DESC
  `, []);

  // For each item, resolve the sender to an entity and group
  for (const item of awaitingItems) {
    const meta = item.metadata || {};
    if (meta.user_replied) continue;

    // Resolve sender to entity
    let entityId: string | null = null;
    let entityName: string | null = null;

    if (meta.last_from) {
      const lastFrom = meta.last_from as string;
      const emailMatch = lastFrom.match(/<([^>]+)>/) || lastFrom.match(/([^\s]+@[^\s]+)/);
      const email = emailMatch ? emailMatch[1].toLowerCase() : null;

      // Try email lookup
      if (email) {
        try {
          const entity = db.prepare('SELECT id, canonical_name, user_label, relationship_type, domain FROM entities WHERE email = ?').get(email) as any;
          if (entity) {
            entityId = entity.id;
            entityName = entity.canonical_name;
          }
        } catch (_e) {}

        // Check dismissed domain
        if (!entityId) {
          const domain = email.split('@')[1];
          if (domain && filters.dismissedDomains.has(domain)) continue;
        }
      }
    }

    // Fallback: try to match via contacts list
    if (!entityId) {
      const contacts = (item.contacts || []).filter((c: string) => c && !c.toLowerCase().includes('zach stock'));
      if (contacts.length === 0) continue;

      for (const contactName of contacts) {
        try {
          const normalized = contactName.toLowerCase().replace(/[^a-z\s-]/g, '').trim();
          const alias = db.prepare('SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?').get(normalized) as any;
          if (alias) {
            const entity = db.prepare('SELECT id, canonical_name FROM entities WHERE id = ?').get(alias.entity_id) as any;
            if (entity) {
              entityId = entity.id;
              entityName = entity.canonical_name;
              break;
            }
          }
        } catch (_e) {}
      }

      // Still no entity — use first non-self contact as key
      if (!entityId) {
        entityName = contacts[0] || 'unknown';
        entityId = `unresolved:${entityName!.toLowerCase()}`;
      }
    }

    // Skip filtered entities
    if (entityId && !entityId.startsWith('unresolved:')) {
      if (filters.dismissedEntityIds.has(entityId)) continue;
      if (filters.employeeEntityIds.has(entityId)) continue;
      if (filters.noiseEntityIds.has(entityId)) continue;
    }

    // Build or update person context
    if (!contexts.has(entityId!)) {
      let totalMentions = 0;
      let lastInteraction: string | null = null;
      let recent7d = 0;
      let recent14d = 0;
      let avgGap = 0;
      let hasCalendar = false;
      let hasNewerThread = false;
      let relType: string | null = null;
      let userLabel: string | null = null;

      if (entityId && !entityId.startsWith('unresolved:')) {
        try {
          // Get full interaction stats from entity_mentions
          const stats = db.prepare(`
            SELECT COUNT(*) as total,
              MAX(mention_date) as last_seen,
              SUM(CASE WHEN mention_date >= ? THEN 1 ELSE 0 END) as recent_7d,
              SUM(CASE WHEN mention_date >= ? THEN 1 ELSE 0 END) as recent_14d
            FROM entity_mentions WHERE entity_id = ?
          `).get(sevenDaysAgo, fourteenDaysAgo, entityId) as any;

          totalMentions = stats?.total || 0;
          lastInteraction = stats?.last_seen || null;
          recent7d = stats?.recent_7d || 0;
          recent14d = stats?.recent_14d || 0;

          // Calculate avg gap from mention dates
          const dates = (db.prepare(
            'SELECT mention_date FROM entity_mentions WHERE entity_id = ? AND mention_date IS NOT NULL ORDER BY mention_date ASC'
          ).all(entityId) as any[]).map(r => new Date(r.mention_date).getTime());

          if (dates.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < dates.length; i++) {
              gaps.push((dates[i] - dates[i - 1]) / 86400000);
            }
            avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
          }

          // Check for calendar events with this person (resolution evidence)
          hasCalendar = !!(db.prepare(`
            SELECT 1 FROM knowledge_primary k
            JOIN entity_mentions em ON k.id = em.knowledge_item_id
            WHERE em.entity_id = ? AND k.source = 'calendar'
              AND k.source_date >= ?
            LIMIT 1
          `).get(entityId, fourteenDaysAgo));

          // Check for newer email threads (not awaiting) with this person
          hasNewerThread = !!(db.prepare(`
            SELECT 1 FROM knowledge_primary k
            JOIN entity_mentions em ON k.id = em.knowledge_item_id
            WHERE em.entity_id = ? AND k.source IN ('gmail', 'gmail-sent')
              AND k.tags NOT LIKE '%awaiting_reply%'
              AND k.source_date >= ?
            LIMIT 1
          `).get(entityId, fourteenDaysAgo));

          // Get relationship type
          const entityRow = db.prepare('SELECT relationship_type, user_label FROM entities WHERE id = ?').get(entityId) as any;
          relType = entityRow?.relationship_type;
          userLabel = entityRow?.user_label;
        } catch (_e) {}
      }

      contexts.set(entityId!, {
        entity_id: entityId!,
        canonical_name: entityName!,
        relationship_type: relType,
        user_label: userLabel,
        total_mentions: totalMentions,
        last_interaction: lastInteraction,
        days_since_last: lastInteraction ? daysBetween(lastInteraction) : 999,
        recent_7d_count: recent7d,
        recent_14d_count: recent14d,
        avg_gap_days: avgGap,
        has_calendar_event: hasCalendar,
        has_newer_thread: hasNewerThread,
        open_threads: [],
      });
    }

    contexts.get(entityId!)!.open_threads.push(item);
  }

  return contexts;
}

export function getAlerts(db: Database.Database): AlertItem[] {
  const alerts: AlertItem[] = [];
  const now = new Date();
  const filters = loadEntityFilters(db);

  // ── 1. Person-level dropped balls ────────────────────────────
  // TWO-LAYER ARCHITECTURE:
  //   Layer 1 (primary): Entity understanding profiles — pre-computed deep analysis
  //   Layer 2 (fallback): Real-time heuristics for entities without profiles
  //
  // The dream pipeline builds entity_profiles with rich understanding of each
  // relationship. Real-time getAlerts() just reads the verdict. No guessing.

  const personContexts = buildPersonContexts(db, filters);

  for (const [entityId, person] of personContexts) {
    // Skip self
    if (/zach(ary)?\s*(d\.?\s*)?stock/i.test(person.canonical_name)) continue;

    const threads = person.open_threads;
    if (threads.length === 0) continue;

    // ── Layer 1: Check entity profile (pre-computed understanding) ──
    // If the entity has a profile with a verdict, USE IT. Don't second-guess.
    let profileUsed = false;
    if (entityId && !entityId.startsWith('unresolved:')) {
      try {
        const profile = db.prepare(
          'SELECT alert_verdict, verdict_reasoning, verdict_confidence, communication_nature, reply_expectation, importance_to_business FROM entity_profiles WHERE entity_id = ?'
        ).get(entityId) as any;

        if (profile && profile.alert_verdict !== 'pending') {
          profileUsed = true;

          if (profile.alert_verdict === 'suppress') {
            continue; // Profile says suppress — done
          }

          if (profile.alert_verdict === 'surface') {
            // Profile says surface — build the alert from profile intelligence
            const mostImportant = threads[0]; // already sorted by date desc
            const meta = mostImportant.metadata || {};
            const threadAge = mostImportant.source_date ? daysBetween(mostImportant.source_date) : 0;
            const projects = [...new Set(threads.map((t: any) => t.project).filter(Boolean))];

            // Still apply real-time activity check — profile might be stale
            if (person.recent_7d_count > 0) continue;
            if (person.has_calendar_event) continue;
            if (person.has_newer_thread) continue;

            let severity: AlertItem['severity'];
            if (profile.importance_to_business === 'critical' || profile.importance_to_business === 'high') {
              severity = threadAge > 14 ? 'critical' : threadAge > 7 ? 'high' : 'normal';
            } else {
              severity = threadAge > 30 ? 'high' : 'normal';
            }

            alerts.push({
              type: 'dropped_ball',
              severity,
              title: `${person.canonical_name} — ${threads.length} open thread${threads.length > 1 ? 's' : ''}`,
              detail: `"${mostImportant.title}" — ${threadAge}d [${profile.communication_nature}, ${profile.reply_expectation} reply expected]`,
              contact: person.canonical_name,
              project: projects[0] || mostImportant.project,
              daysSince: threadAge,
              source_ref: mostImportant.source_ref,
              conversation_uuid: meta.conversation_uuid || meta.thread_id,
              item_id: mostImportant.id,
              confidence: profile.verdict_confidence,
              reasoning: profile.verdict_reasoning,
            });
          }
        }
      } catch (_e) {}
    }

    // ── Layer 2: Real-time heuristics (no profile available) ────────
    // Conservative: when we DON'T understand the entity, default to SILENCE
    if (profileUsed) continue;

    // Activity filters
    if (person.recent_7d_count > 0) continue;
    if (person.has_calendar_event) continue;
    if (person.has_newer_thread) continue;
    if (person.total_mentions <= 2) continue;

    // Cadence check
    if (person.avg_gap_days > 0) {
      const oldestThread = threads[threads.length - 1];
      const threadAge = oldestThread?.source_date ? daysBetween(oldestThread.source_date) : 0;
      if (threadAge < person.avg_gap_days * 2) continue;
    }

    // Without a profile, ONLY surface if there's strong evidence this matters:
    // - User has explicitly labeled this person as important
    // - Multiple open threads (pattern of unanswered communication)
    // - Recent threads (not ancient history)
    const relType = person.user_label || person.relationship_type;
    const oldestThread = threads[threads.length - 1];
    const oldestAge = oldestThread?.source_date ? daysBetween(oldestThread.source_date) : 0;

    // Without profile + without user label = don't alert (selective silence)
    // The dream pipeline will build a profile and THEN decide
    if (!relType || relType === 'vendor' || relType === 'noise') continue;

    // Ancient threads without follow-up = dead
    if (oldestAge > 45) continue;

    // Only surface for explicitly important relationships (user-verified)
    if (relType !== 'partner' && relType !== 'client' && relType !== 'advisor') continue;

    const mostImportant = threads[0];
    const meta = mostImportant.metadata || {};
    const threadAge = mostImportant.source_date ? daysBetween(mostImportant.source_date) : 0;
    const projects = [...new Set(threads.map((t: any) => t.project).filter(Boolean))];

    alerts.push({
      type: 'dropped_ball',
      severity: threadAge > 14 ? 'critical' : threadAge > 7 ? 'high' : 'normal',
      title: `${person.canonical_name} — ${threads.length} open thread${threads.length > 1 ? 's' : ''}`,
      detail: `"${mostImportant.title}" — ${threadAge}d [${relType}, no profile yet]`,
      contact: person.canonical_name,
      project: projects[0] || mostImportant.project,
      daysSince: threadAge,
      source_ref: mostImportant.source_ref,
      conversation_uuid: meta.conversation_uuid || meta.thread_id,
      item_id: mostImportant.id,
      confidence: 0.6,
      reasoning: `User-labeled ${relType}. No entity profile yet — run dream pipeline for deeper analysis.`,
    });
  }

  // ── 2. Overdue commitments ────────────────────────────────
  try {
    const commitments = queryRows(db, `SELECT * FROM commitments WHERE state IN ('overdue', 'active')`, []);
    for (const c of commitments) {
      if (c.due_date && new Date(c.due_date) < now) {
        const daysOverdue = daysBetween(c.due_date);
        alerts.push({
          type: 'overdue_commitment',
          severity: daysOverdue > 7 ? 'critical' : daysOverdue > 3 ? 'high' : 'normal',
          title: `Overdue: ${c.text}`,
          detail: `Due ${c.due_date} (${daysOverdue}d ago)${c.project ? ` — ${c.project}` : ''}`,
          project: c.project,
          daysSince: daysOverdue,
          confidence: 0.9,
          reasoning: 'Commitment past due date',
        });
      } else if (c.due_date) {
        const daysUntil = -daysBetween(c.due_date);
        if (daysUntil <= 3) {
          alerts.push({
            type: 'deadline_approaching',
            severity: daysUntil <= 1 ? 'high' : 'normal',
            title: `Due ${daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : `in ${daysUntil} days`}: ${c.text}`,
            detail: `Due ${c.due_date}${c.project ? ` — ${c.project}` : ''}`,
            project: c.project,
            daysSince: -daysUntil,
            confidence: 0.95,
            reasoning: 'Approaching deadline',
          });
        }
      }
    }
  } catch (_e) {}

  // ── 3. Cold relationships ─────────────────────────────────
  // Only alert on relationships that WERE active and went cold — not one-offs
  try {
    const coldEntities = db.prepare(`
      SELECT e.id, e.canonical_name, e.relationship_type, e.user_label,
        COUNT(em.id) as mentions,
        MAX(em.mention_date) as last_seen,
        SUM(CASE WHEN em.mention_date >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as recent_30d
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.type = 'person' AND e.user_dismissed = 0
        AND e.canonical_name != 'Zach Stock'
        AND (e.user_label IS NULL OR e.user_label NOT IN ('employee', 'noise'))
        AND (e.relationship_type IS NULL OR e.relationship_type NOT IN ('employee', 'noise'))
      GROUP BY e.id
      HAVING mentions >= 5 AND recent_30d = 0
    `).all() as any[];

    for (const e of coldEntities) {
      if (!e.last_seen) continue;
      const days = daysBetween(e.last_seen);
      if (days <= 14) continue;

      // Check if this person has a known communication cadence
      // Only alert if the gap is abnormal for this relationship
      const relType = e.user_label || e.relationship_type;
      // Machines and strangers cannot "go cold" — newsletters with hundreds of
      // mentions were burying real signals (connector audit 2026-09-08: 40 of
      // 56 alerts were automated senders).
      if (relType === 'automated' || relType === 'cold_outreach' || relType === 'unknown') continue;
      const isImportant = relType === 'partner' || relType === 'client' || relType === 'advisor';

      // Unclassified contacts need a real relationship footprint before a
      // silence is worth an alert.
      if (!isImportant && (e.mentions < 15 || days <= 21)) continue;

      let confidence = 0.5;
      let reasoning = '';
      if (isImportant) {
        confidence += 0.2;
        reasoning += `${relType} relationship. `;
      }
      if (e.mentions >= 15) {
        confidence += 0.1;
        reasoning += `${e.mentions} total interactions. `;
      }
      reasoning += `${days}d silence after active communication.`;

      alerts.push({
        type: 'cold_relationship',
        severity: isImportant && days > 21 ? 'high' : days > 30 ? 'high' : 'normal',
        title: `${e.canonical_name} going cold`,
        detail: `${days}d since last interaction (${e.mentions} total, ${relType || 'unclassified'})`,
        contact: e.canonical_name,
        daysSince: days,
        confidence: Math.min(confidence, 1.0),
        reasoning: reasoning.trim(),
      });
    }
  } catch (_e) {}

  // Sort: severity first, then confidence descending
  const severityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2 };
  alerts.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  return alerts;
}

// ============================================================
// PREP — meeting/person intelligence dossier
// ============================================================

export async function generatePrep(
  db: Database.Database,
  query: string,
): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  // Multi-strategy search: semantic + text
  let items: any[] = [];
  if (apiKey) {
    try {
      const emb = await generateEmbedding(query, apiKey);
      items = searchByEmbedding(db, emb, 20, 0.25);
    } catch {
      items = searchByText(db, query, 20);
    }
  } else {
    items = searchByText(db, query, 20);
  }

  // Also text search for exact matches
  const textResults = searchByText(db, query, 15);
  for (const tr of textResults) {
    if (!items.find((r: any) => r.id === tr.id)) items.push(tr);
  }

  if (items.length === 0) return `No information found for "${query}".`;

  // Build context
  const itemSummaries = items.map((item: any, i: number) => {
    const contacts = item.contacts || [];
    const commitments = item.commitments || [];
    const decisions = item.decisions || [];
    const meta = item.metadata || {};
    const age = item.source_date ? `${daysBetween(item.source_date)}d ago` : '';

    let entry = `[${i + 1}] (${item.source}) ${item.title} ${age}`;
    entry += `\n   ${item.summary}`;
    if (contacts.length) entry += `\n   People: ${contacts.join(', ')}`;
    if (decisions.length) entry += `\n   Decisions: ${decisions.join('; ')}`;
    if (commitments.length) entry += `\n   Commitments: ${commitments.join('; ')}`;
    if (item.project) entry += `\n   Project: ${item.project}`;
    if (meta.conversation_uuid) entry += `\n   [Claude conversation]`;
    if (meta.thread_id) entry += `\n   [Email thread]`;
    return entry;
  }).join('\n\n');

  const prompt = `You are Prime Recall, an AI Chief of Staff. Generate an intelligence prep dossier for: "${query}"

${businessContext ? `BUSINESS CONTEXT: ${businessContext}\n` : ''}
KNOWLEDGE BASE (${items.length} sources):

${itemSummaries}

Generate a comprehensive prep with these sections:

1. OVERVIEW — Who/what is this, and why it matters to the user's business
2. RELATIONSHIP HISTORY — Every interaction (emails, conversations, meetings) in chronological order
3. KEY DECISIONS MADE — What's been decided about this topic/person
4. OUTSTANDING COMMITMENTS — What's been promised, by whom, by when
5. CURRENT STATUS — Where things stand right now
6. OPEN QUESTIONS — What's unresolved or unclear
7. RECOMMENDED TALKING POINTS — If meeting this person, what to discuss
8. CONNECTIONS — Other people/projects/deals linked to this topic

Be specific. Use real names, dates, and cite source numbers [1], [2], etc.
If this is a person, focus on the relationship. If it's a project/deal, focus on status and next steps.`;

  return await provider.chat(
    [
      { role: 'system', content: 'You are Prime Recall, an AI Chief of Staff that generates intelligence dossiers.' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3, max_tokens: 3000 }
  );
}

// ============================================================
// CATCHUP — what happened while you were away
// ============================================================

export async function generateCatchup(
  db: Database.Database,
  options: { days?: number } = {}
): Promise<string> {
  const days = options.days ?? 3;
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const items = queryRows(db, `SELECT * FROM knowledge_primary WHERE source_date >= ? ORDER BY source_date DESC`, [cutoff]);

  if (items.length === 0) return `Nothing new in the last ${days} days.`;

  // Group by source
  const bySource = new Map<string, any[]>();
  for (const item of items) {
    const src = item.source as string;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(item);
  }

  // Group by project
  const byProject = new Map<string, any[]>();
  for (const item of items) {
    const proj = (item.project as string) || '(unassigned)';
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj)!.push(item);
  }

  // Collect all commitments and decisions
  const allCommitments: string[] = [];
  const allDecisions: string[] = [];
  const allContacts = new Set<string>();
  for (const item of items) {
    for (const c of (item.commitments || [])) allCommitments.push(`${c} (${item.title})`);
    for (const d of (item.decisions || [])) allDecisions.push(`${d} (${item.title})`);
    for (const n of (item.contacts || [])) allContacts.add(n);
  }

  const sourceSummary = Array.from(bySource.entries())
    .map(([src, items]) => `  ${src}: ${items.length} items`)
    .join('\n');

  const projectSummary = Array.from(byProject.entries())
    .map(([proj, items]) => {
      const titles = items.slice(0, 5).map(i => `    - ${i.title}`).join('\n');
      return `  ${proj} (${items.length} items):\n${titles}`;
    })
    .join('\n');

  const itemDetails = items.slice(0, 40).map((item: any, i: number) => {
    const age = item.source_date ? `${daysBetween(item.source_date)}d ago` : '';
    return `[${i + 1}] (${item.source}) ${item.title} ${age}\n   ${item.summary}`;
  }).join('\n\n');

  const prompt = `You are Prime Recall. The user has been away and needs a catch-up briefing for the last ${days} days.

${businessContext ? `BUSINESS CONTEXT: ${businessContext}\n` : ''}
ACTIVITY SUMMARY:
- ${items.length} new knowledge items
- Sources:\n${sourceSummary}
- Projects:\n${projectSummary}
- People involved: ${Array.from(allContacts).join(', ') || 'none detected'}
- New commitments: ${allCommitments.length}
- New decisions: ${allDecisions.length}

DETAILS:
${itemDetails}

${allCommitments.length > 0 ? '\nCOMMITMENTS MADE:\n' + allCommitments.map(c => `- ${c}`).join('\n') : ''}
${allDecisions.length > 0 ? '\nDECISIONS MADE:\n' + allDecisions.map(d => `- ${d}`).join('\n') : ''}

Generate a catch-up briefing. The user has ADHD — structure for quick scanning, lead with GOOD NEWS.

1. RESOLVED WITHOUT YOU (good news first — reduces shame/overwhelm):
   - Things that got handled, commitments fulfilled, threads closed
   - This section exists to say "the world didn't end while you were away"

2. STILL NEEDS YOU (keep this SHORT — count items):
   - Numbered list, max 5 items
   - Each with one clear action: [RESPOND / DRAFT / DEFER / DISMISS]
   - Cite source numbers

3. NOTHING ELSE IS ON FIRE (or: "X items can wait")
   - Explicitly reassure: "Everything else is routine" or "3 items can wait until next week"

4. BY PROJECT (optional — only if user asks "tell me more"):
   - Brief status per active project

Be specific. Reference source numbers. Lead with good news. Keep "STILL NEEDS YOU" under 5 items.`;

  return await provider.chat(
    [
      { role: 'system', content: 'You are Prime Recall, generating a catch-up briefing for someone returning after time away.' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3, max_tokens: 3000 }
  );
}

// ============================================================
// RELATIONSHIPS — contact health dashboard
// ============================================================

export interface ContactHealth {
  name: string;
  mentions: number;
  lastSeen: string;
  daysSince: number;
  sources: string[];
  projects: string[];
  status: 'active' | 'warm' | 'cooling' | 'cold' | 'dormant';
  commitments: string[];
}

export function getRelationshipHealth(db: Database.Database): ContactHealth[] {
  const allItems = queryRows(db, `SELECT * FROM knowledge_primary ORDER BY source_date DESC`, []);

  const contactMap = new Map<string, {
    mentions: number;
    lastDate: string;
    sources: Set<string>;
    projects: Set<string>;
    commitments: string[];
  }>();

  for (const item of allItems) {
    for (const name of (item.contacts || [])) {
      const existing = contactMap.get(name) || {
        mentions: 0, lastDate: '', sources: new Set(), projects: new Set(), commitments: [],
      };
      existing.mentions++;
      if (item.source_date && item.source_date > existing.lastDate) {
        existing.lastDate = item.source_date;
      }
      existing.sources.add(item.source);
      if (item.project) existing.projects.add(item.project);
      for (const c of (item.commitments || [])) {
        if ((c && c.toLowerCase().includes(name.toLowerCase())) || (item.contacts || []).includes(name)) {
          existing.commitments.push(c);
        }
      }
      contactMap.set(name, existing);
    }
  }

  const contacts: ContactHealth[] = [];
  for (const [name, data] of contactMap) {
    if (data.mentions < 2) continue; // Filter noise
    const days = data.lastDate ? daysBetween(data.lastDate) : 999;
    let status: ContactHealth['status'];
    if (days <= 3) status = 'active';
    else if (days <= 7) status = 'warm';
    else if (days <= 14) status = 'cooling';
    else if (days <= 30) status = 'cold';
    else status = 'dormant';

    contacts.push({
      name,
      mentions: data.mentions,
      lastSeen: data.lastDate,
      daysSince: days,
      sources: Array.from(data.sources),
      projects: Array.from(data.projects),
      status,
      commitments: data.commitments.slice(0, 3),
    });
  }

  contacts.sort((a, b) => b.mentions - a.mentions);
  return contacts;
}

// ============================================================
// DEAL — project intelligence dossier
// ============================================================

export async function generateDealBrief(
  db: Database.Database,
  projectQuery: string,
): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  // Find all items for this project (text search + project field)
  const textResults = searchByText(db, projectQuery, 50);
  const projectItems = queryRows(db,
    `SELECT * FROM knowledge_primary WHERE project LIKE ? ORDER BY source_date DESC`,
    [`%${projectQuery}%`]
  );

  // Merge and deduplicate
  const seen = new Set<string>();
  const allItems: any[] = [];
  for (const item of [...projectItems, ...textResults]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      allItems.push(item);
    }
  }

  if (allItems.length === 0) return `No information found for project "${projectQuery}".`;

  // Collect all people, decisions, commitments
  const people = new Map<string, number>();
  const allDecisions: string[] = [];
  const allCommitments: string[] = [];
  const sourceBreakdown = new Map<string, number>();

  for (const item of allItems) {
    for (const c of (item.contacts || [])) people.set(c, (people.get(c) || 0) + 1);
    for (const d of (item.decisions || [])) allDecisions.push(d);
    for (const c of (item.commitments || [])) allCommitments.push(c);
    const src = item.source as string;
    sourceBreakdown.set(src, (sourceBreakdown.get(src) || 0) + 1);
  }

  const itemDetails = allItems.slice(0, 30).map((item: any, i: number) => {
    const age = item.source_date ? `${daysBetween(item.source_date)}d ago` : '';
    const contacts = (item.contacts || []).join(', ');
    return `[${i + 1}] (${item.source}) ${item.title} ${age}${contacts ? ` — ${contacts}` : ''}\n   ${item.summary}`;
  }).join('\n\n');

  const prompt = `You are Prime Recall. Generate a comprehensive deal/project intelligence brief for: "${projectQuery}"

${businessContext ? `BUSINESS CONTEXT: ${businessContext}\n` : ''}
PROJECT DATA:
- ${allItems.length} total knowledge items
- Sources: ${Array.from(sourceBreakdown.entries()).map(([s, n]) => `${s}(${n})`).join(', ')}
- People involved: ${Array.from(people.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}(${c})`).join(', ')}
- Decisions: ${allDecisions.length}
- Commitments: ${allCommitments.length}

${allDecisions.length > 0 ? 'DECISIONS MADE:\n' + allDecisions.map(d => `- ${d}`).join('\n') + '\n' : ''}
${allCommitments.length > 0 ? 'COMMITMENTS:\n' + allCommitments.map(c => `- ${c}`).join('\n') + '\n' : ''}

DETAILED ITEMS:
${itemDetails}

Generate a deal intelligence brief:

1. EXECUTIVE SUMMARY — What this project/deal is, its current status, and strategic importance
2. KEY PEOPLE — Every person involved, their role, and last interaction
3. TIMELINE — Chronological history of major events
4. DECISIONS LOG — Every decision made, with context
5. OUTSTANDING COMMITMENTS — Who owes what to whom, and deadlines
6. CURRENT STATUS — Where things stand RIGHT NOW
7. RISKS & BLOCKERS — What could go wrong, what's stalled
8. RECOMMENDED NEXT STEPS — Prioritized actions
9. CONNECTIONS — How this project relates to other deals/projects

Be thorough. Cite sources with [N]. This is a reference document the user will use for decision-making.`;

  return await provider.chat(
    [
      { role: 'system', content: 'You are Prime Recall, generating a comprehensive deal intelligence brief.' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3, max_tokens: 4000 }
  );
}
