import type { Database as SqlJsDatabase } from 'sql.js';
import { getConfig, searchByText, searchByEmbedding } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { getDefaultProvider } from './providers.js';

// ============================================================
// Shared helpers
// ============================================================

function queryRows(db: SqlJsDatabase, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

function parseJson(value: any): any {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch {} }
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
}

export function getAlerts(db: SqlJsDatabase): AlertItem[] {
  const alerts: AlertItem[] = [];
  const allItems = queryRows(db, `SELECT * FROM knowledge ORDER BY source_date DESC`, []);
  const now = new Date();

  // 1. Dropped balls — people waiting on you
  for (const item of allItems) {
    const meta = item.metadata || {};
    const tags = item.tags || [];
    if ((meta.waiting_on_user || tags.includes('awaiting_reply')) && meta.days_since_last > 7) {
      const contacts = item.contacts || [];
      alerts.push({
        type: 'dropped_ball',
        severity: meta.days_since_last > 21 ? 'critical' : meta.days_since_last > 14 ? 'high' : 'normal',
        title: `${contacts.join(', ') || 'Someone'} waiting on your reply`,
        detail: `"${item.title}" — ${meta.days_since_last} days with no response`,
        contact: contacts[0],
        project: item.project,
        daysSince: meta.days_since_last,
        source_ref: item.source_ref,
        conversation_uuid: meta.conversation_uuid || meta.thread_id,
      });
    }
  }

  // 2. Overdue commitments
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
          });
        }
      }
    }
  } catch {
    // commitments table might not exist
  }

  // 3. Cold relationships — important contacts going silent
  const contactMap = new Map<string, { count: number; lastDate: string }>();
  for (const item of allItems) {
    for (const name of (item.contacts || [])) {
      const existing = contactMap.get(name) || { count: 0, lastDate: '' };
      existing.count++;
      if (item.source_date && item.source_date > existing.lastDate) {
        existing.lastDate = item.source_date;
      }
      contactMap.set(name, existing);
    }
  }

  for (const [name, data] of contactMap) {
    if (data.count >= 3 && data.lastDate) {
      const days = daysBetween(data.lastDate);
      if (days > 14) {
        alerts.push({
          type: 'cold_relationship',
          severity: days > 30 ? 'high' : 'normal',
          title: `${name} going cold`,
          detail: `Last interaction ${days}d ago (${data.count} total mentions)`,
          contact: name,
          daysSince: days,
        });
      }
    }
  }

  // Sort: critical first, then high, then normal
  const severityOrder = { critical: 0, high: 1, normal: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return alerts;
}

// ============================================================
// PREP — meeting/person intelligence dossier
// ============================================================

export async function generatePrep(
  db: SqlJsDatabase,
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
  db: SqlJsDatabase,
  options: { days?: number } = {}
): Promise<string> {
  const days = options.days ?? 3;
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const items = queryRows(db, `SELECT * FROM knowledge WHERE source_date >= ? ORDER BY source_date DESC`, [cutoff]);

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

Generate a catch-up briefing:

1. EXECUTIVE SUMMARY — 3-4 sentences on what happened
2. BY PROJECT — What moved forward on each project/deal
3. PEOPLE — Who was involved, any new contacts, relationship updates
4. COMMITMENTS — What was promised during this period
5. DECISIONS — What was decided
6. NEEDS YOUR ATTENTION — What's waiting on you or requires action
7. WHAT'S NEXT — Recommended priorities

Be specific. Reference source numbers. Prioritize by business impact.`;

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

export function getRelationshipHealth(db: SqlJsDatabase): ContactHealth[] {
  const allItems = queryRows(db, `SELECT * FROM knowledge ORDER BY source_date DESC`, []);

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
        if (c.toLowerCase().includes(name.toLowerCase()) || (item.contacts || []).includes(name)) {
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
  db: SqlJsDatabase,
  projectQuery: string,
): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  // Find all items for this project (text search + project field)
  const textResults = searchByText(db, projectQuery, 50);
  const projectItems = queryRows(db,
    `SELECT * FROM knowledge WHERE project LIKE ? ORDER BY source_date DESC`,
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
