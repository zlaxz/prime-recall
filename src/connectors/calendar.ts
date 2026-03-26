import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { insertKnowledge, setConfig, getConfig, saveDb, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:9877/callback';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

export async function connectCalendar(db: SqlJsDatabase): Promise<boolean> {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    login_hint: getConfig(db, 'gmail_email') || '',
  });

  const open = (await import('open')).default;
  console.log('  Opening browser for Google Calendar sign-in...');
  await open(authUrl);

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:9877`);
      const code = url.searchParams.get('code');

      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);
          setConfig(db, 'calendar_tokens', tokens);

          db.run(
            `INSERT OR REPLACE INTO sync_state (source, status, updated_at) VALUES ('calendar', 'connected', datetime('now'))`
          );
          saveDb();

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>✓ Connected to Google Calendar</h1><p>You can close this window.</p></body></html>');

          console.log('  ✓ Connected to Google Calendar');
          server.close();
          resolve(true);
        } catch {
          res.writeHead(500);
          res.end('Error');
          server.close();
          resolve(false);
        }
      }
    });

    server.listen(9877);
    setTimeout(() => { server.close(); resolve(false); }, 120000);
  });
}

export async function scanCalendar(
  db: SqlJsDatabase,
  options: { daysBack?: number; daysForward?: number } = {}
): Promise<{ events: number; items: number }> {
  const daysBack = options.daysBack || 7;
  const daysForward = options.daysForward || 7;

  const tokens = getConfig(db, 'calendar_tokens');
  const apiKey = getConfig(db, 'openai_api_key');
  if (!tokens) throw new Error('Calendar not connected. Run: prime connect calendar');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const clientId = CLIENT_ID || getConfig(db, 'google_client_id') || '';
  const clientSecret = CLIENT_SECRET || getConfig(db, 'google_client_secret') || '';

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    const current = getConfig(db, 'calendar_tokens');
    setConfig(db, 'calendar_tokens', { ...current, ...newTokens });
  });

  // Force token refresh if expired
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    setConfig(db, 'calendar_tokens', credentials);
  } catch (refreshErr: any) {
    throw new Error(`Calendar token refresh failed: ${refreshErr.message}. Run: recall connect calendar`);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const timeMin = new Date(Date.now() - daysBack * 86400000).toISOString();
  const timeMax = new Date(Date.now() + daysForward * 86400000).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100,
  });

  const events = response.data.items || [];
  let items = 0;

  for (const event of events) {
    if (!event.summary) continue;

    const start = event.start?.dateTime || event.start?.date || '';
    const attendees = (event.attendees || []).map(a => a.displayName || a.email || '').filter(Boolean);
    const isUpcoming = new Date(start) > new Date();

    const content = [
      `Calendar event: ${event.summary}`,
      `When: ${start}`,
      `Location: ${event.location || 'N/A'}`,
      `Attendees: ${attendees.join(', ') || 'Just you'}`,
      event.description ? `Description: ${event.description.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');

    const embText = `${event.summary}\n${attendees.join(', ')}\n${event.description || ''}`;
    const embedding = await generateEmbedding(embText.slice(0, 4000), apiKey);

    const item: KnowledgeItem = {
      id: uuid(),
      title: event.summary,
      summary: `${isUpcoming ? 'Upcoming' : 'Past'} meeting: ${event.summary} on ${new Date(start).toLocaleDateString()} with ${attendees.length} attendees${attendees.length > 0 ? ` (${attendees.slice(0, 3).join(', ')})` : ''}`,
      source: 'calendar',
      source_ref: `event:${event.id}`,
      source_date: start,
      contacts: attendees,
      organizations: [],
      tags: [isUpcoming ? 'upcoming' : 'past', 'meeting'],
      project: null,
      importance: isUpcoming ? 'normal' : 'low',
      embedding,
      metadata: {
        event_id: event.id,
        location: event.location,
        html_link: event.htmlLink,
        is_upcoming: isUpcoming,
      },
    };

    insertKnowledge(db, item);
    items++;

    await new Promise(r => setTimeout(r, 50));
  }

  db.run(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('calendar', datetime('now'), ?, 'idle', datetime('now'))`,
    [items]
  );
  saveDb();

  return { events: events.length, items };
}
