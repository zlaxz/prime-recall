import Database from 'better-sqlite3';
import { scanGmail, scanSentMail } from '../src/connectors/gmail.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('Syncing Zach inbox (via service account, 14 days)...');
try {
  const result = await scanGmail(db, {
    days: 14,
    maxThreads: 100,
    sourceAccount: 'zach.stock@recaptureinsurance.com',
    useServiceAccount: true,
  });
  console.log('✓ Zach inbox sync:', JSON.stringify(result));
} catch (e: any) {
  console.log('✗ Inbox error:', e.message?.slice(0, 300));
}

console.log('\nSyncing Zach sent mail...');
try {
  const result = await scanSentMail(db, { days: 14 });
  console.log('✓ Zach sent sync:', JSON.stringify(result));
} catch (e: any) {
  console.log('✗ Sent error:', e.message?.slice(0, 300));
}

db.close();
