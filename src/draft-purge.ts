// Purge unused Gmail drafts — SAFE semantics: messages.trash (recoverable 30 days), NEVER drafts.delete.
// Modes:
//   junk     — drafts with no recipient AND no subject, or "test…" subjects sent to self (always safe)
//   resolved — drafts matching a ledger item that is now resolved/dismissed (system-caused, no longer needed)
//   stale    — drafts older than staleDays that match ANY Prime ledger item (default 14)
// Personal drafts (no ledger match) are NEVER touched by resolved/stale.
// Requires gmail.modify in the service account's domain-wide delegation.
import { getServiceAccountAuth } from './connectors/gmail.js';
import { google } from 'googleapis';
import { getDb } from './db.js';

export interface PurgeResult { trashed: number; kept: number; lines: string[] }

export async function purgeDrafts(
  mode: 'junk' | 'resolved' | 'stale',
  opts: { dry?: boolean; staleDays?: number } = {}
): Promise<PurgeResult> {
  const dry = !!opts.dry;
  const staleDays = opts.staleDays && opts.staleDays > 0 ? opts.staleDays : 14;
  const SELF = /zstockco@gmail|zach\.stock@recaptureinsurance|zstock@stockinsgroup/i;

  const auth = getServiceAccountAuth('zach.stock@recaptureinsurance.com', [
    'https://www.googleapis.com/auth/gmail.modify',
  ]);
  const gmail = google.gmail({ version: 'v1', auth });
  const db = getDb();

  const ledgerRows = db.prepare(
    "SELECT title, counterparty, status FROM ledger WHERE monitor <> 'claude-session'"
  ).all() as any[];
  const words = (s: string) => (s || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  function ledgerMatch(subject: string): { matched: boolean; closed: boolean } {
    const sw = new Set(words(subject));
    if (!sw.size) return { matched: false, closed: false };
    for (const r of ledgerRows) {
      const tw = [...words(r.title), ...words(r.counterparty || '')];
      const hits = tw.filter(w => sw.has(w)).length;
      if (hits >= 3) return { matched: true, closed: r.status === 'resolved' || r.status === 'dismissed' };
    }
    return { matched: false, closed: false };
  }

  const list = await gmail.users.drafts.list({ userId: 'me', maxResults: 200 });
  const out: PurgeResult = { trashed: 0, kept: 0, lines: [] };
  for (const d of list.data.drafts || []) {
    const full = await gmail.users.drafts.get({ userId: 'me', id: d.id!, format: 'metadata' });
    const msg = full.data.message!;
    const h = (n: string) => msg.payload?.headers?.find((x: any) => x.name?.toLowerCase() === n)?.value || '';
    const to = h('to'), subject = h('subject');
    const ageDays = msg.internalDate ? (Date.now() - Number(msg.internalDate)) / 86400000 : 0;

    let kill = false, why = '';
    if (mode === 'junk') {
      if (!to.trim() && !subject.trim()) { kill = true; why = 'empty'; }
      else if (/^test(ing)?\b/i.test(subject) && SELF.test(to)) { kill = true; why = 'test-to-self'; }
    } else if (mode === 'resolved') {
      const m = ledgerMatch(subject);
      if (m.matched && m.closed && ageDays > 2) { kill = true; why = 'ledger item closed'; }
    } else if (mode === 'stale') {
      const m = ledgerMatch(subject);
      if (m.matched && ageDays > staleDays) { kill = true; why = `prime-related, ${Math.round(ageDays)}d old`; }
    }

    if (kill) {
      out.trashed++;
      out.lines.push(`${dry ? 'WOULD TRASH' : 'TRASHED'} [${why}] ${msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : '?'} | to:${to.slice(0, 40)} | ${subject.slice(0, 55)}`);
      if (!dry) await gmail.users.messages.trash({ userId: 'me', id: msg.id! });
    } else out.kept++;
  }
  return out;
}

// CLI: npx tsx src/draft-purge.ts junk --dry
if (process.argv[1] && /draft-purge\.(ts|js)$/.test(process.argv[1])) {
  const mode = (process.argv[2] || 'junk') as any;
  purgeDrafts(mode, { dry: process.argv.includes('--dry') })
    .then(r => { r.lines.forEach(l => console.log(l)); console.log(`[${mode}] trashed:${r.trashed} kept:${r.kept}`); })
    .catch(e => { console.error('ERR', e.message); process.exit(1); });
}
