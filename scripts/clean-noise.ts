/**
 * clean-noise.ts — Delete obvious spam/marketing noise from knowledge base.
 * Conservative: only removes items that are clearly not business-relevant.
 *
 * Run: npx tsx scripts/clean-noise.ts [--dry-run]
 */

import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const DRY_RUN = process.argv.includes('--dry-run');

console.log('╔══════════════════════════════════════════╗');
console.log('║   PRIME KNOWLEDGE BASE — NOISE CLEANUP   ║');
console.log(`║   Mode: ${DRY_RUN ? 'DRY RUN (no deletes)' : '🔴 LIVE — WILL DELETE'}       ║`);
console.log('╚══════════════════════════════════════════╝\n');

const totalBefore = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any).c;
console.log(`Total items before: ${totalBefore}\n`);

// ═══════════════════════════════════════════
// Category 1: Title-based noise patterns
// ═══════════════════════════════════════════

const titlePatterns = [
  // Explicit spam/marketing
  { label: 'Unsubscribe mentions', where: `title LIKE '%unsubscribe%'` },
  { label: 'Mailsuite', where: `title LIKE '%Mailsuite%'` },
  { label: 'SeatGeek', where: `title LIKE '%SeatGeek%'` },
  { label: 'Gusto new tasks/autopilot', where: `title LIKE '%Gusto new tasks%' OR title LIKE '%Payroll on AutoPilot%'` },
  { label: 'pdfFiller', where: `title LIKE '%pdfFiller%'` },
  { label: 'Frank Kern', where: `title LIKE '%Frank Kern%'` },
  { label: 'Supabase security vulns', where: `title LIKE '%Security vulnerabilities detected in your Supabase%'` },
  { label: 'Security Advisor Summary', where: `title LIKE '%Security Advisor Summary%'` },
  { label: 'Workers comp payment reminder', where: `title LIKE '%workers_ compensation payment%'` },
];

// ═══════════════════════════════════════════
// Category 2: Sender-based noise (from metadata)
// Only clear marketing/notification senders — NOT business contacts
// ═══════════════════════════════════════════

const senderPatterns = [
  // Restaurant/food
  { label: 'OTTO Portland (Toast)', where: `json_extract(metadata, '$.from') LIKE '%toast-restaurants.com%'` },
  // Airlines
  { label: 'United Airlines notifications', where: `json_extract(metadata, '$.from') LIKE '%notifications@united.com%'` },
  // General marketing — NOT industry newsletters (those might be useful)
  { label: 'Google Workspace noreply', where: `json_extract(metadata, '$.from') LIKE '%workspace-noreply@google.com%'` },
  { label: 'ZoomInfo no-reply', where: `json_extract(metadata, '$.from') LIKE '%no-reply@zoominfo.com%'` },
  { label: 'Indeed employers noreply', where: `json_extract(metadata, '$.from') LIKE '%employers-noreply@mc.indeed.com%'` },
  { label: 'Vercel notifications', where: `json_extract(metadata, '$.from') LIKE '%notifications@vercel.com%'` },
  { label: 'Cloudflare noreply', where: `json_extract(metadata, '$.from') LIKE '%noreply@notify.cloudflare.com%'` },
  { label: 'Claude Team noreply', where: `json_extract(metadata, '$.from') LIKE '%no-reply@email.claude.com%'` },
  { label: 'Mineral noreply (HR platform)', where: `json_extract(metadata, '$.from') LIKE '%noreply@trustmineral.com%'` },
  { label: 'Gusto automated', where: `json_extract(metadata, '$.from') LIKE '%automated@gusto.com%'` },
  { label: 'Supabase noreply', where: `json_extract(metadata, '$.from') LIKE '%noreply@supabase.com%'` },
];

// ═══════════════════════════════════════════
// Category 3: [NOISE]-tagged items (already identified)
// ═══════════════════════════════════════════

const noiseTagged = [
  { label: '[NOISE] title', where: `title = '[NOISE]'` },
];

const allPatterns = [...titlePatterns, ...senderPatterns, ...noiseTagged];

let totalDeleted = 0;
const report: { label: string; count: number }[] = [];

console.log('─── Deletion Report ───\n');

for (const p of allPatterns) {
  const count = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE ${p.where}`).get() as any).c;
  if (count > 0) {
    if (!DRY_RUN) {
      db.prepare(`DELETE FROM knowledge WHERE ${p.where}`).run();
    }
    totalDeleted += count;
    report.push({ label: p.label, count });
    console.log(`  ${DRY_RUN ? 'Would delete' : 'Deleted'}: ${count} — ${p.label}`);
  }
}

console.log('\n─── Summary ───\n');
console.log(`Total items ${DRY_RUN ? 'to delete' : 'deleted'}: ${totalDeleted}`);
console.log(`Items remaining: ${totalBefore - (DRY_RUN ? 0 : totalDeleted)}`);
console.log(`Cleanup rate: ${Math.round(totalDeleted / totalBefore * 100)}% of knowledge base\n`);

if (DRY_RUN) {
  console.log('Run without --dry-run to actually delete these items.');
}

db.close();
