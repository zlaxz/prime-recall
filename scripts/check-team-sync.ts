import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Check team members
const members = db.prepare(
  "SELECT email, name, role, active, sync_gmail, sync_calendar, relationship_to_ceo FROM team_members"
).all() as any[];

console.log('=== TEAM MEMBERS ===\n');
for (const m of members) {
  const gmail = m.sync_gmail ? '✓ gmail' : '✗ gmail';
  const cal = m.sync_calendar ? '✓ calendar' : '✗ calendar';
  console.log(`${m.active ? '🟢' : '⚫'} ${m.name} (${m.email}) — ${m.role}`);
  console.log(`  ${gmail} | ${cal} | ${m.relationship_to_ceo}`);
}

// Check service account
const saKey = getConfig(db, 'gmail_service_account');
console.log('\n=== SERVICE ACCOUNT ===');
console.log('Config:', saKey ? 'EXISTS' : 'NOT SET');

const { existsSync } = await import('fs');
const saPaths = [
  process.env.HOME + '/.prime/service-account.json',
  process.env.HOME + '/GitHub/prime/service-account.json',
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
].filter(Boolean);
for (const p of saPaths) {
  console.log(existsSync(p!) ? '✓' : '✗', p);
}

// Check what gmail_email is configured as (this determines the default scan account)
const gmailEmail = getConfig(db, 'gmail_email');
console.log('\n=== CONFIGURED SCAN ACCOUNT ===');
console.log('gmail_email:', gmailEmail);
console.log('This means scanGmail WITHOUT sourceAccount scans:', gmailEmail || 'UNKNOWN');

// Count items by source_account in last 30 days
const accountCounts = db.prepare(
  `SELECT source_account, COUNT(*) as cnt, MAX(source_date) as last_date
   FROM knowledge
   WHERE source = 'gmail'
   GROUP BY source_account
   ORDER BY last_date DESC`
).all() as any[];
console.log('\n=== GMAIL DATA BY ACCOUNT ===');
for (const a of accountCounts) {
  console.log(' ', (a.source_account || 'null').padEnd(40), a.cnt, 'items, last:', a.last_date?.slice(0, 10));
}

db.close();
