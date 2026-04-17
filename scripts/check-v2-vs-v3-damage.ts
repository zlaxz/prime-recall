import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// How many v3 items have WORSE quality than what v2 would have had?
// v2: 0% missing contacts, 257 avg summary
// v3: 66% missing contacts, 154 avg summary

// Check if we have any v2 items left to compare against
const v2count = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND extraction_version = 2`).get() as any).c;
const v3count = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND extraction_version = 3`).get() as any).c;
console.log(`v2 remaining: ${v2count}`);
console.log(`v3 (re-extracted): ${v3count}`);

// v3 items with missing contacts AND short summaries — these were likely degraded
const degraded = db.prepare(`
  SELECT COUNT(*) as c FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
  AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)
  AND length(summary) < 100
`).get() as any;
console.log(`\nLikely degraded (v3 with missing contacts AND short summary): ${degraded.c}`);

// Can we tell when they were re-extracted?
const recentV3 = db.prepare(`
  SELECT COUNT(*) as c FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
  AND updated_at >= '2026-04-16'
`).get() as any;
console.log(`v3 items updated today (Apr 16): ${recentV3.c}`);

// The real question: did the re-extraction script preserve the old data or overwrite?
// Check a sample degraded item
const sample = db.prepare(`
  SELECT id, title, summary, contacts, source_date, updated_at
  FROM knowledge
  WHERE source = 'gmail' AND extraction_version = 3
  AND (contacts IS NULL OR contacts = '[]')
  AND length(summary) < 60
  ORDER BY source_date DESC LIMIT 3
`).all() as any[];
console.log('\nSample degraded items:');
for (const s of sample) {
  console.log(`  ${s.source_date?.slice(0,10)} "${s.title?.slice(0,60)}"`);
  console.log(`    summary: "${s.summary?.slice(0,80)}" (${s.summary?.length} chars)`);
  console.log(`    contacts: ${s.contacts}`);
  console.log(`    updated: ${s.updated_at}`);
}

db.close();
