import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Load env
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k]) process.env[k] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const tokens = getConfig(db, 'gmail_tokens') as any;
const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'http://localhost:3210/auth/callback');
oauth.setCredentials(tokens);
const gmail = google.gmail({ version: 'v1', auth: oauth });

// Check threads from last 14 days for message count changes
const afterEpoch = Math.floor((Date.now() - 14 * 86400000) / 1000);
const response = await gmail.users.threads.list({
  userId: 'me', maxResults: 50,
  q: `after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums`,
});

const threads = response.data.threads || [];
console.log(`Checking ${threads.length} threads for updates...\n`);

let updatedCount = 0;
let missingCount = 0;

for (const t of threads) {
  const thread = await gmail.users.threads.get({
    userId: 'me', id: t.id!, format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });
  const msgs = thread.data.messages || [];
  const getH = (msg: any, name: string) => msg?.payload?.headers?.find((h: any) => h.name === name)?.value || '';
  const subject = getH(msgs[0], 'Subject');
  const lastFrom = getH(msgs[msgs.length - 1], 'From');
  const lastDate = getH(msgs[msgs.length - 1], 'Date');

  const existing = db.prepare('SELECT id, metadata, source_date FROM knowledge WHERE source_ref = ?').get(`thread:${t.id}`) as any;

  if (!existing) {
    missingCount++;
    console.log(`❌ NOT IN DB: "${subject.slice(0, 60)}" (${msgs.length} msgs)`);
    console.log(`   Last: ${lastFrom.slice(0, 40)} on ${lastDate}\n`);
  } else {
    const meta = JSON.parse(existing.metadata || '{}');
    const storedMsgs = meta.message_count || 0;
    if (msgs.length > storedMsgs) {
      updatedCount++;
      console.log(`📩 NEEDS UPDATE: "${subject.slice(0, 60)}"`);
      console.log(`   DB: ${storedMsgs} msgs (${existing.source_date?.slice(0, 10)}) → Gmail: ${msgs.length} msgs`);
      console.log(`   Latest from: ${lastFrom.slice(0, 40)} on ${lastDate}\n`);
    }
  }
}

// Also check: what does the DB have from April 5-15 that Gmail doesn't?
console.log('\n=== DB items from April 5-15 ===');
const recent = db.prepare(
  `SELECT source_ref, title, source_date FROM knowledge
   WHERE source = 'gmail' AND source_date >= '2026-04-05' AND source_date <= '2026-04-16'
   ORDER BY source_date DESC`
).all() as any[];
console.log(`${recent.length} items in DB from this period`);
for (const r of recent) console.log(`  ${r.source_date?.slice(0, 10)} ${(r.title || '').slice(0, 60)}`);

console.log(`\n=== SUMMARY ===`);
console.log(`Threads checked: ${threads.length}`);
console.log(`Missing from DB: ${missingCount}`);
console.log(`Need message count update: ${updatedCount}`);

db.close();
