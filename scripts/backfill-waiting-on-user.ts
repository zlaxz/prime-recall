/**
 * Backfill waiting_on_user on legacy gmail rows.
 *
 * Legacy rows (pre-field extraction, ~Feb 2025 – Apr 2026) carry
 * {from, to, subject, message_count, raw_body_length} in metadata and no
 * thread_id / last_from / waiting_on_user, so getBallLists() in ledger.ts
 * cannot see them. This sets waiting_on_user deterministically from the
 * thread's last sender — no LLM involved.
 *
 * Per row:
 *   1. metadata.last_from present                       → decide from it
 *   2. else a thread id (metadata.thread_id, or source_ref 'thread:<id>')
 *                                                        → fetch last sender live from Gmail
 *   3. else                                              → leave untouched
 *
 * waiting_on_user = true when the last sent (non-draft) message is from someone
 * other than Zach and not a bot / no-reply / own-agent sender; false otherwise.
 *
 * Writes only the metadata column, only on rows still lacking the flag, and only
 * if the metadata is byte-identical to what was read (a concurrent gmail sync wins).
 *
 * Usage (from repo root):
 *   npx tsx scripts/backfill-waiting-on-user.ts --dry-run
 *   npx tsx scripts/backfill-waiting-on-user.ts
 * Options: --limit N   --concurrency N (default 5)
 */
import { google } from 'googleapis';
import { getDb } from '../src/db.js';
import { getServiceAccountAuth } from '../src/connectors/gmail.js';

const USER_EMAIL = 'zach.stock@recaptureinsurance.com';
const BACKFILL_DATE = '2026-08-31';
// Nothing is owed to bots or to Zach's own agents.
const BOT_SENDER = /noreply|no-reply|do-?not-?reply|notification|mailer-daemon|postmaster|quinn@recaptureinsurance\.com/i;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argVal = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = Number(argVal('--limit') || 0);
const CONCURRENCY = Number(argVal('--concurrency') || 5);

type Row = { id: string; source_ref: string; metadata: string };
type Decision = {
  id: string; subject: string; method: 'last_from' | 'gmail'; lastFrom: string;
  waiting: boolean; botSuppressed: boolean; threadId: string | null; trailingDraft: boolean;
  originalMeta: string; meta: any;
};

function decide(lastFrom: string): { waiting: boolean; botSuppressed: boolean } {
  const lf = lastFrom.toLowerCase();
  if (lf.includes('zach.stock@')) return { waiting: false, botSuppressed: false };
  if (BOT_SENDER.test(lf)) return { waiting: false, botSuppressed: true };
  return { waiting: true, botSuppressed: false };
}

const header = (msg: any, name: string): string =>
  (msg?.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value || '';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Fetched = { lastFrom: string; trailingDraft: boolean; messageCount: number };

async function fetchLastSender(gmail: any, threadId: string): Promise<Fetched | 'notfound' | 'empty'> {
  for (let attempt = 0; ; attempt++) {
    try {
      const t = await gmail.users.threads.get({
        userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From', 'Date'],
      });
      const msgs: any[] = t.data.messages || [];
      // A draft is not sent — a half-written reply must not count as Zach having replied.
      const sent = msgs.filter(m => !(m.labelIds || []).includes('DRAFT'));
      const last = sent[sent.length - 1];
      if (!last) return 'empty';
      return { lastFrom: header(last, 'From'), trailingDraft: sent.length !== msgs.length, messageCount: sent.length };
    } catch (e: any) {
      const status = Number(e?.response?.status ?? e?.code);
      if (status === 404) return 'notfound';
      if (attempt >= 3) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function main() {
  const db = getDb();
  const countByFlag = () => db.prepare(
    `SELECT json_extract(metadata,'$.waiting_on_user') w, COUNT(*) n FROM knowledge WHERE source='gmail' GROUP BY w`
  ).all();
  console.log('BEFORE:', JSON.stringify(countByFlag()));

  let sql = `SELECT id, source_ref, metadata FROM knowledge
             WHERE source='gmail' AND json_extract(metadata,'$.waiting_on_user') IS NULL
             ORDER BY source_date DESC`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const rows = db.prepare(sql).all() as Row[];
  console.log(`Candidates: ${rows.length}${DRY_RUN ? '  (dry run — no writes)' : ''}`);

  const counts = {
    last_from: 0, gmail: 0,
    skipped_no_thread_id: 0, skipped_404: 0, skipped_empty_thread: 0, skipped_error: 0, skipped_bad_json: 0,
    bot_suppressed: 0, trailing_draft_ignored: 0,
    legacy_from_matches_gmail_single_msg: 0, legacy_from_differs_gmail_single_msg: 0,
  };
  const decisions: Decision[] = [];
  const errors: string[] = [];

  // Pass 1: rows that already carry last_from need no network.
  const needFetch: { row: Row; meta: any; threadId: string }[] = [];
  for (const row of rows) {
    let meta: any;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { counts.skipped_bad_json++; continue; }
    if (meta.waiting_on_user !== undefined && meta.waiting_on_user !== null) continue;
    const lastFrom = typeof meta.last_from === 'string' ? meta.last_from.trim() : '';
    if (lastFrom) {
      const d = decide(lastFrom);
      counts.last_from++;
      if (d.botSuppressed) counts.bot_suppressed++;
      decisions.push({ id: row.id, subject: meta.subject || '', method: 'last_from', lastFrom, ...d,
        threadId: typeof meta.thread_id === 'string' ? meta.thread_id : null, trailingDraft: false,
        originalMeta: row.metadata, meta });
      continue;
    }
    const threadId = (typeof meta.thread_id === 'string' && meta.thread_id)
      || (row.source_ref?.startsWith('thread:') ? row.source_ref.slice('thread:'.length) : '');
    if (!threadId) { counts.skipped_no_thread_id++; continue; }
    needFetch.push({ row, meta, threadId });
  }

  // Pass 2: live Gmail lookup for the rest, a few at a time.
  if (needFetch.length) {
    const auth = getServiceAccountAuth(USER_EMAIL, ['https://www.googleapis.com/auth/gmail.readonly']);
    if (!auth) throw new Error('Service account not found in ~/.prime');
    const gmail = google.gmail({ version: 'v1', auth });
    console.log(`Fetching last sender for ${needFetch.length} threads (concurrency ${CONCURRENCY})...`);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < needFetch.length) {
        const item = needFetch[next++];
        try {
          const r = await fetchLastSender(gmail, item.threadId);
          if (r === 'notfound') counts.skipped_404++;
          else if (r === 'empty') counts.skipped_empty_thread++;
          else if (!r.lastFrom) counts.skipped_empty_thread++;
          else {
            const d = decide(r.lastFrom);
            counts.gmail++;
            if (d.botSuppressed) counts.bot_suppressed++;
            if (r.trailingDraft) counts.trailing_draft_ignored++;
            if (item.meta.message_count === 1 && r.messageCount === 1 && typeof item.meta.from === 'string') {
              if (item.meta.from.trim() === r.lastFrom.trim()) counts.legacy_from_matches_gmail_single_msg++;
              else counts.legacy_from_differs_gmail_single_msg++;
            }
            decisions.push({ id: item.row.id, subject: item.meta.subject || '', method: 'gmail', lastFrom: r.lastFrom, ...d,
              threadId: item.threadId, trailingDraft: r.trailingDraft, originalMeta: item.row.metadata, meta: item.meta });
          }
        } catch (e: any) {
          counts.skipped_error++;
          errors.push(`${item.threadId}: ${String(e?.message || e).slice(0, 140)}`);
        }
        if (++done % 100 === 0) console.log(`  ${done}/${needFetch.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, needFetch.length) }, worker));
  }

  const owed = decisions.filter(d => d.waiting).length;
  console.log('\nMethod breakdown:', JSON.stringify(counts, null, 2));
  console.log(`Decisions: ${decisions.length}  →  waiting_on_user=1: ${owed}   waiting_on_user=0: ${decisions.length - owed}`);
  if (errors.length) console.log('Errors (first 10):\n  ' + errors.slice(0, 10).join('\n  '));

  const fmt = (d: Decision) =>
    `  [${d.method}] ${d.waiting ? 1 : 0}${d.botSuppressed ? ' (bot)' : ''}${d.trailingDraft ? ' (draft ignored)' : ''}` +
    `  from="${d.lastFrom.slice(0, 55)}"  subj="${d.subject.slice(0, 60)}"`;
  console.log('\nSample decisions (waiting_on_user=1):');
  decisions.filter(d => d.waiting).slice(0, 5).forEach(d => console.log(fmt(d)));
  console.log('Sample decisions (waiting_on_user=0):');
  decisions.filter(d => !d.waiting).slice(0, 5).forEach(d => console.log(fmt(d)));

  if (DRY_RUN) { console.log('\nDRY RUN — nothing written.'); return; }

  const upd = db.prepare(
    `UPDATE knowledge SET metadata = ?
     WHERE id = ? AND metadata = ? AND json_extract(metadata,'$.waiting_on_user') IS NULL`
  );
  let written = 0, raced = 0;
  db.transaction(() => {
    for (const d of decisions) {
      const merged: any = { ...d.meta, waiting_on_user: d.waiting, last_from: d.lastFrom, waiting_on_user_backfilled: BACKFILL_DATE };
      // getBallLists keys on metadata.thread_id; legacy rows only have it in source_ref.
      if (!merged.thread_id && d.threadId) merged.thread_id = d.threadId;
      const res = upd.run(JSON.stringify(merged), d.id, d.originalMeta);
      if (res.changes === 1) written++; else raced++;
    }
  })();
  console.log(`\nWritten: ${written}   skipped because metadata changed underneath: ${raced}`);
  console.log('AFTER:', JSON.stringify(countByFlag()));
}

main().catch(e => { console.error(e); process.exit(1); });
