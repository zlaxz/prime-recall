import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// What are these 1,604 items with no contacts?
const noContacts = db.prepare(`
  SELECT title, source_date, summary
  FROM knowledge
  WHERE source = 'gmail' AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)
  ORDER BY source_date DESC LIMIT 30
`).all() as any[];

console.log('=== ITEMS WITH NO CONTACTS (sample of 30) ===\n');
for (const n of noContacts) {
  console.log(`${n.source_date?.slice(0,10)} | ${n.title?.slice(0, 80)}`);
}

// Categorize by title patterns
const patterns = [
  { name: 'Email thread: (generic)', sql: `title LIKE 'Email thread:%'` },
  { name: '[NOISE] tagged', sql: `title = '[NOISE]' OR summary LIKE '%not business intelligence%'` },
  { name: 'Newsletter/digest', sql: `title LIKE '%digest%' OR title LIKE '%newsletter%' OR title LIKE '%weekly%' OR title LIKE '%daily%'` },
  { name: 'Automated/system', sql: `title LIKE '%automated%' OR title LIKE '%notification%' OR title LIKE '%auto-%' OR title LIKE '%noreply%'` },
  { name: 'COS/Quinn output', sql: `title LIKE '%COS%' OR title LIKE '%Quinn%' OR title LIKE '%Morning Brief%' OR title LIKE '%intelligence%'` },
  { name: 'Unsubscribe', sql: `title LIKE '%unsubscribe%'` },
  { name: 'Security/system alerts', sql: `title LIKE '%security%' OR title LIKE '%Supabase%' OR title LIKE '%vulnerability%'` },
  { name: 'Payment/billing', sql: `title LIKE '%payment%' OR title LIKE '%invoice%' OR title LIKE '%billing%' OR title LIKE '%receipt%'` },
];

console.log('\n=== CATEGORIZATION ===\n');
let categorized = 0;
for (const p of patterns) {
  const count = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5) AND (${p.sql})`).get() as any).c;
  if (count > 0) {
    console.log(`${String(count).padStart(5)} — ${p.name}`);
    categorized += count;
  }
}
console.log(`${String(1604 - categorized).padStart(5)} — uncategorized`);
console.log(`${String(1604).padStart(5)} — TOTAL`);

db.close();
