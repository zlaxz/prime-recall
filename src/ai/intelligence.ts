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
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
  }
  return rows;
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

export function getAlerts(db: Database.Database): AlertItem[] {
  const alerts: AlertItem[] = [];
  const now = new Date();

  // ── Build entity filters ──────────────────────────────────
  // Get dismissed entity names + domains
  const dismissedNames = new Set<string>();
  const dismissedDomains = new Set<string>();
  const employeeNames = new Set<string>();

  try {
    const dismissed = db.prepare('SELECT canonical_name, domain FROM entities WHERE user_dismissed = 1').all() as any[];
    for (const d of dismissed) {
      dismissedNames.add(d.canonical_name.toLowerCase());
      if (d.domain) dismissedDomains.add(d.domain.toLowerCase());
    }

    // Get all aliases for dismissed entities
    const dismissedAliases = db.prepare(`
      SELECT ea.alias_normalized FROM entity_aliases ea
      JOIN entities e ON ea.entity_id = e.id WHERE e.user_dismissed = 1
    `).all() as any[];
    for (const a of dismissedAliases) dismissedNames.add(a.alias_normalized);

    // Get dismissed patterns/domains from dismissals table
    const patterns = db.prepare('SELECT domain FROM dismissals WHERE domain IS NOT NULL').all() as any[];
    for (const p of patterns) dismissedDomains.add(p.domain.toLowerCase());

    // Get employee names (don't flag their emails as dropped balls)
    const employees = db.prepare(`
      SELECT canonical_name FROM entities
      WHERE (user_label = 'employee' OR relationship_type = 'employee') AND user_dismissed = 0
    `).all() as any[];
    for (const e of employees) employeeNames.add(e.canonical_name.toLowerCase());

    const employeeAliases = db.prepare(`
      SELECT ea.alias_normalized FROM entity_aliases ea
      JOIN entities e ON ea.entity_id = e.id
      WHERE (e.user_label = 'employee' OR e.relationship_type = 'employee') AND e.user_dismissed = 0
    `).all() as any[];
    for (const a of employeeAliases) employeeNames.add(a.alias_normalized);
  } catch {
    // Entity tables might not exist yet
  }

  // Helper: check if ALL contacts on an item are filtered out
  const shouldFilter = (contacts: string[]): boolean => {
    if (contacts.length === 0) return false;
    return contacts.every(c => {
      const lower = c.toLowerCase();
      const normalized = lower.replace(/[^a-z\s-]/g, '').trim();
      return dismissedNames.has(lower) || dismissedNames.has(normalized) ||
             employeeNames.has(lower) || employeeNames.has(normalized);
    });
  };

  // ── 1. Dropped balls — people waiting on you ──────────────
  const awaitingItems = queryRows(db, `
    SELECT * FROM knowledge
    WHERE tags LIKE '%awaiting_reply%'
    ORDER BY source_date ASC
  `, []);

  for (const item of awaitingItems) {
    const meta = item.metadata || {};
    if (meta.user_replied) continue; // already handled via sent mail

    const contacts = item.contacts || [];

    // Filter self
    const nonSelf = contacts.filter((c: string) => !c.toLowerCase().includes('zach stock'));
    if (nonSelf.length === 0) continue;

    // Check who sent LAST — if they're an employee or dismissed, skip
    if (meta.last_from) {
      const lastFromLower = (meta.last_from as string).toLowerCase();
      // Check if last sender is an employee
      const lastSenderIsEmployee = Array.from(employeeNames).some(name => lastFromLower.includes(name));
      if (lastSenderIsEmployee) continue;

      // Check if last sender is dismissed
      const lastSenderIsDismissed = Array.from(dismissedNames).some(name => lastFromLower.includes(name));
      if (lastSenderIsDismissed) continue;

      // Check domain dismissal
      const emailMatch = lastFromLower.match(/@([^\s>]+)/);
      if (emailMatch && dismissedDomains.has(emailMatch[1])) continue;
    }

    // Also check if ALL contacts are filtered (for non-Gmail sources without last_from)
    if (shouldFilter(nonSelf)) continue;

    const days = item.source_date ? daysBetween(item.source_date) : 0;
    if (days < 7) continue;

    alerts.push({
      type: 'dropped_ball',
      severity: days > 21 ? 'critical' : days > 14 ? 'high' : 'normal',
      title: `${nonSelf.join(', ')} waiting on your reply`,
      detail: `"${item.title}" — ${days}d`,
      contact: nonSelf[0],
      project: item.project,
      daysSince: days,
      source_ref: item.source_ref,
      conversation_uuid: meta.conversation_uuid || meta.thread_id,
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
  } catch {}

  // ── 3. Cold relationships (from entity graph, not raw scan) ──
  try {
    const coldEntities = db.prepare(`
      SELECT e.canonical_name, e.relationship_type, e.user_label,
        COUNT(em.id) as mentions,
        MAX(em.mention_date) as last_seen
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.type = 'person' AND e.user_dismissed = 0
        AND e.canonical_name != 'Zach Stock'
        AND (e.user_label IS NULL OR e.user_label NOT IN ('employee', 'noise'))
        AND (e.relationship_type IS NULL OR e.relationship_type NOT IN ('employee', 'noise'))
      GROUP BY e.id
      HAVING mentions >= 5
    `).all() as any[];

    for (const e of coldEntities) {
      if (!e.last_seen) continue;
      const days = daysBetween(e.last_seen);
      if (days > 14) {
        alerts.push({
          type: 'cold_relationship',
          severity: days > 30 ? 'high' : 'normal',
          title: `${e.canonical_name} going cold`,
          detail: `${days}d since last interaction (${e.mentions} mentions, ${e.user_label || e.relationship_type || 'unclassified'})`,
          contact: e.canonical_name,
          daysSince: days,
        });
      }
    }
  } catch {}

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2 };
  alerts.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

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
  db: Database.Database,
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
