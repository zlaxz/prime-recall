import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// 1. Configured email account
const email = getConfig(db, 'gmail_email');
console.log('Configured gmail_email:', email || 'NOT SET');

// 2. Source accounts in data
const accounts = db.prepare(
  `SELECT DISTINCT source_account, COUNT(*) as cnt FROM knowledge WHERE source = 'gmail' AND source_account IS NOT NULL GROUP BY source_account`
).all() as any[];
console.log('\nAccounts in gmail data:');
for (const a of accounts) console.log(' ', a.source_account, '—', a.cnt, 'items');

// 3. Check if gmail OAuth token exists
const tokenKeys = db.prepare(
  `SELECT key FROM graph_state WHERE key LIKE '%token%' OR key LIKE '%oauth%' OR key LIKE '%gmail_auth%'`
).all() as any[];
console.log('\nToken-related keys:', tokenKeys.map(t => t.key).join(', ') || 'NONE');

// 4. Check gmail credentials file
import { existsSync, readFileSync } from 'fs';
const credPaths = [
  process.env.HOME + '/.prime/gmail-credentials.json',
  process.env.HOME + '/.prime/gmail-token.json',
  process.env.HOME + '/.prime/credentials.json',
  process.env.HOME + '/.prime/token.json',
  process.env.HOME + '/GitHub/prime/.env',
];
console.log('\nCredential files:');
for (const p of credPaths) {
  console.log(' ', existsSync(p) ? '✓' : '✗', p);
}

// 5. Check .env for gmail keys
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  const gmailKeys = env.split('\n').filter((l: string) => /gmail|google|oauth|client_id|client_secret/i.test(l));
  console.log('\nGmail-related .env keys:');
  for (const k of gmailKeys) {
    const [key] = k.split('=');
    console.log(' ', key, '= [set]');
  }
} catch { console.log('\nNo .env file found'); }

// 6. Recent gmail threads — check if thread IDs changed
const recentThreads = db.prepare(
  `SELECT source_ref, title, source_date, message_count FROM knowledge WHERE source = 'gmail' ORDER BY source_date DESC LIMIT 5`
).all() as any[];
console.log('\nMost recent gmail threads in DB:');
for (const t of recentThreads) {
  console.log(' ', t.source_date?.slice(0, 10), t.message_count || '?', 'msgs', '—', (t.title || '').slice(0, 60));
}

// 7. Try to actually call Gmail API
console.log('\n=== TESTING GMAIL API ===');
try {
  const { google } = await import('googleapis');

  // Check for service account
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.HOME + '/.prime/service-account.json';
  if (existsSync(saPath)) {
    console.log('Service account found:', saPath);
  }

  // Check for OAuth tokens
  const tokenPath = process.env.HOME + '/.prime/gmail-token.json';
  if (existsSync(tokenPath)) {
    const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    console.log('Token type:', token.token_type || 'unknown');
    console.log('Expiry:', token.expiry_date ? new Date(token.expiry_date).toISOString() : 'unknown');
  }
} catch (e: any) {
  console.log('googleapis not available or error:', e.message?.slice(0, 100));
}

db.close();
