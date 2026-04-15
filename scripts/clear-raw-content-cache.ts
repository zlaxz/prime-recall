import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Check current DB size
const { statSync } = await import('fs');
const sizeBefore = statSync(process.env.HOME + '/.prime/prime.db').size;
console.log(`DB size before: ${Math.round(sizeBefore / 1024 / 1024)}MB`);

// Count items with raw_content
const withRaw = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE raw_content IS NOT NULL`).get() as any).c;
const rawSize = (db.prepare(`SELECT SUM(length(raw_content)) as s FROM knowledge WHERE raw_content IS NOT NULL`).get() as any).s;
console.log(`Items with raw_content: ${withRaw}`);
console.log(`Raw content total size: ${Math.round((rawSize || 0) / 1024 / 1024)}MB`);

// Clear raw_content — it's a cache, not permanent storage
// prime_retrieve fetches from the Gmail API on demand
console.log('\nClearing raw_content cache (prime_retrieve fetches live from APIs)...');
db.prepare(`UPDATE knowledge SET raw_content = NULL WHERE source IN ('gmail', 'gmail-sent')`).run();

const afterClear = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE raw_content IS NOT NULL`).get() as any).c;
console.log(`Items with raw_content after clear: ${afterClear}`);

// VACUUM to reclaim space
console.log('Running VACUUM...');
db.exec('VACUUM');

const sizeAfter = statSync(process.env.HOME + '/.prime/prime.db').size;
console.log(`DB size after: ${Math.round(sizeAfter / 1024 / 1024)}MB`);
console.log(`Saved: ${Math.round((sizeBefore - sizeAfter) / 1024 / 1024)}MB`);

db.close();
