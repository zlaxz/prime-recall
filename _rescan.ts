import 'dotenv/config';
import { getDb } from './src/db.js';
import { scanGmail } from './src/connectors/gmail.js';

async function main() {
  const db = await getDb();
  console.log('Scanning Gmail — 90 days, up to 500 threads (5x parallel)...\n');
  const start = Date.now();
  const result = await scanGmail(db, { days: 90, maxThreads: 500 });
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\nDone: ${result.threads} threads → ${result.items} items in ${elapsed}s`);
}
main().catch(e => console.error('Error:', e.message));
