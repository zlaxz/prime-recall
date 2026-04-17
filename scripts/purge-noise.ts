import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const before = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail'`).get() as any).c;
console.log(`Gmail items before: ${before}`);

// Delete items tagged [NOISE] — extraction already identified them as junk
const noise = db.prepare(`DELETE FROM knowledge WHERE title = '[NOISE]' OR summary LIKE '%not business intelligence%'`).run();
console.log(`Deleted [NOISE] items: ${noise.changes}`);

// Delete generic "Email thread:" titles with no contacts — failed extractions with no value
const generic = db.prepare(`
  DELETE FROM knowledge
  WHERE source = 'gmail'
    AND title LIKE 'Email thread:%'
    AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)
    AND length(summary) < 100
`).run();
console.log(`Deleted generic + no contacts + short summary: ${generic.changes}`);

// Delete obvious system noise that shouldn't be in KB
const system = db.prepare(`
  DELETE FROM knowledge
  WHERE title LIKE '%Fireflies.ai Meeting Recap%'
    OR title LIKE '%SuperStaff%'
    OR title LIKE '%cold outreach from%'
    OR (title LIKE '%[NOISE]%' AND title != '[NOISE]')
`).run();
console.log(`Deleted system noise: ${system.changes}`);

const after = (db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE source = "gmail"').get() as any).c;
console.log(`\nGmail items after: ${after} (removed ${before - after})`);

// Recheck quality
const missing = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)`).get() as any).c;
console.log(`Missing contacts now: ${missing}/${after} (${Math.round(missing/after*100)}%)`);

db.close();
