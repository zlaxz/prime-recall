/**
 * flag-reextract.ts — Flag low-quality items for re-extraction.
 * Does NOT re-extract (expensive). Adds 'needs_reextraction' tag so they can
 * be batch-processed later.
 *
 * Run: npx tsx scripts/flag-reextract.ts [--dry-run]
 */

import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const DRY_RUN = process.argv.includes('--dry-run');

console.log('╔══════════════════════════════════════════╗');
console.log('║   PRIME — FLAG ITEMS FOR RE-EXTRACTION   ║');
console.log(`║   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE — WILL UPDATE TAGS'}       ║`);
console.log('╚══════════════════════════════════════════╝\n');

const totalItems = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any).c;
console.log(`Total items: ${totalItems}\n`);

// ═══════════════════════════════════════════
// Find items that need re-extraction (union of criteria)
// ═══════════════════════════════════════════

const criteria = [
  {
    label: 'Generic "Email thread:" titles',
    where: `title LIKE 'Email thread:%'`,
  },
  {
    label: 'Missing/empty contacts (gmail only)',
    where: `source IN ('gmail', 'gmail-sent') AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)`,
  },
  {
    label: 'Extraction v1 or NULL (oldest quality)',
    where: `(extraction_version = 1 OR extraction_version IS NULL)`,
  },
];

// Report per-criterion counts (items can match multiple)
console.log('─── Criteria Breakdown (overlapping) ───\n');
for (const c of criteria) {
  const count = (db.prepare(`SELECT COUNT(*) as cnt FROM knowledge WHERE ${c.where}`).get() as any).cnt;
  console.log(`  ${count} items — ${c.label}`);
}

// Build the union query for distinct IDs matching ANY criterion
const unionWhere = criteria.map(c => `(${c.where})`).join(' OR ');

// Count unique items to flag
const flagCount = (db.prepare(
  `SELECT COUNT(*) as cnt FROM knowledge WHERE (${unionWhere}) AND tags NOT LIKE '%needs_reextraction%'`
).get() as any).cnt;

const alreadyFlagged = (db.prepare(
  `SELECT COUNT(*) as cnt FROM knowledge WHERE tags LIKE '%needs_reextraction%'`
).get() as any).cnt;

console.log(`\n  Already flagged: ${alreadyFlagged}`);
console.log(`  New items to flag: ${flagCount}`);
console.log(`  Total will be flagged: ${alreadyFlagged + flagCount}\n`);

// ═══════════════════════════════════════════
// Breakdown by extraction version
// ═══════════════════════════════════════════

console.log('─── By Extraction Version ───\n');
const byVersion = db.prepare(`
  SELECT extraction_version as v, COUNT(*) as c
  FROM knowledge
  WHERE ${unionWhere}
  GROUP BY extraction_version
  ORDER BY extraction_version
`).all() as any[];

for (const row of byVersion) {
  console.log(`  v${row.v ?? 'NULL'}: ${row.c} items`);
}

// ═══════════════════════════════════════════
// Breakdown by date range
// ═══════════════════════════════════════════

console.log('\n─── By Source Date Range ───\n');
const byDateRange = db.prepare(`
  SELECT
    CASE
      WHEN source_date IS NULL THEN 'no date'
      WHEN source_date < '2024-01-01' THEN 'before 2024'
      WHEN source_date < '2025-01-01' THEN '2024'
      WHEN source_date < '2025-07-01' THEN '2025 H1'
      WHEN source_date < '2026-01-01' THEN '2025 H2'
      ELSE '2026+'
    END as period,
    COUNT(*) as c
  FROM knowledge
  WHERE ${unionWhere}
  GROUP BY period
  ORDER BY period
`).all() as any[];

for (const row of byDateRange) {
  console.log(`  ${row.period}: ${row.c} items`);
}

// ═══════════════════════════════════════════
// Breakdown by source
// ═══════════════════════════════════════════

console.log('\n─── By Source ───\n');
const bySource = db.prepare(`
  SELECT source, COUNT(*) as c
  FROM knowledge
  WHERE ${unionWhere}
  GROUP BY source
  ORDER BY c DESC
  LIMIT 10
`).all() as any[];

for (const row of bySource) {
  console.log(`  ${row.source}: ${row.c} items`);
}

// ═══════════════════════════════════════════
// Apply the tag
// ═══════════════════════════════════════════

if (!DRY_RUN && flagCount > 0) {
  console.log('\n─── Applying Tags ───\n');

  // For items with existing tags array, append the tag
  // tags is a JSON array string like '["foo","bar"]'
  const updateWithTags = db.prepare(`
    UPDATE knowledge
    SET tags = CASE
      WHEN tags IS NULL OR tags = '[]' THEN '["needs_reextraction"]'
      ELSE substr(tags, 1, length(tags) - 1) || ',"needs_reextraction"]'
    END,
    updated_at = datetime('now')
    WHERE (${unionWhere})
      AND tags NOT LIKE '%needs_reextraction%'
  `);

  const result = updateWithTags.run();
  console.log(`  Tagged ${result.changes} items with 'needs_reextraction'`);
} else if (DRY_RUN) {
  console.log('\n  Dry run — no tags applied. Run without --dry-run to tag items.');
}

// ═══════════════════════════════════════════
// Final summary
// ═══════════════════════════════════════════

const finalFlagged = (db.prepare(
  `SELECT COUNT(*) as cnt FROM knowledge WHERE tags LIKE '%needs_reextraction%'`
).get() as any).cnt;

console.log(`\n─── Final State ───\n`);
console.log(`  Total items: ${totalItems}`);
console.log(`  Flagged for re-extraction: ${finalFlagged}`);
console.log(`  Percentage flagged: ${Math.round(finalFlagged / totalItems * 100)}%\n`);

db.close();
