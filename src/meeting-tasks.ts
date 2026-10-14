// Meeting-task extraction — pulls Zach's own action items out of recent Fireflies
// transcripts and lands them in the ledger (tier 'brief', ball 'zach') so they
// surface in the morning brief and get status-tracked like any other ball.
// The extraction already captured them as clean "Zach Stock to ..." strings;
// this just filters to Zach's tasks and routes them into the ball-tracker.
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { upsertLedgerRows, type LedgerRow } from './ledger.js';

export function syncMeetingTasks(db: Database.Database, days = 14): number {
  const meetings = db.prepare(
    `SELECT title, source_date, action_items FROM knowledge
     WHERE source = 'fireflies' AND source_date >= datetime('now', ?)
       AND action_items IS NOT NULL AND action_items != '[]' AND action_items != ''
     ORDER BY source_date DESC`
  ).all(`-${days} days`) as any[];

  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const m of meetings) {
    let items: any[] = [];
    try { items = JSON.parse(m.action_items); } catch { continue; }
    const meetingName = String(m.title || 'a meeting').replace(/\s+with\s+.*/i, '').slice(0, 50);
    const mDate = String(m.source_date || '').slice(0, 10);
    for (const raw of items) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      // Only Zach's own tasks (not "X to send Zach ...", not other attendees' tasks)
      if (!/^\s*zach\b/i.test(raw) && !/\bzach stock to\b/i.test(raw)) continue;
      const task = raw.replace(/^\s*zach(\s+stock)?\s+(to|will|should|needs to)\s+/i, '').trim();
      if (task.length < 4) continue;
      const key = 'mt:' + createHash('sha1').update(task.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex').slice(0, 12);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        item: key,
        title: task.charAt(0).toUpperCase() + task.slice(1),
        counterparty: meetingName,
        state: `from ${meetingName} (${mDate})`,
        ball: 'zach',
        ball_since: mDate,
        next_action: task,
        tier: 'brief',
        status: 'open',
      });
    }
  }
  if (!rows.length) return 0;
  return upsertLedgerRows(db, 'meeting-tasks', rows);
}

// Open meeting tasks for the brief — most recent first, capped.
export function getMeetingTasks(db: Database.Database, cap = 8): { task: string; from: string; days: number }[] {
  const rows = db.prepare(
    `SELECT title, counterparty, ball_since FROM ledger
     WHERE monitor = 'meeting-tasks' AND status = 'open'
     ORDER BY ball_since DESC LIMIT ?`
  ).all(cap) as any[];
  const dayss = (d: string) => d ? Math.floor((Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000) : 0;
  return rows.map(r => ({ task: String(r.title), from: String(r.counterparty || 'meeting'), days: dayss(r.ball_since) }));
}
