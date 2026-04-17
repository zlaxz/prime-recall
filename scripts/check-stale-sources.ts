import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// === DRIVE ===
console.log('=== GOOGLE DRIVE ===');
const driveTokens = getConfig(db, 'drive_tokens');
const driveConfig = getConfig(db, 'drive_folder_id');
console.log('  tokens:', driveTokens ? 'SET' : 'NOT SET');
console.log('  folder_id:', driveConfig || 'NOT SET');
const driveItems = db.prepare(`SELECT COUNT(*) as c, MAX(source_date) as last FROM knowledge WHERE source = 'drive'`).get() as any;
console.log(`  items: ${driveItems.c}, last: ${driveItems.last || 'never'}`);

// === OTTER ===
console.log('\n=== OTTER ===');
const otterItems = db.prepare(`SELECT COUNT(*) as c, MAX(source_date) as last FROM knowledge WHERE source = 'otter'`).get() as any;
console.log(`  items: ${otterItems.c}, last: ${otterItems.last || 'never'}`);
// Otter is historical — replaced by Fireflies
const ffItems = db.prepare(`SELECT COUNT(*) as c, MAX(source_date) as last FROM knowledge WHERE source = 'fireflies'`).get() as any;
console.log(`  Fireflies (replacement): ${ffItems.c} items, last: ${ffItems.last || 'never'}`);

// === CLAUDE-CODE ===
console.log('\n=== CLAUDE-CODE ===');
const ccItems = db.prepare(`SELECT COUNT(*) as c, MAX(source_date) as last FROM knowledge WHERE source = 'claude-code'`).get() as any;
console.log(`  items: ${ccItems.c}, last: ${ccItems.last || 'never'}`);
// Check if the laptop-sources sync is working
import { existsSync, readdirSync, statSync } from 'fs';
const laptopSources = process.env.HOME + '/laptop-sources';
if (existsSync(laptopSources)) {
  const dirs = readdirSync(laptopSources);
  console.log(`  laptop-sources dirs: ${dirs.join(', ')}`);
  for (const d of dirs) {
    const p = laptopSources + '/' + d;
    try {
      const stat = statSync(p);
      console.log(`    ${d}: modified ${stat.mtime.toISOString().slice(0, 16)}`);
    } catch {}
  }
} else {
  console.log('  laptop-sources dir: MISSING');
}

// === CALENDAR ===
console.log('\n=== CALENDAR ===');
const calTokens = getConfig(db, 'calendar_tokens');
const calSA = getConfig(db, 'gmail_service_account'); // calendar might use same SA
console.log('  tokens:', calTokens ? 'SET' : 'NOT SET');
console.log('  service_account:', calSA ? 'SET' : 'NOT SET');

// Check what account calendar syncs from
const calItems = db.prepare(`SELECT title, source_date FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now') ORDER BY source_date ASC LIMIT 10`).all() as any[];
console.log(`  Upcoming events: ${calItems.length}`);
for (const c of calItems) {
  console.log(`    ${c.source_date?.slice(0, 16)} — ${c.title}`);
}

// Check ALL calendar items in last 30 days
const calRecent = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now', '-30 days')`).get() as any;
console.log(`  Events in last 30 days: ${calRecent.c}`);

// Try to check if service account can read Zach's calendar
console.log('\n=== TESTING CALENDAR API ACCESS ===');
try {
  const { google } = await import('googleapis');
  if (calSA) {
    const sa = typeof calSA === 'string' ? JSON.parse(calSA) : calSA;
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      subject: 'zach.stock@recaptureinsurance.com',
    });
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const oneWeek = new Date(now.getTime() + 7 * 86400000);
    const events = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: oneWeek.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    console.log(`  API returned ${(events.data.items || []).length} events for next 7 days:`);
    for (const e of (events.data.items || []).slice(0, 10)) {
      const start = e.start?.dateTime || e.start?.date || '';
      console.log(`    ${start.slice(0, 16)} — ${e.summary}`);
    }
  } else if (calTokens) {
    console.log('  Using OAuth tokens (may be for wrong account like Gmail was)');
  }
} catch (e: any) {
  console.log(`  API error: ${e.message?.slice(0, 150)}`);
}

// === FIREFLIES ===
console.log('\n=== FIREFLIES ===');
const ffConfig = getConfig(db, 'fireflies_api_key');
console.log('  api_key:', ffConfig ? 'SET' : 'NOT SET');
console.log(`  items: ${ffItems.c}, last: ${ffItems.last || 'never'}`);

db.close();
