import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Get a sample of the 404 threads — check their source_account
const samples = db.prepare(`
  SELECT source_ref, source_account, title, source_date
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
    AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)
  ORDER BY source_date DESC LIMIT 10
`).all() as any[];

console.log('Sample 404 threads — checking source_account:\n');
for (const s of samples) {
  console.log(`  ${s.source_date?.slice(0,10)} | account: ${s.source_account || 'NULL'} | "${s.title?.slice(0,50)}"`);
}

// Count by source_account
const byCcount = db.prepare(`
  SELECT source_account, COUNT(*) as c
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
    AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)
  GROUP BY source_account
`).all() as any[];
console.log('\n404-prone items by account:');
for (const b of byCcount) console.log(`  ${b.source_account || 'NULL'}: ${b.c}`);

db.close();
