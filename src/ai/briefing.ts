import type { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { getConfig, insertKnowledge, getCommitments, type KnowledgeItem } from '../db.js';
import { getDefaultProvider } from './providers.js';

export interface BriefingResult {
  briefing: string;
  date: string;
  meta: {
    itemsAnalyzed: number;
    droppedBalls: number;
    coldRelationships: number;
    activeCommitments: number;
    calendarEvents: number;
  };
}

export async function generateBriefing(
  db: SqlJsDatabase,
  options: { verbose?: boolean; days?: number; save?: boolean } = {}
): Promise<BriefingResult> {
  const days = options.days ?? 7;
  const save = options.save ?? true;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const formattedDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const businessContext = getConfig(db, 'business_context') || '';

  // ── 1. Gather recent knowledge items ──────────────────────
  const cutoffDate = new Date(now.getTime() - days * 86400000).toISOString();
  const recentItems = queryRows(db,
    `SELECT * FROM knowledge WHERE source_date >= ? ORDER BY source_date DESC`,
    [cutoffDate]
  );

  // ── 2. All items (for contact/relationship analysis) ──────
  const allItems = queryRows(db, `SELECT * FROM knowledge ORDER BY source_date DESC`, []);

  // ── 3. Build contact map with mention counts + most recent date ──
  const contactMap = new Map<string, { count: number; lastDate: string | null }>();
  for (const item of allItems) {
    const contacts = parseJsonField(item.contacts);
    for (const name of contacts) {
      const existing = contactMap.get(name) || { count: 0, lastDate: null };
      existing.count++;
      if (item.source_date && (!existing.lastDate || item.source_date > existing.lastDate)) {
        existing.lastDate = item.source_date as string;
      }
      contactMap.set(name, existing);
    }
  }

  // ── 4. Gather commitments from the commitments table ──────
  const activeCommitments = getCommitments(db, { state: 'active' });
  const detectedCommitments = getCommitments(db, { state: 'detected' });
  const overdueCommitments = getCommitments(db, { overdue: true });
  const allCommitmentsList = [...activeCommitments, ...detectedCommitments];

  // Also gather inline commitments from knowledge items
  const inlineCommitments: string[] = [];
  for (const item of recentItems) {
    const commitments = parseJsonField(item.commitments);
    for (const c of commitments) {
      inlineCommitments.push(`${c} (from: ${item.title})`);
    }
  }

  // ── 5. Detect dropped balls ───────────────────────────────
  const droppedBalls: { title: string; contact: string; daysSince: number }[] = [];
  for (const item of allItems) {
    const meta = parseJsonField(item.metadata);
    if (meta.waiting_on_user && meta.days_since_last > 7) {
      const contacts = parseJsonField(item.contacts);
      droppedBalls.push({
        title: item.title as string,
        contact: contacts.join(', ') || 'Unknown',
        daysSince: meta.days_since_last,
      });
    }
  }
  // Also check items tagged awaiting_reply
  for (const item of allItems) {
    const tags = parseJsonField(item.tags);
    if (tags.includes('awaiting_reply')) {
      const meta = parseJsonField(item.metadata);
      if (meta.waiting_on_user && meta.days_since_last > 7) {
        // Already captured above, skip duplicates
        if (!droppedBalls.find(d => d.title === item.title)) {
          const contacts = parseJsonField(item.contacts);
          droppedBalls.push({
            title: item.title as string,
            contact: contacts.join(', ') || 'Unknown',
            daysSince: meta.days_since_last,
          });
        }
      }
    }
  }

  // ── 6. Detect cold relationships ──────────────────────────
  const coldRelationships: { name: string; lastSeen: string; mentions: number; daysSince: number }[] = [];
  for (const [name, data] of contactMap.entries()) {
    if (data.count >= 3 && data.lastDate) {
      const daysSince = Math.floor((now.getTime() - new Date(data.lastDate).getTime()) / 86400000);
      if (daysSince > 14) {
        coldRelationships.push({
          name,
          lastSeen: data.lastDate,
          mentions: data.count,
          daysSince,
        });
      }
    }
  }
  coldRelationships.sort((a, b) => b.daysSince - a.daysSince);

  // ── 7. Calendar events for today and tomorrow ─────────────
  const tomorrow = new Date(now.getTime() + 86400000);
  const tomorrowEnd = new Date(now.getTime() + 2 * 86400000);
  const calendarItems = queryRows(db,
    `SELECT * FROM knowledge WHERE source = 'calendar' AND source_date >= ? AND source_date < ? ORDER BY source_date ASC`,
    [todayStr, tomorrowEnd.toISOString().split('T')[0]]
  );

  // ── 8. Build the prompt ───────────────────────────────────
  const droppedBallsText = droppedBalls.length > 0
    ? droppedBalls.map(d => `- ${d.contact}: "${d.title}" (${d.daysSince} days with no reply)`).join('\n')
    : 'None detected';

  const coldRelText = coldRelationships.length > 0
    ? coldRelationships.slice(0, 15).map(c =>
        `- ${c.name}: last seen ${new Date(c.lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${c.daysSince}d ago, ${c.mentions} total mentions)`
      ).join('\n')
    : 'None detected';

  const commitmentsText = allCommitmentsList.length > 0
    ? allCommitmentsList.slice(0, 20).map(c => {
        const due = c.due_date ? ` (due: ${c.due_date})` : '';
        const owner = c.owner ? ` [${c.owner}]` : '';
        return `- ${c.text}${owner}${due} — state: ${c.state}`;
      }).join('\n')
    : (inlineCommitments.length > 0
      ? inlineCommitments.slice(0, 20).map(c => `- ${c}`).join('\n')
      : 'None tracked');

  const overdueText = overdueCommitments.length > 0
    ? overdueCommitments.map(c => `- OVERDUE: ${c.text} (due: ${c.due_date})`).join('\n')
    : '';

  const calendarText = calendarItems.length > 0
    ? calendarItems.map(c => {
        const date = c.source_date ? new Date(c.source_date as string).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
        const contacts = parseJsonField(c.contacts);
        return `- ${date ? date + ' — ' : ''}${c.title}${contacts.length ? ' (with: ' + contacts.join(', ') + ')' : ''}`;
      }).join('\n')
    : 'No calendar events found';

  const recentSummary = recentItems.slice(0, 30).map(item => {
    const contacts = parseJsonField(item.contacts);
    const dateStr = item.source_date
      ? new Date(item.source_date as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    return `- [${item.source}] ${item.title} (${dateStr})${contacts.length ? ' — ' + contacts.join(', ') : ''}`;
  }).join('\n');

  const prompt = `You are Prime Recall, an AI Chief of Staff. Generate a morning briefing for today (${formattedDate}).

DATA:
- ${recentItems.length} new items in last ${days} days
- Dropped balls (someone waiting on user, 7+ days):
${droppedBallsText}
- Cold relationships (14+ days since last contact, 3+ total mentions):
${coldRelText}
- Active commitments:
${commitmentsText}
${overdueText ? '\nOVERDUE COMMITMENTS:\n' + overdueText : ''}
- Today's calendar:
${calendarText}
- Business context: ${businessContext || 'Not set'}

RECENT ITEMS:
${recentSummary || 'No recent items'}

Generate a briefing with these sections:
1. TOP PRIORITIES — What needs attention RIGHT NOW (overdue commitments, dropped balls)
2. TODAY'S SCHEDULE — Calendar events with relevant context from knowledge base
3. COMMITMENTS CHECK — Status of all active commitments, what's due soon
4. RELATIONSHIP HEALTH — Who's going cold, who needs follow-up
5. WHAT CHANGED — New knowledge items this week, key updates
6. CROSS-REFERENCES — Connections between items that might be useful
7. RECOMMENDED ACTIONS — Specific, actionable next steps ranked by urgency

Be specific. Use real names, dates, and facts. Reference knowledge items where possible.
Keep each section concise but actionable. If a section has no relevant data, say so briefly and move on.`;

  const briefingText = await provider.chat(
    [
      { role: 'system', content: 'You are Prime Recall, an AI Chief of Staff that generates daily intelligence briefings.' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3, max_tokens: 3000 }
  );

  // ── 9. Optionally save as knowledge item ──────────────────
  if (save) {
    const item: KnowledgeItem = {
      id: uuid(),
      title: `Daily Briefing — ${formattedDate}`,
      summary: briefingText.slice(0, 200),
      source: 'briefing',
      source_ref: `briefing:${todayStr}`,
      source_date: now.toISOString(),
      tags: ['briefing', 'daily'],
      importance: 'high',
      metadata: {
        itemsAnalyzed: recentItems.length,
        droppedBalls: droppedBalls.length,
        coldRelationships: coldRelationships.length,
        activeCommitments: allCommitmentsList.length,
        calendarEvents: calendarItems.length,
      },
    };
    insertKnowledge(db, item);
  }

  return {
    briefing: briefingText,
    date: todayStr,
    meta: {
      itemsAnalyzed: recentItems.length,
      droppedBalls: droppedBalls.length,
      coldRelationships: coldRelationships.length,
      activeCommitments: allCommitmentsList.length,
      calendarEvents: calendarItems.length,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────

function queryRows(db: SqlJsDatabase, sql: string, params: any[]): any[] {
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

function parseJsonField(value: any): any {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch {}
  }
  return [];
}
