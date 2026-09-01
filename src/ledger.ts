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
//
// Lifecycle of an [ACT] slot (audit fix 2026-08-31): notify → one bump at
// 48h → demote to tier='brief' (frees the slot; the brief carries it).
// Reopened items (resolved→open) get their notification state reset.
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface LedgerRow {
  item: string;          // stable key within the monitor
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

const MAX_OPEN_ACT = 3;        // open [ACT] emails in Zach's inbox at once
const MAX_NEW_ACT_PER_DAY = 2; // new [ACT] emails per local day
const MAX_REMIND_PER_DAY = 2;  // [REMIND] emails per local day
const MAX_ACT_PER_MONITOR = 2; // act-tier rows accepted per monitor per upsert
const MAX_OPEN_PROPOSALS = 3;  // total open offers across ALL monitors — the brief shows 3; a pool of 7 is sprawl
const BUMP_AFTER_HOURS = 48;   // one bump, then demote to brief

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
  try { db.exec("ALTER TABLE ledger ADD COLUMN notified_thread_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN links TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN notified_tier TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN notified_subject TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN resolved_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN deliverable TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN approved_by TEXT"); } catch {}
  try { db.exec("ALTER TABLE ledger ADD COLUMN triage_note TEXT"); } catch {}
}

// LLM output → clean scalar. Headers and single-line fields must never
// carry CR/LF (email header injection via Subject was a confirmed audit
// finding); drafts keep their newlines — they only ever go in the body.
const toText = (v: unknown): string | null =>
  v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
const oneLine = (v: unknown, max = 200): string | null => {
  const s = toText(v);
  if (s == null) return null;
  let out = s.replace(/[\r\n]+/g, ' ').trim();
  if (out.length > max) {
    // cut at a word boundary so truncation reads clean, not "closes today; d"
    out = out.slice(0, max);
    const sp = out.lastIndexOf(' ');
    if (sp > max * 0.6) out = out.slice(0, sp);
    out = out.replace(/[\s,;:—–-]+$/, '') + '…';
  }
  return out || null;
};

export function upsertLedgerRows(db: Database.Database, monitor: string, rows: LedgerRow[]): number {
  ensureLedger(db);
  const up = db.prepare(`
    INSERT INTO ledger (id, monitor, item, title, counterparty, state, ball, ball_since, deadline, next_action, draft, tier, status, links)
    VALUES (@id, @monitor, @item, @title, @counterparty, @state, @ball, @ball_since, @deadline, @next_action, @draft, @tier, @status, @links)
    ON CONFLICT(monitor, item) DO UPDATE SET
      title=@title, counterparty=@counterparty, state=@state, ball=@ball, ball_since=@ball_since,
      deadline=@deadline, next_action=@next_action, draft=@draft, links=@links,
      -- once Zach has been emailed, the dispatch lifecycle owns tier (bump→brief); PM re-emits can't flip it
      tier = CASE WHEN ledger.notified_at IS NOT NULL AND ledger.status = 'open' THEN ledger.tier ELSE @tier END,
      -- Zach's decisions (dismissed/accepted) survive a PM re-emitting the item as open
      status = CASE WHEN ledger.status IN ('dismissed','accepted','escalated') AND @status = 'open' THEN ledger.status ELSE @status END,
      notified_at = CASE WHEN ledger.status NOT IN ('open','dismissed','accepted') AND @status = 'open' THEN NULL ELSE ledger.notified_at END,
      bumped_at   = CASE WHEN ledger.status NOT IN ('open','dismissed','accepted') AND @status = 'open' THEN NULL ELSE ledger.bumped_at END,
      resolved_at = CASE WHEN ledger.status = 'open' AND @status = 'resolved' THEN datetime('now') ELSE ledger.resolved_at END,
      updated_at=datetime('now')
  `);

  // Normalize + gate before writing. Monitors over-produce act rows (observed
  // day one: 6 from one monitor), so tier discipline is enforced here, not
  // just in the prompt.
  const TIERS = new Set(['act', 'remind', 'brief', 'wiki', 'propose']);
  const cleaned = rows
    .filter(r => r && r.item && r.title)
    .map(r => {
      let tier = String(r.tier || 'brief').trim().toLowerCase();
      if (!TIERS.has(tier)) tier = 'brief';
      let status = String(r.status || 'open').trim().toLowerCase();
      if (status === 'closed' || status === 'done' || status === 'complete') status = 'resolved';
      if (!['open', 'resolved', 'dismissed', 'escalated', 'accepted'].includes(status)) status = 'open';
      let ball = String(r.ball || '').trim().toLowerCase();
      if (!['zach', 'other', 'agent'].includes(ball)) ball = '';
      const draft = toText(r.draft);
      let deadline = oneLine(r.deadline, 40);
      // free-text deadlines ("EOD Friday") produce NaN countdowns and never
      // match the remind window — null them; the text stays in next_action/state
      if (deadline) {
        const dl = new Date(deadline);
        if (isNaN(dl.getTime())) deadline = null;
      }
      const ball_since = oneLine(r.ball_since, 40);
      // act requires a finished draft and a time anchor — else demote
      if (tier === 'act' && (!draft || !(deadline || ball_since))) tier = deadline ? 'remind' : 'brief';
      // resources: [{label, url}] — gmail deep links, drive files, portals
      let linksJson: string | null = null;
      const rawLinks = (r as any).links;
      if (Array.isArray(rawLinks)) {
        const clean = rawLinks
          .filter((l: any) => l && typeof l.url === 'string' && /^https?:\/\//.test(l.url.trim()))
          .slice(0, 6)
          .map((l: any) => ({ label: oneLine(l.label, 80) || 'link', url: l.url.trim().replace(/[\r\n\s]+/g, '') }));
        if (clean.length) linksJson = JSON.stringify(clean);
      }
      // evidence gate: an [ACT] email never reaches Zach without a source link
      if (tier === 'act' && !linksJson) tier = deadline ? 'remind' : 'brief';
      return {
        id: uuid(), monitor, item: oneLine(r.item, 120)!, title: oneLine(r.title, 200)!,
        counterparty: oneLine(r.counterparty), state: oneLine(r.state, 300), ball: ball || null,
        ball_since, deadline, next_action: oneLine(r.next_action, 400), draft,
        tier, status, links: linksJson,
      };
    });

  // Proposals: at most ONE new offer per monitor per cycle (initiative, not spam).
  // Accepted/resolved proposals keep their status via the upsert CASE rules.
  let proposeSeen = 0;
  const openProposals = (db.prepare("SELECT COUNT(*) n FROM ledger WHERE tier='propose' AND status IN ('open','escalated') AND monitor <> ?").get(monitor) as any).n;
  for (const r of cleaned) {
    if (r.tier === 'propose') {
      if (r.status !== 'open') continue;
      proposeSeen++;
      // one new offer per monitor per cycle, and no more than 3 open system-wide;
      // excess offers become wiki notes (the monitor can re-offer when a slot frees)
      if (proposeSeen > 1 || openProposals + proposeSeen > MAX_OPEN_PROPOSALS) r.tier = 'wiki';
    }
  }

  // Per-monitor act cap: keep the most time-anchored, demote the rest.
  const acts = cleaned.filter(r => r.tier === 'act' && r.status === 'open');
  if (acts.length > MAX_ACT_PER_MONITOR) {
    acts.sort((a, b) => (a.deadline ? 0 : 1) - (b.deadline ? 0 : 1) || String(a.deadline || a.ball_since || '').localeCompare(String(b.deadline || b.ball_since || '')));
    for (const r of acts.slice(MAX_ACT_PER_MONITOR)) r.tier = 'brief';
  }

  let n = 0;
  const run = db.transaction((batch: typeof cleaned) => {
    for (const r of batch) {
      try { up.run(r); n++; } catch (e: any) {
        console.log(`    ledger: row '${r.item}' skipped — ${(e.message || '').slice(0, 60)}`);
      }
    }
  });
  run(cleaned);
  return n;
}

// Own agents, bots, and receipts are not counterparties Zach owes.
const NOISE = /quinn@|prime@|noreply|no-reply|donotreply|notification|billing@|mailer-daemon|unsubscribe|automatic reply|auto-reply|out of office/i;

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
      AND (source_account IS NULL OR source_account = 'zach.stock@recaptureinsurance.com')
    GROUP BY tid
    HAVING sd >= datetime('now', ?)
  `).all(`-${windowDays} days`) as any[];
  const days = (sd: string) => Math.floor((Date.now() - new Date(sd).getTime()) / 86400000);
  const SELF = /zach\.stock@recaptureinsurance|zstock@stockinsgroup|zstockco@gmail/i;
  const clean = rows.filter(r => !NOISE.test(String(r.last_from || '')) && !NOISE.test(String(r.subj || '')));
  // a thread whose last sender is Zach himself (any alias) can't be "you owe"
  for (const r of clean) if ((r.wou === 1 || r.wou === true) && SELF.test(String(r.last_from || ''))) r.wou = 0;
  // youOwe: newest first — what Zach owes NOW, not the stale edge of the window
  const youOwe = clean
    .filter(r => r.wou === 1 || r.wou === true)
    .sort((a, b) => b.sd.localeCompare(a.sd)).slice(0, cap)
    .map(r => {
      const who = String(r.last_from || '').replace(/<[^>]*>/g, '').trim() || 'unknown';
      return `${who} — "${String(r.subj || '(no subject)').slice(0, 70)}" (${days(r.sd)}d)`;
    });
  // waitingOn: Zach sent last — oldest silence first; the thread is the display
  const waitingOn = clean
    .filter(r => (r.wou === 0 || r.wou === false) && String(r.subj || '').trim())
    .sort((a, b) => a.sd.localeCompare(b.sd)).slice(0, cap)
    .map(r => `"${String(r.subj).slice(0, 70)}" — no reply in ${days(r.sd)}d`);
  return { youOwe, waitingOn };
}

// Learning loop (demote-only, deliberately): if Zach dismissed a monitor's last
// two act-tier items and resolved none in a rolling 30-day window, that
// monitor's actions stop emailing him — they stay in the brief. Promotion is left to the
// weekly roster review; asymmetric risk favors quieter, not louder.
export function mutedMonitors(db: Database.Database): string[] {
  ensureLedger(db);
  const rows = db.prepare(`
    SELECT monitor,
      SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) dismissed,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved
    FROM ledger WHERE notified_tier='act' AND updated_at >= datetime('now','-30 days')
    GROUP BY monitor`).all() as any[];
  return rows.filter(r => r.dismissed >= 2 && r.resolved === 0).map(r => r.monitor);
}

// Proof of attention: one line per active monitor — when it ran, what's open,
// what it's watching, when its slice last moved. Deterministic from the DB.
export function buildCoverage(db: Database.Database): string[] {
  ensureLedger(db);
  const rel = (d: string | null) => {
    if (!d) return 'never';
    const h = Math.floor((Date.now() - new Date(d + (d.endsWith('Z') || d.includes('+') ? '' : 'Z')).getTime()) / 3600000);
    return h < 1 ? 'just now' : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  };
  const monitors = db.prepare(
    "SELECT p.agent_id, p.project, a.last_run_at FROM pm_agents p LEFT JOIN agent_state a ON a.subject_id = p.project AND a.agent_type='pm' WHERE p.active=1 ORDER BY p.created_at"
  ).all() as any[];
  return monitors.map((m: any) => {
    const st = db.prepare(
      "SELECT COUNT(*) n, MAX(updated_at) mx FROM ledger WHERE monitor=? AND status='open' AND tier IN ('act','remind')"
    ).get(m.agent_id) as any;
    const top = db.prepare(
      "SELECT title, deadline, ball_since FROM ledger WHERE monitor=? AND status='open' AND tier IN ('act','remind') ORDER BY deadline IS NULL, deadline, ball_since LIMIT 1"
    ).get(m.agent_id) as any;
    const watching = top ? ` · watching: ${String(top.title).slice(0, 60)}` : ' · nothing urgent';
    const muted = mutedMonitors(db).includes(m.agent_id) ? ' · MUTED (you skipped its last actions — brief only)' : '';
    const acc = (db.prepare("SELECT COUNT(*) n FROM ledger WHERE monitor=? AND tier='propose' AND status='accepted'").get(m.agent_id) as any).n;
    const accepted = acc ? ` · ${acc} accepted proposal${acc === 1 ? '' : 's'} pending` : '';
    return `${m.project} — ran ${rel(m.last_run_at)} · ${st.n} open · last movement ${rel(st.mx)}${watching}${muted}${accepted}`;
  });
}

// Staff proposals flow: monitor offers (status 'open') → Quinn triages each cycle →
// 'accepted' (Quinn approved within her authority, approved_by='quinn'),
// 'escalated' (needs Zach — this is what the brief shows), or 'dismissed' (with note).
// Untriaged offers older than 24h auto-escalate so nothing rots unseen.
export function getProposals(db: Database.Database, limit = 3): any[] {
  ensureLedger(db);
  db.prepare("UPDATE ledger SET status='escalated', triage_note='auto-escalated: not triaged within 24h', updated_at=datetime('now') WHERE tier='propose' AND status='open' AND created_at < datetime('now','-24 hours')").run();
  return db.prepare(
    "SELECT id, monitor, item, title, next_action FROM ledger WHERE tier='propose' AND status='escalated' ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as any[];
}
export function getUntriagedProposals(db: Database.Database): any[] {
  ensureLedger(db);
  return db.prepare("SELECT id, monitor, item, title, next_action, created_at FROM ledger WHERE tier='propose' AND status='open' ORDER BY created_at DESC LIMIT 10").all() as any[];
}
export function getQuinnApproved(db: Database.Database, hours = 24): any[] {
  ensureLedger(db);
  return db.prepare("SELECT id, monitor, title, triage_note FROM ledger WHERE tier='propose' AND status='accepted' AND approved_by='quinn' AND updated_at >= datetime('now', ?) ORDER BY updated_at DESC LIMIT 5").all(`-${hours} hours`) as any[];
}
export const QUINN_APPROVALS_PER_DAY = 2;
export function quinnApprovalsToday(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) n FROM ledger WHERE tier='propose' AND approved_by='quinn' AND date(updated_at,'localtime') = date('now','localtime')").get() as any).n;
}

// Compact digest for the morning brief: open actions, stalls, ball lists.
export function getLedgerDigest(db: Database.Database): string {
  ensureLedger(db);
  const open = db.prepare(
    "SELECT title, monitor, notified_at FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, created_at"
  ).all() as any[];
  const stalled = db.prepare(
    "SELECT title, monitor FROM ledger WHERE status='open' AND bumped_at IS NOT NULL AND tier='brief' ORDER BY bumped_at DESC LIMIT 5"
  ).all() as any[];
  const { youOwe, waitingOn } = getBallLists(db);
  const parts: string[] = [];
  if (open.length) {
    parts.push('OPEN ACTIONS (each has its own [ACT] email):');
    for (const o of open) parts.push(`- ${o.title} [${o.monitor}]${o.notified_at ? '' : ' (queued)'}`);
  }
  if (stalled.length) {
    parts.push('', 'STALLING (emailed + bumped, no visible movement — no more emails will be sent):');
    for (const s of stalled) parts.push(`- ${s.title} [${s.monitor}]`);
  }
  if (youOwe.length) { parts.push('', 'YOU OWE A RESPONSE (newest first):'); for (const l of youOwe) parts.push(`- ${l}`); }
  if (waitingOn.length) { parts.push('', 'WAITING ON THEM (oldest first):'); for (const l of waitingOn) parts.push(`- ${l}`); }
  return parts.join('\n');
}

// Turn ledger state into at most a trickle of emails. Caps are structural:
// scarcity survives classifier bad days. All day-windows are LOCAL days.
export async function dispatchLedger(db: Database.Database): Promise<{ sent: number; bumped: number }> {
  ensureLedger(db);
  const { sendEmail } = await import('./connectors/gmail.js');
  const to = 'zach.stock@recaptureinsurance.com';
  let sent = 0, bumped = 0;

  const openNotified = (db.prepare(
    "SELECT COUNT(*) n FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NOT NULL AND bumped_at IS NULL"
  ).get() as any).n;
  // counted on notified_tier (snapshot at send) — live tier gets overwritten
  // by PM upserts, which let a 3rd ACT slip through the daily cap (audit)
  const todayAct = (db.prepare(
    "SELECT COUNT(*) n FROM ledger WHERE notified_tier='act' AND date(notified_at,'localtime') = date('now','localtime')"
  ).get() as any).n;
  const todayRemind = (db.prepare(
    "SELECT COUNT(*) n FROM ledger WHERE notified_tier='remind' AND date(notified_at,'localtime') = date('now','localtime')"
  ).get() as any).n;
  // overdue must SAY overdue — clamping to "0d left" inverts the point
  const daysTag = (deadline: string | null): string | null => {
    if (!deadline || !/^\d{4}-\d{2}-\d{2}/.test(deadline)) return null;
    // calendar dates compare as LOCAL days — the evening of the due date is "today", not overdue
    const dl = new Date(deadline.slice(0, 10) + 'T00:00:00');
    if (isNaN(dl.getTime())) return null;
    const n = new Date(); const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const d = Math.round((dl.getTime() - today.getTime()) / 86400000);
    return d < 0 ? `OVERDUE ${-d}d` : d === 0 ? 'due today' : `${d}d left`;
  };

  const subj = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 180);
  const { renderActionHtml, humanTitle, monitorName, whenText } = await import('./email-format.js');
  const htmlBody = (r: any, bump: boolean, kind: 'act' | 'remind') => {
    let links: { label: string; url: string }[] = [];
    try { links = r.links ? JSON.parse(r.links) : []; } catch {}
    const why = r.ball_since && !r.deadline ? `waiting on ${r.ball === 'zach' ? 'you' : 'them'} since ${r.ball_since}` : (r.state ? String(r.state).slice(0, 140) : '');
    return renderActionHtml({ title: humanTitle(r.title, 120), when: whenText(r.deadline), why, nextAction: r.next_action || '', draft: r.draft, links, from: monitorName(db, r.monitor), bump, kind });
  };
  const body = (r: any, bump: boolean) => [
    bump ? 'BUMP — 48h with no visible movement. This is the last email about it; from now on the morning brief carries it.' : null,
    `${r.title}`,
    `Monitor: ${r.monitor}${r.counterparty ? `   Counterparty: ${r.counterparty}` : ''}`,
    r.state ? `Where it stands: ${r.state}` : null,
    r.ball_since ? `Ball with ${r.ball || 'you'} since: ${r.ball_since}` : null,
    r.deadline ? `Deadline: ${r.deadline}` : null,
    '',
    r.next_action ? `DO THIS: ${r.next_action}` : null,
    r.draft ? `\n--- READY-TO-SEND DRAFT (send from your own account) ---\n${r.draft}\n---` : null,
    (() => {
      try {
        const ls = r.links ? JSON.parse(r.links) : [];
        if (!ls.length) return null;
        return '\nRESOURCES:\n' + ls.map((l: any) => `  • ${l.label}: ${l.url}`).join('\n');
      } catch { return null; }
    })(),
    '',
    'No reply needed — when you act, the monitor sees your sent mail and closes this out.',
    'To drop it: tell Quinn or Claude to dismiss it.',
  ].filter(l => l !== null).join('\n');

  // proposals expire: an offer nobody took in 7 days is dismissed, not nagged
  db.prepare("UPDATE ledger SET status='dismissed', triage_note=COALESCE(triage_note,'') || ' expired', updated_at=datetime('now') WHERE tier='propose' AND status IN ('open','escalated') AND created_at < datetime('now','-7 days')").run();

  // New [ACT] notifications, under both caps, most urgent first.
  const room = Math.max(0, Math.min(MAX_OPEN_ACT - openNotified, MAX_NEW_ACT_PER_DAY - todayAct));
  if (room > 0) {
    const muted = mutedMonitors(db);
    const candidates = (db.prepare(`
      SELECT * FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NULL
      ORDER BY deadline IS NULL, deadline, ball_since LIMIT 20
    `).all() as any[]).filter(r => !muted.includes(r.monitor)).slice(0, room);
    let slot = openNotified;
    for (const r of candidates) {
      slot++;
      // Subject carries the whole decision context — countdown, not date
      // (time-blindness), and the slot so scarcity is visible at a glance.
      const dt = daysTag(r.deadline);
      const tag = dt ? `[ACT ${slot}/${MAX_OPEN_ACT} · ${dt}]` : `[ACT ${slot}/${MAX_OPEN_ACT}]`;
      const subject = subj(`${tag} ${r.title}`);
      const res = await sendEmail(db, { to, subject, body: htmlBody(r, false, 'act'), html: true });
      if (res.success) {
        db.prepare("UPDATE ledger SET notified_at=datetime('now'), notified_thread_id=?, notified_tier='act', notified_subject=? WHERE id=?")
          .run(res.threadId || null, subject, r.id);
        sent++;
      }
    }
  }

  // One bump each — then DEMOTE to brief so the slot frees and emails stop.
  const stale = db.prepare(`
    SELECT * FROM ledger WHERE tier='act' AND status='open' AND bumped_at IS NULL
      AND notified_at IS NOT NULL AND notified_at <= datetime('now', ?)
  `).all(`-${BUMP_AFTER_HOURS} hours`) as any[];
  for (const r of stale) {
    // Reply in the original thread. Gmail threads on threadId + MATCHING
    // subject — reuse the stored original subject verbatim with Re: (audit).
    const bumpSubject = r.notified_subject ? `Re: ${r.notified_subject}` : subj(`[ACT — bump] ${r.title}`);
    const res = await sendEmail(db, { to, subject: bumpSubject, body: htmlBody(r, true, 'act'), html: true, replyToThreadId: r.notified_thread_id || undefined });
    if (res.success) {
      db.prepare("UPDATE ledger SET bumped_at=datetime('now'), tier='brief' WHERE id=?").run(r.id);
      bumped++;
    }
  }

  // Reminders: deadline entering the 5-day window; own daily cap; soonest first.
  const remindRoom = Math.max(0, MAX_REMIND_PER_DAY - todayRemind);
  if (remindRoom > 0) {
    const reminders = db.prepare(`
      SELECT * FROM ledger WHERE tier='remind' AND status='open' AND notified_at IS NULL
        AND deadline IS NOT NULL AND date(deadline) <= date('now','localtime','+2 days')
      ORDER BY date(deadline) LIMIT ?
    `).all(remindRoom) as any[];
    for (const r of reminders) {
      const dt = daysTag(r.deadline) || 'due';
      const rsubject = subj(`[REMIND · ${dt}] ${r.title} (due ${r.deadline})`);
      const res = await sendEmail(db, { to, subject: rsubject, body: htmlBody(r, false, 'remind'), html: true });
      if (res.success) { db.prepare("UPDATE ledger SET notified_at=datetime('now'), notified_tier='remind', notified_subject=? WHERE id=?").run(rsubject, r.id); sent++; }
    }
  }

  return { sent, bumped };
}
