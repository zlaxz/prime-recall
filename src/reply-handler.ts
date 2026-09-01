// Reply handler — Zach answers Prime by replying to its emails.
//
// Transport only: reads Zach's own sent mail addressed to quinn@ (service
// account impersonating Zach), builds the context of what he replied to, and
// hands his words to the shared intent layer (src/intent.ts). Sends a one-line
// confirmation back IN THREAD to Zach only. Each message handled exactly once.
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

// Zach's new text only — strip quoted originals across Gmail/Apple Mail/Outlook styles
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
    /\nFrom:\s.+\nSent:/i, /\nSent from my (iPhone|iPad|Galaxy)/i, /\n_{5,}/,
  ];
  for (const re of cut) { const m = text.match(re); if (m && m.index !== undefined && m.index > 0) text = text.slice(0, m.index); }
  return text.replace(/\s+/g, ' ').trim();
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
    const threadId = String(msg.data.threadId || m.id);
    const text = bodyText(msg.data.payload);
    if (!text) { db.prepare("INSERT OR IGNORE INTO processed_replies (message_id, action) VALUES (?, 'empty')").run(m.id); continue; }

    // ── Context: what did he reply to? ──
    const orig = subject.replace(/^(re|fwd?):\s*/i, '').trim();
    const kind: 'brief' | 'act' | 'remind' | 'system' | 'other' =
      /^\[BRIEF\]/i.test(orig) ? 'brief' : /^\[ACT/i.test(orig) ? 'act' : /^\[REMIND/i.test(orig) ? 'remind' : /^\[SYSTEM\]|^MECHANIC/i.test(orig) ? 'system' : 'other';
    // proposals as numbered in the brief he replied to (snapshot), else current order
    let proposals: IntentContext['proposals'] = [];
    const snap = (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(`brief_thread:${threadId}`) as any)?.value;
    if (snap) {
      try { proposals = (JSON.parse(snap).proposals || []).map((p: any, i: number) => ({ id: p.id, n: i + 1, title: p.title, monitor: p.monitor })); } catch {}
    }
    if (!proposals.length) proposals = getProposals(db, 3).map((p: any, i: number) => ({ id: p.id, n: i + 1, title: p.title, monitor: p.monitor }));
    const inThread = db.prepare("SELECT id FROM ledger WHERE status='open' AND (notified_thread_id = ? OR notified_subject = ?) LIMIT 1").get(threadId, orig) as any;
    const actions = (db.prepare("SELECT id, title, monitor FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, notified_at").all() as any[])
      .map(a => ({ id: a.id, title: a.title, monitor: a.monitor, inThread: !!inThread && inThread.id === a.id }));
    const briefBody = kind === 'brief' ? String((db.prepare("SELECT value FROM graph_state WHERE key = 'cos_email_body'").get() as any)?.value || '').slice(0, 2500) : undefined;

    const ctx: IntentContext = { channel: 'email-reply', threadKey: threadId, repliedTo: { subject: orig, kind, body: briefBody }, proposals, actions };
    const { reply, executed } = await resolveAndExecute(db, text, ctx);

    db.prepare("INSERT OR IGNORE INTO processed_replies (message_id, action) VALUES (?, ?)").run(m.id, executed.join(',') || 'none');
    try { await sendEmail(db, { to: ME, subject: `Re: ${orig}`.slice(0, 180), body: reply, replyToThreadId: threadId }); } catch {}
    handled++;
  }
  return { handled };
}
