import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Full date range of gmail items
const range = db.prepare(`
  SELECT MIN(source_date) as oldest, MAX(source_date) as newest, COUNT(*) as total
  FROM knowledge WHERE source = 'gmail'
`).get() as any;
console.log(`Gmail items: ${range.total}`);
console.log(`Oldest: ${range.oldest}`);
console.log(`Newest: ${range.newest}\n`);

// Distribution by month
const monthly = db.prepare(`
  SELECT strftime('%Y-%m', source_date) as month, COUNT(*) as c,
    SUM(CASE WHEN extraction_version = 2 THEN 1 ELSE 0 END) as v2,
    SUM(CASE WHEN extraction_version = 3 THEN 1 ELSE 0 END) as v3
  FROM knowledge WHERE source = 'gmail' AND source_date IS NOT NULL
  GROUP BY month ORDER BY month
`).all() as any[];

console.log('Month       Total   v2    v3');
for (const m of monthly) {
  console.log(`${m.month}     ${String(m.c).padStart(5)}  ${String(m.v2).padStart(5)}  ${String(m.v3).padStart(5)}`);
}

db.close();
