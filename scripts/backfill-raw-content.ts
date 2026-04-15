import Database from 'better-sqlite3';
import { scanGmail } from '../src/connectors/gmail.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Count before
const before = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND raw_content IS NOT NULL AND length(raw_content) > 100`).get() as any).c;
const total = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail'`).get() as any).c;
console.log(`Before: ${before}/${total} gmail items have raw_content`);

// Sync both accounts with 14-day window — this will backfill raw_content for existing threads
console.log('\nBackfilling Zach inbox...');
try {
  await scanGmail(db, { days: 14, maxThreads: 100, sourceAccount: 'zach.stock@recaptureinsurance.com', useServiceAccount: true });
} catch (e: any) { console.log('Zach error:', e.message?.slice(0, 100)); }

console.log('\nBackfilling Forrest inbox...');
try {
  await scanGmail(db, { days: 14, maxThreads: 100, sourceAccount: 'forrest@recaptureinsurance.com', useServiceAccount: true });
} catch (e: any) { console.log('Forrest error:', e.message?.slice(0, 100)); }

// Count after
const after = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND raw_content IS NOT NULL AND length(raw_content) > 100`).get() as any).c;
console.log(`\nAfter: ${after}/${total} gmail items have raw_content (${after - before} backfilled)`);

db.close();
