// Reply handler — Zach answers Prime by replying to its emails.
//
// Inbound only: reads Zach's own sent mail addressed to quinn@ (service account
// impersonating Zach, same auth as the sent-mail scan), parses intent, acts on
// the ledger, and sends a one-line confirmation back IN THREAD (to Zach only —
// the no-third-party rule holds). Free-text replies become directives Quinn
// reads next cycle. Runs every sync tick; each message handled exactly once.
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';
import { getServiceAccountAuth, sendEmail } from './connectors/gmail.js';
import { getProposals, ensureLedger } from './ledger.js';
import { insertKnowledge } from './db.js';

const ME = 'zach.stock@recaptureinsurance.com';
const QUINN = 'quinn@recaptureinsurance.com';

function ensureTable(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS processed_replies (message_id TEXT PRIMARY KEY, action TEXT, handled_at TEXT DEFAULT (datetime('now')))");
}

function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);
  const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
  const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
  let text = plain ? Buffer.from(plain.body.data, 'base64url' as any).toString('utf-8')
    : html ? Buffer.from(html.body.data, 'base64url' as any).toString('utf-8').replace(/<[^>]+>/g, ' ') : '';
  // keep only Zach's new text — drop the quoted original
  text = text.split(/\n\s*On .{5,120} wrote:/)[0].split(/\n>/)[0].split(/\n-{2,}\s*\n/)[0];
  return text.replace(/\s+/g, ' ').trim();
}

export type ReplyIntent =
  | { kind: 'accept' | 'decline'; n: number | null; words: string }
  | { kind: 'done' | 'skip' }
  | { kind: 'directive'; text: string };

export function parseIntent(text: string): ReplyIntent {
  const t = text.toLowerCase().trim();
  const num = t.match(/#\s*(\d)|\b(?:to|proposal|number)\s*(\d)\b|^\s*(\d)\s*$/);
  const n = num ? parseInt(num[1] || num[2] || num[3], 10) : null;
  if (/^(yes|accept|approve|go|do it|yes please)\b/.test(t)) return { kind: 'accept', n, words: t };
  if (/^(no|decline|reject|pass|nope)\b/.test(t)) return { kind: 'decline', n, words: t };
  if (/^(done|sent|handled|complete|completed|did it|finished)\b/.test(t)) return { kind: 'done' };
  if (/^(skip|dismiss|drop|kill it|ignore|not now)\b/.test(t)) return { kind: 'skip' };
  return { kind: 'directive', text: text.slice(0, 1500) };
}

export async function processReplies(db: Database.Database): Promise<{ handled: number }> {
  ensureTable(db); ensureLedger(db);
  const auth = getServiceAccountAuth(ME, ['https://www.googleapis.com/auth/gmail.readonly']);
  if (!auth) return { handled: 0 };
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({ userId: 'me', q: `from:me to:${QUINN} newer_than:2d`, maxResults: 20 });
  let handled = 0;
  for (const m of list.data.messages || []) {
    if (db.prepare("SELECT 1 FROM processed_replies WHERE message_id = ?").get(m.id)) continue;
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' });
    const headers = Object.fromEntries((msg.data.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]));
    const subject = String(headers['subject'] || '');
    const text = bodyText(msg.data.payload);
    if (!text) { db.prepare("INSERT OR IGNORE INTO processed_replies (message_id, action) VALUES (?, 'empty')").run(m.id); continue; }
    const intent = parseIntent(text);
    let confirmation = '';
    const origSubject = subject.replace(/^(re|fwd?):\s*/i, '').trim();

    if (intent.kind === 'accept' || intent.kind === 'decline') {
      const open = getProposals(db, 3);
      let pick: any = null;
      if (intent.n && intent.n >= 1 && intent.n <= open.length) pick = open[intent.n - 1];
      if (!pick && open.length === 1) pick = open[0];
      if (!pick) {
        const w = intent.words.replace(/^(yes|no|accept|decline|reject|approve|pass|go)\b\s*(to)?\s*/, '');
        pick = open.find((p: any) => w.length > 6 && String(p.title).toLowerCase().includes(w.slice(0, 30))) || null;
      }
      if (pick) {
        const status = intent.kind === 'accept' ? 'accepted' : 'dismissed';
        db.prepare("UPDATE ledger SET status=?, updated_at=datetime('now') WHERE id=?").run(status, pick.id);
        confirmation = intent.kind === 'accept'
          ? `Got it — accepted: "${pick.title}". ${pick.monitor} will do it on its next cycle; it'll show under CLEARED when done.`
          : `Got it — declined: "${pick.title}". It won't be re-proposed.`;
      } else {
        confirmation = open.length
          ? `I couldn't tell which proposal you meant. Open ones: ${open.map((p: any, i: number) => `#${i + 1} ${p.title}`).join(' | ')}. Reply "yes to #n".`
          : `There are no open proposals right now, so I logged your reply as a note for Quinn.`;
        if (!open.length) saveDirective(db, text, subject);
      }
    } else if (intent.kind === 'done' || intent.kind === 'skip') {
      const row = db.prepare("SELECT id, title FROM ledger WHERE status='open' AND notified_subject = ? ORDER BY notified_at DESC LIMIT 1").get(origSubject) as any;
      if (row) {
        const status = intent.kind === 'done' ? 'resolved' : 'dismissed';
        db.prepare(`UPDATE ledger SET status=?, ${intent.kind === 'done' ? "resolved_at=datetime('now')," : ''} updated_at=datetime('now') WHERE id=?`).run(status, row.id);
        confirmation = intent.kind === 'done' ? `Got it — marked done: "${row.title}". It'll show under CLEARED tomorrow.` : `Got it — dropped: "${row.title}".`;
      } else {
        saveDirective(db, text, subject);
        confirmation = `Got it — I couldn't match that to a specific action, so I logged it as a note for Quinn.`;
      }
    } else {
      const dtext = (intent as { kind: 'directive'; text: string }).text;
      saveDirective(db, dtext, subject);
      confirmation = `Got it — logged for Quinn: "${dtext.slice(0, 120)}${dtext.length > 120 ? '…' : ''}". It's in her next cycle.`;
    }

    db.prepare("INSERT OR IGNORE INTO processed_replies (message_id, action) VALUES (?, ?)").run(m.id, intent.kind);
    try {
      await sendEmail(db, { to: ME, subject: `Re: ${origSubject}`.slice(0, 180), body: confirmation, replyToThreadId: msg.data.threadId || undefined });
    } catch {}
    handled++;
  }
  return { handled };
}

function saveDirective(db: Database.Database, text: string, subject: string) {
  insertKnowledge(db, {
    id: uuid(),
    title: `Directive from Zach (email reply): ${text.slice(0, 80)}`,
    summary: `Zach replied to "${subject}": ${text}`,
    source: 'directive',
    source_ref: `reply:${Date.now()}`,
    source_date: new Date().toISOString(),
    importance: 'high',
    provenance: 'primary',
    tags: ['directive', 'email-reply'],
  } as any);
}
