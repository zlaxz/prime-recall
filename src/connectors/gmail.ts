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
  const maxThreads = options.maxThreads || 100;

  const tokens = getConfig(db, 'gmail_tokens');
  const apiKey = getConfig(db, 'openai_api_key');
  if (!tokens) throw new Error('Gmail not connected. Run: prime connect gmail');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);

  // Handle token refresh
  oauth2Client.on('tokens', (newTokens) => {
    const current = getConfig(db, 'gmail_tokens');
    setConfig(db, 'gmail_tokens', { ...current, ...newTokens });
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Calculate date threshold
  const afterDate = new Date(Date.now() - days * 86400000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);

  // Fetch threads
  const response = await gmail.users.threads.list({
    userId: 'me',
    maxResults: maxThreads,
    q: `after:${afterEpoch} -category:promotions -category:social -category:updates -from:noreply -from:no-reply`,
  });

  const threads = response.data.threads || [];
  if (threads.length === 0) return { threads: 0, items: 0 };

  let items = 0;

  // Process each thread
  for (const threadMeta of threads) {
    try {
      // Fetch thread details
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: threadMeta.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const messages = thread.data.messages || [];
      if (messages.length === 0) continue;

      // Build thread summary
      const first = messages[0];
      const last = messages[messages.length - 1];

      const getHeader = (msg: any, name: string) =>
        msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';

      const subject = getHeader(first, 'Subject');
      const from = getHeader(first, 'From');
      const lastFrom = getHeader(last, 'From');
      const lastDate = getHeader(last, 'Date');
      const snippet = last.snippet || '';

      // Build content for AI extraction
      const content = [
        `Email thread: "${subject}"`,
        `From: ${from}`,
        `${messages.length} messages, last from ${lastFrom} on ${lastDate}`,
        `Last message: ${snippet}`,
      ].join('\n');

      // AI extraction
      const extracted = await extractIntelligence(content, apiKey);

      // Generate embedding
      const embText = `${extracted.title}\n${extracted.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);

      // Check for dropped balls
      const userEmail = getConfig(db, 'gmail_email') || '';
      const lastFromIsUser = lastFrom.toLowerCase().includes(userEmail.toLowerCase());
      const daysSinceLastMessage = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);

      let importance = extracted.importance;
      if (!lastFromIsUser && daysSinceLastMessage > 7) {
        importance = daysSinceLastMessage > 30 ? 'critical' : daysSinceLastMessage > 14 ? 'high' : importance;
      }

      const item: KnowledgeItem = {
        id: uuid(),
        title: extracted.title || `Email: ${subject}`,
        summary: extracted.summary,
        source: 'gmail',
        source_ref: `thread:${threadMeta.id}`,
        source_date: lastDate ? new Date(lastDate).toISOString() : undefined,
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: [...extracted.tags, ...(lastFromIsUser ? [] : ['awaiting_reply'])],
        project: extracted.project,
        importance,
        embedding,
        metadata: {
          thread_id: threadMeta.id,
          message_count: messages.length,
          subject,
          last_from: lastFrom,
          days_since_last: daysSinceLastMessage,
          waiting_on_user: !lastFromIsUser,
        },
      };

      insertKnowledge(db, item);
      items++;

      // Rate limit
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      // Skip failed threads, continue
      continue;
    }
  }

  // Update sync state
  db.run(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail', datetime('now'), ?, 'idle', datetime('now'))`,
    [items]
  );
  saveDb();

  return { threads: threads.length, items };
}
