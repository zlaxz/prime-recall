import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';
import { google } from 'googleapis';

const db = new Database(process.env.HOME + '/.prime/prime.db');

const tokens = getConfig(db, 'gmail_tokens') as any;
const clientId = process.env.GOOGLE_CLIENT_ID || getConfig(db, 'google_client_id');
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || getConfig(db, 'google_client_secret');

// Load .env
import { readFileSync } from 'fs';
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k]) process.env[k] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const oauth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID || clientId,
  process.env.GOOGLE_CLIENT_SECRET || clientSecret,
  'http://localhost:3210/auth/callback'
);
oauth.setCredentials(tokens);

const gmail = google.gmail({ version: 'v1', auth: oauth });

// Fetch threads from last 14 days
const afterDate = new Date(Date.now() - 14 * 86400000);
const afterEpoch = Math.floor(afterDate.getTime() / 1000);
const query = `after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums -from:noreply -from:no-reply -from:notifications -from:mailer -from:newsletter -from:digest -from:marketing -from:support -from:donotreply -from:info@`;

const response = await gmail.users.threads.list({ userId: 'me', maxResults: 50, q: query });
const threads = response.data.threads || [];

console.log(`Found ${threads.length} threads\n`);

// Fetch metadata for each
const NOISE_PATTERNS = [
  /newsletter/i, /unsubscribe/i, /marketing.*email/i, /promotional/i,
  /daily.*digest/i, /weekly.*report/i, /auto-?generated/i,
  /noreply|no-reply|donotreply/i, /receipt.*payment/i,
  /SeatGeek|OpenTable|Yelp|DoorDash/i, /Gusto.*new tasks/i,
  /pdfFiller|RingCentral|Mailsuite/i, /surveymonkey|typeform/i,
  /Amazon Business|promo.*code/i, /Frank Kern/i,
  /quinn@recaptureinsurance\.com/i,
];

const userEmail = 'zach.stock@recaptureinsurance.com';
let noiseCount = 0;
let newCount = 0;
let existingCount = 0;

for (const t of threads) {
  const thread = await gmail.users.threads.get({
    userId: 'me', id: t.id!, format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
  });

  const msgs = thread.data.messages || [];
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const getH = (msg: any, name: string) => msg?.payload?.headers?.find((h: any) => h.name === name)?.value || '';

  const subject = getH(first, 'Subject');
  const from = getH(first, 'From');
  const lastFrom = getH(last, 'From');
  const lastDate = getH(last, 'Date');
  const snippet = last?.snippet || '';

  const content = `Email thread: "${subject}"\nFrom: ${from}\n${msgs.length} messages, last from ${lastFrom} on ${lastDate}\nLast message: ${snippet}`;
  const text = (subject + ' ' + content).slice(0, 500);

  // Check if already indexed
  const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(`thread:${t.id}`);

  // Check noise filter
  const matchedPattern = NOISE_PATTERNS.find(p => p.test(text));

  if (existing) {
    existingCount++;
    // Check if it has new messages
    const meta = db.prepare('SELECT metadata FROM knowledge WHERE source_ref = ?').get(`thread:${t.id}`) as any;
    const storedCount = meta?.metadata ? (JSON.parse(meta.metadata)?.message_count || 0) : 0;
    if (msgs.length > storedCount) {
      console.log(`📩 UPDATED thread (${storedCount}→${msgs.length} msgs): ${subject.slice(0, 60)}`);
      console.log(`   Last: ${lastFrom.slice(0, 40)} on ${lastDate}`);
    }
  } else if (matchedPattern) {
    noiseCount++;
    console.log(`🚫 NOISE: "${subject.slice(0, 50)}" — matched: ${matchedPattern}`);
    console.log(`   From: ${from.slice(0, 50)}`);
  } else {
    newCount++;
    console.log(`✅ NEW: "${subject.slice(0, 60)}"`);
    console.log(`   From: ${from.slice(0, 50)} | ${msgs.length} msgs | ${lastDate}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total: ${threads.length} | Existing: ${existingCount} | New: ${newCount} | Noise-filtered: ${noiseCount}`);

db.close();
