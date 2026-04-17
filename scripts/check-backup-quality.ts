import Database from 'better-sqlite3';

// Check the backup — does it have the v2 extractions intact?
const backup = new Database(process.env.HOME + '/.prime/prime.db.bak-dedup-20260415130646');

const stats = backup.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    ROUND(AVG(length(summary))) as avg_sum,
    SUM(CASE WHEN contacts IS NULL OR contacts = '[]' OR length(contacts) < 5 THEN 1 ELSE 0 END) as missing_contacts
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];

console.log('=== BACKUP DATABASE (pre-re-extraction) ===\n');
console.log('Version  Count  AvgSummary  MissingContacts');
for (const s of stats) {
  console.log(`v${s.v || 'null'}`.padEnd(9) + String(s.c).padStart(5) + String(s.avg_sum).padStart(12) + `  ${s.missing_contacts} (${Math.round(s.missing_contacts/s.c*100)}%)`);
}

// Check current DB for comparison
const current = new Database(process.env.HOME + '/.prime/prime.db');
const currentStats = current.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    ROUND(AVG(length(summary))) as avg_sum,
    SUM(CASE WHEN contacts IS NULL OR contacts = '[]' OR length(contacts) < 5 THEN 1 ELSE 0 END) as missing_contacts
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];

console.log('\n=== CURRENT DATABASE ===\n');
console.log('Version  Count  AvgSummary  MissingContacts');
for (const s of currentStats) {
  console.log(`v${s.v || 'null'}`.padEnd(9) + String(s.c).padStart(5) + String(s.avg_sum).padStart(12) + `  ${s.missing_contacts} (${Math.round(s.missing_contacts/s.c*100)}%)`);
}

backup.close();
current.close();
