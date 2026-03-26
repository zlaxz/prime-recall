import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { insertKnowledge, setConfig, getConfig, saveDb, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
];

// Google OAuth — set via environment or prime init
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:9876/callback';

export async function connectGmail(db: SqlJsDatabase): Promise<boolean> {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    login_hint: getConfig(db, 'gmail_email') || '',
  });

  // Open browser
  const open = (await import('open')).default;
  console.log('  Opening browser for Google sign-in...');
  await open(authUrl);

  // Wait for callback
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:9876`);
      const code = url.searchParams.get('code');

      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          // Get user email
          const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
          const profile = await gmail.users.getProfile({ userId: 'me' });

          // Save tokens
          setConfig(db, 'gmail_tokens', tokens);
          setConfig(db, 'gmail_email', profile.data.emailAddress);

          // Update sync state
          db.run(
            `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('gmail', 'connected', ?, datetime('now'))`,
            [JSON.stringify({ email: profile.data.emailAddress })]
          );
          saveDb();

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>✓ Connected to Gmail</h1><p>You can close this window.</p></body></html>');

          console.log(`  ✓ Connected: ${profile.data.emailAddress}`);
          server.close();
          resolve(true);
        } catch (err) {
          res.writeHead(500);
          res.end('Error connecting Gmail');
          server.close();
          resolve(false);
        }
      } else {
        res.writeHead(400);
        res.end('No code received');
      }
    });

    server.listen(9876, () => {
      console.log('  Waiting for Google authorization...');
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      resolve(false);
    }, 120000);
  });
}

export async function scanGmail(
  db: SqlJsDatabase,
  options: { days?: number; maxThreads?: number } = {}
): Promise<{ threads: number; items: number }> {
  const days = options.days || 90;
  const maxThreads = options.maxThreads || 500;

  const tokens = getConfig(db, 'gmail_tokens');
  const apiKey = getConfig(db, 'openai_api_key');
  if (!tokens) throw new Error('Gmail not connected. Run: prime connect gmail');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const clientId = CLIENT_ID || getConfig(db, 'google_client_id') || '';
  const clientSecret = CLIENT_SECRET || getConfig(db, 'google_client_secret') || '';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials missing. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);

  // Handle token refresh — persist new tokens automatically
  oauth2Client.on('tokens', (newTokens) => {
    const current = getConfig(db, 'gmail_tokens');
    setConfig(db, 'gmail_tokens', { ...current, ...newTokens });
  });

  // Force token refresh if expired
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    setConfig(db, 'gmail_tokens', credentials);
  } catch (refreshErr: any) {
    throw new Error(`Gmail token refresh failed: ${refreshErr.message}. Run: recall connect gmail`);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Calculate date threshold
  const afterDate = new Date(Date.now() - days * 86400000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);

  // Fetch threads with pagination to capture everything in the date range
  const query = `after:${afterEpoch} -category:promotions -category:social -category:updates -from:noreply -from:no-reply`;
  const threads: { id: string; historyId?: string }[] = [];
  let pageToken: string | undefined;

  while (threads.length < maxThreads) {
    const response = await gmail.users.threads.list({
      userId: 'me',
      maxResults: Math.min(100, maxThreads - threads.length), // API max is 100 per page
      q: query,
      pageToken,
    });

    const batch = response.data.threads || [];
    for (const t of batch) {
      if (t.id) threads.push({ id: t.id, historyId: t.historyId || undefined });
    }

    pageToken = response.data.nextPageToken || undefined;
    if (!pageToken || batch.length === 0) break;
  }

  if (threads.length === 0) return { threads: 0, items: 0 };
  console.log(`  Found ${threads.length} threads in last ${days} days`);

  let items = 0;
  const CONCURRENCY = 5;
  const userEmail = getConfig(db, 'gmail_email') || '';

  const getHeader = (msg: any, name: string) =>
    msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';

  // Phase 1: Fetch all thread metadata in parallel (Gmail API is fast)
  console.log(`  Fetching thread metadata...`);
  const threadData: { id: string; content: string; subject: string; lastFrom: string; lastDate: string; messageCount: number }[] = [];

  for (let i = 0; i < threads.length; i += 10) {
    const batch = threads.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (threadMeta) => {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadMeta.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const messages = thread.data.messages || [];
        if (messages.length === 0) return null;

        const first = messages[0];
        const last = messages[messages.length - 1];
        const subject = getHeader(first, 'Subject');
        const from = getHeader(first, 'From');
        const lastFrom = getHeader(last, 'From');
        const lastDate = getHeader(last, 'Date');
        const snippet = last.snippet || '';

        return {
          id: threadMeta.id!,
          content: `Email thread: "${subject}"\nFrom: ${from}\n${messages.length} messages, last from ${lastFrom} on ${lastDate}\nLast message: ${snippet}`,
          subject, lastFrom, lastDate,
          messageCount: messages.length,
        };
      } catch { return null; }
    }));
    for (const r of results) { if (r) threadData.push(r); }
    if ((i + 10) % 50 === 0 || i + 10 >= threads.length) {
      process.stdout.write(`\r  Fetched: ${Math.min(i + 10, threads.length)}/${threads.length} threads`);
    }
  }
  console.log(`\n  ${threadData.length} threads with content`);

  // Phase 2: AI extraction in parallel (Claude Code CLI calls)
  console.log(`  Extracting intelligence (${CONCURRENCY} concurrent)...`);
  let extracted = 0;

  async function processThread(td: typeof threadData[0]) {
    try {
      const ext = await extractIntelligence(td.content, apiKey);
      const embText = `${ext.title}\n${ext.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);

      const lastFromIsUser = td.lastFrom.toLowerCase().includes(userEmail.toLowerCase());
      const daysSinceLastMessage = Math.floor((Date.now() - new Date(td.lastDate).getTime()) / 86400000);

      let importance = ext.importance;
      if (!lastFromIsUser && daysSinceLastMessage > 7) {
        importance = daysSinceLastMessage > 30 ? 'critical' : daysSinceLastMessage > 14 ? 'high' : importance;
      }

      const item: KnowledgeItem = {
        id: uuid(),
        title: ext.title || `Email: ${td.subject}`,
        summary: ext.summary,
        source: 'gmail',
        source_ref: `thread:${td.id}`,
        source_date: td.lastDate ? new Date(td.lastDate).toISOString() : undefined,
        contacts: ext.contacts,
        organizations: ext.organizations,
        decisions: ext.decisions,
        commitments: ext.commitments,
        action_items: ext.action_items,
        tags: [...ext.tags, ...(lastFromIsUser ? [] : ['awaiting_reply'])],
        project: ext.project,
        importance,
        embedding,
        metadata: {
          thread_id: td.id,
          message_count: td.messageCount,
          subject: td.subject,
          last_from: td.lastFrom,
          days_since_last: daysSinceLastMessage,
          waiting_on_user: !lastFromIsUser,
        },
      };

      insertKnowledge(db, item);
      extracted++;
      if (extracted % 10 === 0 || extracted === threadData.length) {
        process.stdout.write(`\r  Extracted: ${extracted}/${threadData.length}`);
      }
      return true;
    } catch { return false; }
  }

  // Run with concurrency limiter
  for (let i = 0; i < threadData.length; i += CONCURRENCY) {
    const batch = threadData.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processThread));
    items += results.filter(Boolean).length;
  }
  console.log('');

  // Update sync state
  db.run(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail', datetime('now'), ?, 'idle', datetime('now'))`,
    [items]
  );
  saveDb();

  return { threads: threads.length, items };
}
