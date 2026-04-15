import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const db = new Database(process.env.HOME + '/.prime/prime.db');

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

// Check whose inbox the OAuth token is for
const profile = await gmail.users.getProfile({ userId: 'me' });
console.log('=== GMAIL API PROFILE ===');
console.log('Email:', profile.data.emailAddress);
console.log('Messages total:', profile.data.messagesTotal);
console.log('Threads total:', profile.data.threadsTotal);
console.log('History ID:', profile.data.historyId);

// List 5 most recent threads (no filter) to see what's actually there
console.log('\n=== 5 MOST RECENT THREADS (no filter) ===');
const recent = await gmail.users.threads.list({ userId: 'me', maxResults: 5 });
for (const t of (recent.data.threads || [])) {
  const thread = await gmail.users.threads.get({
    userId: 'me', id: t.id!, format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });
  const msgs = thread.data.messages || [];
  const getH = (msg: any, name: string) => msg?.payload?.headers?.find((h: any) => h.name === name)?.value || '';
  const subject = getH(msgs[0], 'Subject');
  const lastDate = getH(msgs[msgs.length - 1], 'Date');
  const lastFrom = getH(msgs[msgs.length - 1], 'From');
  console.log(`  ${lastDate} | ${msgs.length} msgs | ${subject.slice(0, 50)}`);
  console.log(`    Last from: ${lastFrom.slice(0, 60)}`);
}

// Check Forrest's account via service account
console.log('\n=== FORREST ACCOUNT (via service account) ===');
const saConfig = getConfig(db, 'gmail_service_account') as any;
if (saConfig) {
  try {
    const auth = new google.auth.JWT({
      email: saConfig.client_email,
      key: saConfig.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      subject: 'forrest@recaptureinsurance.com',
    });
    const forrestGmail = google.gmail({ version: 'v1', auth });
    const fp = await forrestGmail.users.getProfile({ userId: 'me' });
    console.log('Email:', fp.data.emailAddress);
    console.log('Messages total:', fp.data.messagesTotal);

    const fRecent = await forrestGmail.users.threads.list({ userId: 'me', maxResults: 3 });
    for (const t of (fRecent.data.threads || [])) {
      const thread = await forrestGmail.users.threads.get({
        userId: 'me', id: t.id!, format: 'metadata',
        metadataHeaders: ['Subject', 'Date', 'From'],
      });
      const msgs = thread.data.messages || [];
      const getH = (msg: any, name: string) => msg?.payload?.headers?.find((h: any) => h.name === name)?.value || '';
      console.log(`  ${getH(msgs[msgs.length-1], 'Date')} | ${msgs.length} msgs | ${getH(msgs[0], 'Subject').slice(0, 50)}`);
    }
  } catch (e: any) {
    console.log('ERROR:', e.message?.slice(0, 200));
  }
} else {
  console.log('No service account configured');
}

db.close();
