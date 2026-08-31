// Ledger — the shared ball-in-play table behind every monitor.
//
// One row = something in a state, somebody has the ball, since a date,
// maybe a deadline, one next action. Monitors upsert their slice each
// cycle via a ---LEDGER--- block; dispatchLedger() turns rows into
// [ACT]/[REMIND] emails to Zach under hard scarcity caps.
//
// Prime does NOT send to third parties (Zach's call, 2026-08-31): drafts
// ride inside the action email and Zach sends from his own account.
// Monitors close loops by observing gmail-sent, not by reply protocol.
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface LedgerRow {
  item: string;          // stable key within the monitor, e.g. "claim-0118444-coverage-position"
  title: string;
  counterparty?: string;
  state?: string;
  ball?: 'zach' | 'other' | 'agent';
  ball_since?: string;   // YYYY-MM-DD
  deadline?: string | null;
  next_action?: string;
  draft?: string | null;
  tier?: 'act' | 'remind' | 'brief' | 'wiki';
  status?: 'open' | 'resolved' | 'dismissed';
}

const MAX_OPEN_ACT = 3;      // open [ACT] emails in Zach's inbox at once
const MAX_NEW_PER_DAY = 2;   // new [ACT] emails per day
const BUMP_AFTER_HOURS = 48; // one bump, then it demotes to the brief

export function ensureLedger(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    monitor TEXT NOT NULL,
    item TEXT NOT NULL,
    title TEXT NOT NULL,
    counterparty TEXT,
    state TEXT,
    ball TEXT,
    ball_since TEXT,
    deadline TEXT,
    next_action TEXT,
    draft TEXT,
    tier TEXT DEFAULT 'brief',
    status TEXT DEFAULT 'open',
    notified_at TEXT,
    bumped_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(monitor, item)
  )`);
}

export function upsertLedgerRows(db: Database.Database, monitor: string, rows: LedgerRow[]): number {
  ensureLedger(db);
  let n = 0;
  const up = db.prepare(`
    INSERT INTO ledger (id, monitor, item, title, counterparty, state, ball, ball_since, deadline, next_action, draft, tier, status)
    VALUES (@id, @monitor, @item, @title, @counterparty, @state, @ball, @ball_since, @deadline, @next_action, @draft, @tier, @status)
    ON CONFLICT(monitor, item) DO UPDATE SET
      title=@title, counterparty=@counterparty, state=@state, ball=@ball, ball_since=@ball_since,
      deadline=@deadline, next_action=@next_action, draft=@draft, tier=@tier, status=@status,
      updated_at=datetime('now')
  `);
  for (const r of rows) {
    if (!r?.item || !r?.title) continue;
    up.run({
      id: uuid(), monitor, item: String(r.item).slice(0, 120), title: String(r.title).slice(0, 200),
      counterparty: r.counterparty ?? null, state: r.state ?? null, ball: r.ball ?? null,
      ball_since: r.ball_since ?? null, deadline: r.deadline ?? null,
      next_action: r.next_action ?? null, draft: r.draft ?? null,
      tier: r.tier ?? 'brief', status: r.status ?? 'open',
    });
    n++;
  }
  return n;
}

// "You owe / Waiting on" across ALL mail, from extraction's waiting_on_user flag.
export function getBallLists(db: Database.Database, windowDays = 45, cap = 10): { youOwe: string[]; waitingOn: string[] } {
  const rows = db.prepare(`
    SELECT json_extract(metadata,'$.thread_id') tid,
           json_extract(metadata,'$.subject') subj,
           json_extract(metadata,'$.last_from') last_from,
           json_extract(metadata,'$.waiting_on_user') wou,
           MAX(source_date) sd
    FROM knowledge
    WHERE source = 'gmail' AND json_extract(metadata,'$.thread_id') IS NOT NULL
    GROUP BY tid
    HAVING sd >= datetime('now', ?)
  `).all(`-${windowDays} days`) as any[];
  const days = (sd: string) => Math.floor((Date.now() - new Date(sd).getTime()) / 86400000);
  // Own agents, bots, and receipts are not counterparties Zach owes
  const NOISE = /quinn@|prime@|noreply|no-reply|donotreply|notification|billing@|mailer-daemon/i;
  const youOwe = rows
    .filter(r => (r.wou === 1 || r.wou === true) && !NOISE.test(String(r.last_from || '')))
    .sort((a, b) => a.sd.localeCompare(b.sd)).slice(0, cap)
    .map(r => {
      const who = String(r.last_from || '').replace(/<[^>]*>/g, '').trim() || 'unknown';
      return `${who} — "${String(r.subj || '(no subject)').slice(0, 70)}" (${days(r.sd)}d)`;
    });
  // Zach sent last — the display is the thread, not the sender (which is Zach)
  const waitingOn = rows
    .filter(r => r.wou === 0 || r.wou === false)
    .sort((a, b) => a.sd.localeCompare(b.sd)).slice(0, cap)
    .map(r => `"${String(r.subj || '(no subject)').slice(0, 70)}" — no reply in ${days(r.sd)}d`);
  return { youOwe, waitingOn };
}

// Compact digest for the morning brief: open actions + ball lists.
export function getLedgerDigest(db: Database.Database): string {
  ensureLedger(db);
  const open = db.prepare(
    "SELECT title, monitor, notified_at FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, created_at"
  ).all() as any[];
  const { youOwe, waitingOn } = getBallLists(db);
  const parts: string[] = [];
  if (open.length) {
    parts.push('OPEN ACTIONS (each has its own [ACT] email):');
    for (const o of open) parts.push(`- ${o.title} [${o.monitor}]${o.notified_at ? '' : ' (queued)'}`);
  }
  if (youOwe.length) { parts.push('', 'YOU OWE A RESPONSE:'); for (const l of youOwe) parts.push(`- ${l}`); }
  if (waitingOn.length) { parts.push('', 'WAITING ON THEM (oldest first):'); for (const l of waitingOn) parts.push(`- ${l}`); }
  return parts.join('\n');
}

// Turn ledger state into at most a trickle of emails. Caps are structural:
// scarcity survives classifier bad days.
export async function dispatchLedger(db: Database.Database): Promise<{ sent: number; bumped: number }> {
  ensureLedger(db);
  const { sendEmail } = await import('./connectors/gmail.js');
  const to = 'zach.stock@recaptureinsurance.com';
  let sent = 0, bumped = 0;

  const openNotified = (db.prepare(
    "SELECT COUNT(*) n FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NOT NULL"
  ).get() as any).n;
  const today = (db.prepare(
    "SELECT COUNT(*) n FROM ledger WHERE notified_at >= datetime('now','start of day')"
  ).get() as any).n;

  const body = (r: any, bump: boolean) => [
    bump ? 'BUMP — 48h with no visible movement. After this it drops to the brief.' : null,
    `${r.title}`,
    `Monitor: ${r.monitor}${r.counterparty ? `   Counterparty: ${r.counterparty}` : ''}`,
    r.state ? `Where it stands: ${r.state}` : null,
    r.ball_since ? `Ball with ${r.ball || 'you'} since: ${r.ball_since}` : null,
    r.deadline ? `Deadline: ${r.deadline}` : null,
    '',
    r.next_action ? `DO THIS: ${r.next_action}` : null,
    r.draft ? `\n--- READY-TO-SEND DRAFT (send from your own account) ---\n${r.draft}\n---` : null,
    '',
    'No reply needed — when you send it, the monitor sees your sent mail and closes this out.',
    'Reply SKIP if you want it dropped.',
  ].filter(l => l !== null).join('\n');

  // New [ACT] notifications, under both caps, most urgent first.
  const room = Math.max(0, Math.min(MAX_OPEN_ACT - openNotified, MAX_NEW_PER_DAY - today));
  if (room > 0) {
    const candidates = db.prepare(`
      SELECT * FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NULL
      ORDER BY deadline IS NULL, deadline, ball_since LIMIT ?
    `).all(room) as any[];
    for (const r of candidates) {
      const res = await sendEmail(db, { to, subject: `[ACT] ${r.title}`, body: body(r, false) });
      if (res.success) {
        db.prepare("UPDATE ledger SET notified_at=datetime('now') WHERE id=?").run(r.id);
        sent++;
      }
    }
  }

  // One bump each, then the brief carries it.
  const stale = db.prepare(`
    SELECT * FROM ledger WHERE tier='act' AND status='open' AND bumped_at IS NULL
      AND notified_at IS NOT NULL AND notified_at <= datetime('now', ?)
  `).all(`-${BUMP_AFTER_HOURS} hours`) as any[];
  for (const r of stale) {
    const res = await sendEmail(db, { to, subject: `[ACT — bump] ${r.title}`, body: body(r, true) });
    if (res.success) {
      db.prepare("UPDATE ledger SET bumped_at=datetime('now') WHERE id=?").run(r.id);
      bumped++;
    }
  }

  // Reminders: deadline entering the 5-day window, one email, no bump.
  const reminders = db.prepare(`
    SELECT * FROM ledger WHERE tier='remind' AND status='open' AND notified_at IS NULL
      AND deadline IS NOT NULL AND date(deadline) <= date('now','+5 days') LIMIT 2
  `).all() as any[];
  for (const r of reminders) {
    const res = await sendEmail(db, { to, subject: `[REMIND] ${r.title} — due ${r.deadline}`, body: body(r, false) });
    if (res.success) {
      db.prepare("UPDATE ledger SET notified_at=datetime('now') WHERE id=?").run(r.id);
      sent++;
    }
  }

  return { sent, bumped };
}
