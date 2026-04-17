import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Old extraction (v1, before today's fix)
console.log('=== OLD EXTRACTION (v1, snippet-based) ===\n');
const old = db.prepare(`
  SELECT title, summary, contacts, extraction_version, source_date
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 1
  ORDER BY source_date DESC LIMIT 3
`).all() as any[];
for (const o of old) {
  console.log(`[v${o.extraction_version}] ${o.source_date?.slice(0, 10)}`);
  console.log(`  Title: ${o.title?.slice(0, 80)}`);
  console.log(`  Summary: ${o.summary?.slice(0, 120)}`);
  console.log(`  Contacts: ${o.contacts}`);
  console.log('');
}

// New extraction (v3, from today's full-body re-extraction)
console.log('=== NEW EXTRACTION (v3, full-body) ===\n');
const fresh = db.prepare(`
  SELECT title, summary, contacts, extraction_version, source_date
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3 AND source_date >= '2026-04-10'
  ORDER BY source_date DESC LIMIT 3
`).all() as any[];
for (const f of fresh) {
  console.log(`[v${f.extraction_version}] ${f.source_date?.slice(0, 10)}`);
  console.log(`  Title: ${f.title?.slice(0, 80)}`);
  console.log(`  Summary: ${f.summary?.slice(0, 200)}`);
  console.log(`  Contacts: ${f.contacts}`);
  console.log('');
}

// Stats
const stats = db.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    ROUND(AVG(length(summary))) as avg_sum,
    ROUND(AVG(length(COALESCE(contacts, '[]')))) as avg_con
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];
console.log('=== QUALITY COMPARISON ===\n');
console.log('Version  Count  AvgSummary  AvgContacts');
for (const s of stats) {
  console.log(`v${s.v || 'null'}`.padEnd(9) + String(s.c).padStart(5) + String(s.avg_sum).padStart(12) + String(s.avg_con).padStart(13));
}

db.close();
