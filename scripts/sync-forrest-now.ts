import Database from 'better-sqlite3';
import { scanGmail } from '../src/connectors/gmail.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('Syncing Forrest inbox (via service account, 14 days)...');
try {
  const result = await scanGmail(db, {
    days: 14,
    maxThreads: 100,
    sourceAccount: 'forrest@recaptureinsurance.com',
    useServiceAccount: true,
  });
  console.log('✓ Forrest sync:', JSON.stringify(result));
} catch (e: any) {
  console.log('✗ Error:', e.message?.slice(0, 300));
}

db.close();
