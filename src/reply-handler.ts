// Reply handler — Zach answers Prime by replying to its emails.
//
// Transport only: reads Zach's own sent mail addressed to quinn@ (service
// account impersonating Zach), builds the context of what he replied to, and
// hands his words to the shared intent layer (src/intent.ts). Confirmation
// goes back to Zach only, threaded by In-Reply-To (Gmail thread ids are
// mailbox-scoped — audit 2026-08-31 — so subjects, not thread ids, are the key).
// Claim-first exactly-once: two processes run syncAll (serve + shift).
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { getServiceAccountAuth, sendEmail } from './connectors/gmail.js';
import { getProposals, ensureLedger } from './ledger.js';
import { resolveAndExecute, type IntentContext } from './intent.js';

const ME = 'zach.stock@recaptureinsurance.com';
const QUINN = 'quinn@recaptureinsurance.com';

function ensureTable(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS processed_replies (message_id TEXT PRIMARY KEY, action TEXT, handled_at TEXT DEFAULT (datetime('now')))");
}

// Zach's new text only — strip quoted originals and forwarded bodies
export function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);
  const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
  const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
  let text = plain ? Buffer.from(plain.body.data, 'base64url' as any).toString('utf-8')
    : html ? Buffer.from(html.body.data, 'base64url' as any).toString('utf-8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ') : '';
  const cut = [
    /\n\s*On .{5,160}? wrote:/s, /\n>/, /\n-{2,}\s*\n/, /\n-+\s*Original Message\s*-+/i,
    /\n-+\s*Forwarded message/i, /\nBegin forwarded message:/i,
    /\nFrom:\s.+\n(Sent|Date):/i, /\nSent from my (iPhone|iPad|Galaxy)/i, /\n_{5,}/,
  ];
  for (const re of cut) { const m = text.match(re); if (m && m.index !== undefined && m.index > 0) text = text.slice(0, m.index); }
  return text.replace(/\s+/g, ' ').trim();
}

export async function processReplies(db: Database.Database): Promise<{ handled: number }> {
  ensureTable(db); ensureLedger(db);
  const auth = getServiceAccountAuth(ME, ['https://www.googleapis.com/auth/gmail.readonly']);
  if (!auth) return { handled: 0 };
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({ userId: 'me', q: `from:me to:${QUINN} in:sent newer_than:2d`, maxResults: 20 });
  let handled = 0;
  for (const m of list.data.messages || []) {
    // claim first — the model call takes 15-120s and two processes run this loop
    const claim = db.prepare("INSERT OR IGNORE INTO processed_replies (message_id, action) VALUES (?, 'processing')").run(m.id);
    if (claim.changes !== 1) continue;
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' });
      const headers = Object.fromEntries((msg.data.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]));
      const to = String(headers['to'] || '');
      if (!to.toLowerCase().includes(QUINN) || /,/.test(to)) { db.prepare("UPDATE processed_replies SET action='not-to-quinn' WHERE message_id=?").run(m.id); continue; }
      const subject = String(headers['subject'] || '');
      const messageId = String(headers['message-id'] || '');
      const text = bodyText(msg.data.payload);
      if (!text) { db.prepare("UPDATE processed_replies SET action='empty' WHERE message_id=?").run(m.id); continue; }

      // ── Context: what did he reply to? (keyed by subject — mailbox-safe) ──
      const isForward = /^fwd?:/i.test(subject);
      const orig = subject.replace(/^((re|fwd?):\s*)+/i, '').trim();
      const kind: IntentContext['repliedTo'] extends undefined ? never : NonNullable<IntentContext['repliedTo']>['kind'] =
        isForward ? 'forward' : /^\[BRIEF\]/i.test(orig) ? 'brief' : /^\[ACT/i.test(orig) ? 'act' : /^\[REMIND/i.test(orig) ? 'remind' : /^\[SYSTEM\]|^MECHANIC/i.test(orig) ? 'system' : 'other';

      // proposals as numbered in the brief he replied to (snapshot by subject), else current order
      let proposals: IntentContext['proposals'] = [];
      let briefBody: string | undefined;
      const snap = (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(`brief_sent:${orig.slice(0, 120)}`) as any)?.value;
      if (snap) {
        try {
          const sv = JSON.parse(snap);
          proposals = (sv.proposals || []).map((p: any, i: number) => ({ id: p.id, n: i + 1, token: String(p.id).slice(0, 4), title: p.title, monitor: p.monitor }));
          briefBody = String(sv.body || '').slice(0, 2500);
        } catch {}
      }
      if (!proposals.length) proposals = getProposals(db, 3).map((p: any, i: number) => ({ id: p.id, n: i + 1, token: String(p.id).slice(0, 4), title: p.title, monitor: p.monitor }));

      // the action in this thread (matched by the subject Zach saw), plus all open/notified actions
      const inThread = db.prepare("SELECT id, title, monitor FROM ledger WHERE status='open' AND notified_subject = ? ORDER BY notified_at DESC LIMIT 1").get(orig) as any;
      const actions = (db.prepare(
        "SELECT id, title, monitor FROM ledger WHERE status='open' AND (tier='act' OR notified_tier IN ('act','remind')) ORDER BY notified_at IS NULL, notified_at"
      ).all() as any[]).map(a => ({ id: a.id, title: a.title, monitor: a.monitor, inThread: !!inThread && inThread.id === a.id }));
      if (inThread && !actions.find(a => a.id === inThread.id)) actions.unshift({ id: inThread.id, title: inThread.title, monitor: inThread.monitor, inThread: true });

      const ctx: IntentContext = {
        channel: 'email-reply', threadKey: `email:${orig.slice(0, 120)}`,
        repliedTo: { subject: orig, kind, body: briefBody }, proposals, actions, readOnly: isForward,
      };
      const { reply, executed } = await resolveAndExecute(db, text, ctx);
      db.prepare("UPDATE processed_replies SET action=? WHERE message_id=?").run(executed.join(',') || 'none', m.id);

      // confirmation: threaded in ZACH's mailbox via In-Reply-To, never via quinn@'s thread id
      try {
        await sendEmail(db, { to: ME, subject: `Re: ${subject.replace(/^((re|fwd?):\s*)+/i, '')}`.slice(0, 180), body: reply, inReplyTo: messageId || undefined } as any);
      } catch {}
      handled++;
    } catch (e: any) {
      db.prepare("UPDATE processed_replies SET action=? WHERE message_id=?").run(`error:${String(e?.message || e).slice(0, 80)}`, m.id);
    }
  }
  return { handled };
}
