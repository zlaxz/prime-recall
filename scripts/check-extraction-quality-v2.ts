import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Compare old v1/v2 extractions vs new v3 on the same source type
console.log('=== EXTRACTION QUALITY BY VERSION ===\n');

const stats = db.prepare(`
  SELECT extraction_version as v,
    COUNT(*) as total,
    ROUND(AVG(length(summary))) as avg_summary,
    ROUND(AVG(length(COALESCE(contacts, '[]')))) as avg_contacts,
    SUM(CASE WHEN title LIKE 'Email thread:%' THEN 1 ELSE 0 END) as generic_titles,
    SUM(CASE WHEN contacts IS NULL OR contacts = '[]' OR length(contacts) < 5 THEN 1 ELSE 0 END) as missing_contacts
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];

console.log('Version  Total  AvgSummary  AvgContacts  GenericTitles  MissingContacts');
for (const s of stats) {
  console.log(
    `v${s.v || 'null'}`.padEnd(9) +
    String(s.total).padStart(5) +
    String(s.avg_summary).padStart(12) +
    String(s.avg_contacts).padStart(13) +
    `${s.generic_titles} (${Math.round(s.generic_titles/s.total*100)}%)`.padStart(16) +
    `${s.missing_contacts} (${Math.round(s.missing_contacts/s.total*100)}%)`.padStart(18)
  );
}

// Sample v3 extractions to check quality
console.log('\n=== SAMPLE v3 EXTRACTIONS (most recent) ===\n');
const samples = db.prepare(`
  SELECT title, summary, contacts, source_date
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
  AND length(summary) > 100
  ORDER BY updated_at DESC LIMIT 5
`).all() as any[];

for (const s of samples) {
  console.log(`[${s.source_date?.slice(0, 10)}] ${s.title}`);
  console.log(`  Summary: ${s.summary?.slice(0, 150)}`);
  console.log(`  Contacts: ${s.contacts}`);
  console.log('');
}

// Check for v3 items that still have bad quality
const badV3 = db.prepare(`
  SELECT COUNT(*) as c FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
  AND (title LIKE 'Email thread:%' OR contacts IS NULL OR contacts = '[]' OR length(summary) < 50)
`).get() as any;
const totalV3 = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND extraction_version = 3`).get() as any;
console.log(`v3 items with remaining quality issues: ${badV3.c}/${totalV3.c} (${Math.round(badV3.c/totalV3.c*100)}%)`);

db.close();
