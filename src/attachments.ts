// Attachment index — library-metaphor compliant (Zach, 2026-08-31):
// we index CARDS (filename, sender, thread, ids), never content. Bytes stay
// in Gmail; readAttachment() fetches + extracts text ON DEMAND at reasoning
// time via pdftotext/textutil, returns text, persists nothing.
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getServiceAccountAuth } from './connectors/gmail.js';
import { insertKnowledge } from './db.js';

const MAILBOX = 'zach.stock@recaptureinsurance.com';
const SKIP_FILES = /\.(png|jpe?g|gif|ics|vcf|p7s|asc)$/i;
const SKIP_SENDERS = /noreply|no-reply|donotreply|receipt|invoice\+|billing@|notification/i;

function gmailClient() {
  const auth = getServiceAccountAuth(MAILBOX, ['https://www.googleapis.com/auth/gmail.readonly']);
  if (!auth) throw new Error('Service account not configured for gmail.readonly');
  return google.gmail({ version: 'v1', auth });
}

function walkParts(part: any, out: { filename: string; attachmentId: string; mime: string; size: number }[]) {
  if (part?.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, attachmentId: part.body.attachmentId, mime: part.mimeType || '', size: part.body.size || 0 });
  }
  for (const p of part?.parts || []) walkParts(p, out);
}

// Index cards for messages with real attachments. Incremental via newer_than.
export async function indexAttachments(db: Database.Database, options: { days?: number; max?: number } = {}): Promise<{ indexed: number; scanned: number }> {
  const days = options.days || 2;
  const max = options.max || 60;
  const gmail = gmailClient();
  const q = `has:attachment newer_than:${days}d`;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: max });
  const msgs = list.data.messages || [];
  let indexed = 0;
  const exists = db.prepare("SELECT 1 FROM knowledge WHERE source='attachment-index' AND source_ref = ?");
  for (const m of msgs) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' });
    const headers = Object.fromEntries((msg.data.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]));
    const from = String(headers['from'] || '');
    if (SKIP_SENDERS.test(from)) continue;
    const atts: { filename: string; attachmentId: string; mime: string; size: number }[] = [];
    walkParts(msg.data.payload, atts);
    for (const a of atts) {
      if (SKIP_FILES.test(a.filename) || a.size < 2000) continue;
      const ref = `attachment:${m.id}:${a.filename}`;
      if (exists.get(ref)) continue;
      insertKnowledge(db, {
        id: uuid(),
        title: `Attachment: ${a.filename} (${String(headers['subject'] || '').slice(0, 80)})`,
        summary: `File "${a.filename}" (${a.mime}, ${Math.round(a.size / 1024)}KB) attached to "${headers['subject']}" from ${from.replace(/<[^>]*>/g, '').trim()}. Read contents on demand with prime_read_attachment message_id=${m.id} filename="${a.filename}".`,
        source: 'attachment-index',
        source_ref: ref,
        source_date: headers['date'] ? new Date(String(headers['date'])).toISOString() : new Date().toISOString(),
        contacts: [from.replace(/<[^>]*>/g, '').trim()],
        metadata: {
          message_id: m.id, thread_id: msg.data.threadId, filename: a.filename,
          mime: a.mime, size: a.size, subject: headers['subject'],
        },
      } as any);
      indexed++;
    }
  }
  return { indexed, scanned: msgs.length };
}

// Fetch + extract ONE attachment's text on demand. Nothing persists.
export async function readAttachment(db: Database.Database, messageId: string, filename: string, maxChars = 15000): Promise<string> {
  const gmail = gmailClient();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const atts: { filename: string; attachmentId: string; mime: string; size: number }[] = [];
  walkParts(msg.data.payload, atts);
  const att = atts.find(a => a.filename === filename) || atts.find(a => a.filename.toLowerCase().includes(filename.toLowerCase()));
  if (!att) return `No attachment matching "${filename}" on message ${messageId}. Available: ${atts.map(a => a.filename).join(', ') || 'none'}`;
  if (att.size > 15 * 1024 * 1024) return `Attachment too large (${Math.round(att.size / 1048576)}MB).`;
  const data = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: att.attachmentId });
  const bytes = Buffer.from(String(data.data.data || ''), 'base64url' as any);
  const dir = mkdtempSync(join(tmpdir(), 'att-'));
  const fp = join(dir, att.filename.replace(/[^\w.-]/g, '_'));
  try {
    writeFileSync(fp, bytes);
    let text = '';
    if (/\.pdf$/i.test(att.filename)) {
      text = execFileSync('/opt/homebrew/bin/pdftotext', ['-layout', fp, '-'], { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }).toString();
      if (text.trim().length < 40) text = '(PDF has no text layer — likely a scan; OCR not yet available. File metadata: ' + att.mime + ', ' + Math.round(att.size / 1024) + 'KB)';
    } else if (/\.(docx?|rtf|txt|html?)$/i.test(att.filename)) {
      execFileSync('/usr/bin/textutil', ['-convert', 'txt', fp, '-output', fp + '.txt'], { timeout: 30000 });
      text = execFileSync('/bin/cat', [fp + '.txt'], { maxBuffer: 20 * 1024 * 1024 }).toString();
    } else if (/\.(csv|json|xml)$/i.test(att.filename)) {
      text = bytes.toString('utf-8');
    } else {
      return `Unsupported type for extraction: ${att.filename} (${att.mime}). Gmail link: https://mail.google.com/mail/u/0/#all/${msg.data.threadId}`;
    }
    text = text.trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + `\n\n[truncated — ${text.length} chars total]`;
    return `=== ${att.filename} (${att.mime}, ${Math.round(att.size / 1024)}KB) ===\n${text}`;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
