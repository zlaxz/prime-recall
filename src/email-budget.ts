// Email budget — ONE choke point for everything Prime sends Zach.
//
// "I am getting too many emails" (2026-09-01: 28 in 24h, 16 of them [SYSTEM]).
// Every sender routes through sendEmail; this decides whether a message may
// go out today. Hard ceilings by kind, plus a hard total. Anything held back
// is logged so the morning brief can say "N held" — nothing disappears
// silently, it just stops arriving as an interrupt.
//
//   brief    1/day   (the one daily surface — never suppressed)
//   act      2/day
//   remind   1/day   (and only deadlines within 2 days — see dispatchLedger)
//   system   1/day   (NEEDS_ZACH / stalled / watchdog failures: 2/day)
//   reply    exempt  (answers to Zach's own messages, threaded)
//   total    6/day   (excluding replies)
import Database from 'better-sqlite3';

export type EmailKind = 'brief' | 'act' | 'remind' | 'system' | 'system-urgent' | 'reply' | 'other';
const CAPS: Record<EmailKind, number> = { brief: 1, act: 2, remind: 1, system: 1, 'system-urgent': 2, reply: 9999, other: 1 };
const TOTAL_CAP = 6;

export function classifyEmail(subject: string, inReplyTo?: string): EmailKind {
  const s = subject || '';
  if (inReplyTo || /^re:\s/i.test(s)) return 'reply';
  if (/^\[BRIEF\]/i.test(s)) return 'brief';
  if (/^\[ACT/i.test(s)) return 'act';
  if (/^\[REMIND/i.test(s)) return 'remind';
  if (/^\[SYSTEM\]|^\[PRIME HEALTH\]|^MECHANIC /i.test(s)) {
    return /NEEDS_ZACH|stalled|FAILED|is down|broken|cannot|Claude auth|usage limit|balance depleted/i.test(s) ? 'system-urgent' : 'system';
  }
  return 'other';
}

function ensure(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, subject TEXT, held INTEGER DEFAULT 0,
    sent_at TEXT DEFAULT (datetime('now')))`);
}

// Returns true if this email may go out now (and records it); false = held.
export function emailBudgetAllows(db: Database.Database, subject: string, inReplyTo?: string): { allowed: boolean; kind: EmailKind; reason?: string } {
  ensure(db);
  const kind = classifyEmail(subject, inReplyTo);
  if (kind === 'reply' || kind === 'brief') {
    db.prepare("INSERT INTO email_log (kind, subject) VALUES (?, ?)").run(kind, subject.slice(0, 200));
    return { allowed: true, kind };
  }
  const today = (k: string) => (db.prepare(
    "SELECT COUNT(*) n FROM email_log WHERE held = 0 AND kind = ? AND date(sent_at,'localtime') = date('now','localtime')"
  ).get(k) as any).n as number;
  const total = (db.prepare(
    "SELECT COUNT(*) n FROM email_log WHERE held = 0 AND kind NOT IN ('reply') AND date(sent_at,'localtime') = date('now','localtime')"
  ).get() as any).n as number;
  const kindCount = kind === 'system-urgent' ? today('system-urgent') : today(kind);
  let reason: string | undefined;
  if (kindCount >= CAPS[kind]) reason = `${kind} cap ${CAPS[kind]}/day reached`;
  else if (total >= TOTAL_CAP) reason = `daily total ${TOTAL_CAP} reached`;
  db.prepare("INSERT INTO email_log (kind, subject, held) VALUES (?, ?, ?)").run(kind, subject.slice(0, 200), reason ? 1 : 0);
  return reason ? { allowed: false, kind, reason } : { allowed: true, kind };
}

export function heldToday(db: Database.Database): { n: number; subjects: string[] } {
  ensure(db);
  const rows = db.prepare(
    "SELECT subject FROM email_log WHERE held = 1 AND date(sent_at,'localtime') = date('now','localtime') ORDER BY sent_at DESC"
  ).all() as any[];
  return { n: rows.length, subjects: rows.map(r => r.subject) };
}
