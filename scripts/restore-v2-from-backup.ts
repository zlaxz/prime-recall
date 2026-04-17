import Database from 'better-sqlite3';

const current = new Database(process.env.HOME + '/.prime/prime.db');
const backup = new Database(process.env.HOME + '/.prime/prime.db.bak-dedup-20260415130646');

// Find v2 items in backup that are now v3 in current with worse quality
const backupV2 = backup.prepare(`
  SELECT id, title, summary, contacts, organizations, decisions, commitments,
    action_items, tags, project, importance, extraction_version
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 2
`).all() as any[];

console.log(`Backup has ${backupV2.length} v2 gmail items`);

let restored = 0;
let skipped = 0;
let notFound = 0;

for (const bItem of backupV2) {
  // Check if this item exists in current DB and was degraded
  const currentItem = current.prepare(`
    SELECT id, extraction_version, length(summary) as sum_len,
      contacts, length(COALESCE(contacts, '')) as con_len
    FROM knowledge WHERE id = ?
  `).get(bItem.id) as any;

  if (!currentItem) {
    notFound++;
    continue;
  }

  // Only restore if current is v3 AND has worse quality
  if (currentItem.extraction_version === 3) {
    const currentHasContacts = currentItem.contacts && currentItem.contacts !== '[]' && currentItem.con_len > 5;
    const backupHasContacts = bItem.contacts && bItem.contacts !== '[]' && bItem.contacts.length > 5;

    // Restore if backup had contacts and current doesn't, OR if current summary is shorter
    if ((backupHasContacts && !currentHasContacts) || (currentItem.sum_len < bItem.summary.length * 0.5)) {
      current.prepare(`
        UPDATE knowledge SET
          title = ?, summary = ?, contacts = ?, organizations = ?,
          decisions = ?, commitments = ?, action_items = ?, tags = ?,
          project = ?, importance = ?, extraction_version = 2
        WHERE id = ?
      `).run(
        bItem.title, bItem.summary, bItem.contacts, bItem.organizations,
        bItem.decisions, bItem.commitments, bItem.action_items, bItem.tags,
        bItem.project, bItem.importance, bItem.id
      );
      restored++;
    } else {
      skipped++; // v3 is same or better quality
    }
  } else {
    skipped++; // Still v2, wasn't overwritten
  }
}

console.log(`\nRestored: ${restored} (v2 quality was better than v3)`);
console.log(`Skipped: ${skipped} (v3 quality was same or better, or still v2)`);
console.log(`Not found: ${notFound} (item deleted from current DB)`);

// Verify
const afterStats = current.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    SUM(CASE WHEN contacts IS NULL OR contacts = '[]' OR length(contacts) < 5 THEN 1 ELSE 0 END) as missing
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];
console.log('\nAfter restoration:');
for (const s of afterStats) {
  console.log(`  v${s.v}: ${s.c} items, ${s.missing} missing contacts (${Math.round(s.missing/s.c*100)}%)`);
}

backup.close();
current.close();
