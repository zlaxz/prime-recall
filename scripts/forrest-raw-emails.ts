import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const rows = db.prepare(`
  SELECT source_ref, title, source_date, raw_content
  FROM knowledge
  WHERE source_account = 'forrest@recaptureinsurance.com'
    AND source_date >= '2026-04-06'
  ORDER BY source_date DESC
  LIMIT 15
`).all() as any[];

console.log(`${rows.length} items from Forrest's inbox since Apr 6\n`);

for (const r of rows) {
  console.log(`=== ${r.source_date?.slice(0, 10)} | ${(r.title || '').slice(0, 70)} ===`);
  console.log(`ref: ${r.source_ref}`);
  if (r.raw_content) {
    console.log(r.raw_content.slice(0, 500));
  } else {
    console.log('(no raw_content stored)');
  }
  console.log('');
}

db.close();
