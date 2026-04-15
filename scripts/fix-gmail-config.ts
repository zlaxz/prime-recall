import Database from 'better-sqlite3';
import { getConfig, setConfig } from '../src/db.js';
import { readFileSync, existsSync } from 'fs';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Fix 1: Set gmail_email to Zach's actual email
const current = getConfig(db, 'gmail_email');
console.log('Current gmail_email:', current);
setConfig(db, 'gmail_email', 'zach.stock@recaptureinsurance.com');
console.log('✓ Fixed gmail_email → zach.stock@recaptureinsurance.com');

// Fix 2: Load service account config from the existing JSON file
const saPath = process.env.HOME + '/.prime/service-account.json';
if (existsSync(saPath)) {
  const saKey = JSON.parse(readFileSync(saPath, 'utf-8'));
  setConfig(db, 'gmail_service_account', saKey);
  console.log('✓ Loaded service account from', saPath);
  console.log('  client_email:', saKey.client_email || 'unknown');
} else {
  console.log('✗ Service account file not found at', saPath);
}

// Verify
console.log('\n=== VERIFICATION ===');
console.log('gmail_email:', getConfig(db, 'gmail_email'));
const sa = getConfig(db, 'gmail_service_account');
console.log('gmail_service_account:', sa ? `SET (${(sa as any).client_email || 'loaded'})` : 'NOT SET');

db.close();
