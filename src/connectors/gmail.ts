import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence, extractIntelligenceV2, toV1 } from '../ai/extract.js';

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SERVICE_ACCOUNT_PATH = join(homedir(), '.prime', 'service-account.json');

// Get an authenticated Gmail/Calendar client for any team member via service account
export function getServiceAccountAuth(targetEmail: string, scopes: string[]) {
  if (!existsSync(SERVICE_ACCOUNT_PATH)) return null;
  const keyFile = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
  const { JWT } = google.auth as any;
  const auth = new JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes,
    subject: targetEmail,
  });
  return auth;
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
];

// Google OAuth — set via environment or prime init
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:9876/callback';

export async function connectGmail(db: Database.Database): Promise<boolean> {
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
          db.prepare(
            `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('gmail', 'connected', ?, datetime('now'))`
          ).run(JSON.stringify({ email: profile.data.emailAddress }));

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
  db: Database.Database,
  options: { days?: number; maxThreads?: number; sourceAccount?: string; useServiceAccount?: boolean } = {}
): Promise<{ threads: number; items: number }> {
  const days = options.days || 90;
  const maxThreads = options.maxThreads || 500;

  const tokens = getConfig(db, 'gmail_tokens');
  const apiKey = getConfig(db, 'openai_api_key');
  if (!tokens && !options.useServiceAccount) throw new Error('Gmail not connected. Run: prime connect gmail');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const clientId = CLIENT_ID || getConfig(db, 'google_client_id') || '';
  const clientSecret = CLIENT_SECRET || getConfig(db, 'google_client_secret') || '';

  if (!clientId && !clientSecret && !options.useServiceAccount) {
    throw new Error('Google OAuth credentials missing. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
  }

  // Service account path for team member accounts
  let authClient: any;
  if (options.useServiceAccount && options.sourceAccount) {
    const saAuth = getServiceAccountAuth(options.sourceAccount, ['https://www.googleapis.com/auth/gmail.readonly']);
    if (!saAuth) throw new Error('Service account not found at ' + SERVICE_ACCOUNT_PATH);
    authClient = saAuth;
  } else {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    authClient = oauth2Client;

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
    authClient = oauth2Client;
  }

  const gmail = google.gmail({ version: 'v1', auth: authClient });

  // Calculate date threshold
  const afterDate = new Date(Date.now() - days * 86400000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);

  // Fetch threads with pagination to capture everything in the date range
  const query = `after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums -from:noreply -from:no-reply -from:notifications -from:mailer -from:newsletter -from:digest -from:marketing -from:support -from:donotreply -from:info@ -from:quinn@recaptureinsurance.com -from:prime@recaptureinsurance.com`;
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
        // Fetch full message content (not just metadata) so raw_content has actual email bodies
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadMeta.id!,
          format: 'full',
        });
        const messages = thread.data.messages || [];
        if (messages.length === 0) return null;

        const first = messages[0];
        const last = messages[messages.length - 1];
        const subject = getHeader(first, 'Subject');
        const from = getHeader(first, 'From');
        const lastFrom = getHeader(last, 'From');
        const lastDate = getHeader(last, 'Date');

        // Extract plain text body from each message
        const getBody = (msg: any): string => {
          const parts = msg.payload?.parts || [];
          // Try to find text/plain part
          for (const part of parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              return Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
            // Check nested parts (multipart/alternative)
            if (part.parts) {
              for (const sub of part.parts) {
                if (sub.mimeType === 'text/plain' && sub.body?.data) {
                  return Buffer.from(sub.body.data, 'base64').toString('utf-8');
                }
              }
            }
          }
          // Fallback: body directly on payload (simple messages)
          if (msg.payload?.body?.data) {
            return Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
          }
          // Last resort: snippet
          return msg.snippet || '';
        };

        // Build full thread content as readable text
        const threadContent = messages.map((msg: any) => {
          const msgFrom = getHeader(msg, 'From');
          const msgDate = getHeader(msg, 'Date');
          const body = getBody(msg);
          return `--- ${msgFrom} (${msgDate}) ---\nSubject: ${subject}\n${body}`;
        }).join('\n\n');

        // Truncate if extremely long (>50K chars) to avoid extraction timeout
        const content = threadContent.length > 50000
          ? threadContent.slice(0, 50000) + '\n\n[... truncated, full content in raw_content ...]'
          : threadContent;

        return {
          id: threadMeta.id!,
          content,
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

  // Update pass: check existing threads for new messages (replies)
  let updatedThreads = 0;
  for (const td of threadData) {
    const sourceRef = `thread:${td.id}`;
    const existing = db.prepare('SELECT id, metadata FROM knowledge WHERE source_ref = ?').get(sourceRef) as any;
    if (!existing) continue;

    const meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata || '{}') : (existing.metadata || {});
    const storedCount = meta.message_count || 0;

    if (td.messageCount > storedCount) {
      // Thread has new messages — update the existing knowledge item
      const newSummary = `Email thread: "${td.subject}" — ${td.messageCount} messages (was ${storedCount}). Latest from ${td.lastFrom}: ${td.content.split('Last message: ')[1] || ''}`;
      const newMeta = {
        ...meta,
        message_count: td.messageCount,
        subject: td.subject,
        last_from: td.lastFrom,
        days_since_last: td.lastDate ? Math.floor((Date.now() - new Date(td.lastDate).getTime()) / 86400000) : 0,
        waiting_on_user: !isSelfSender(td.lastFrom),
        updated_for_reply: true,
      };

      // Update tags: if latest message is not from user, mark awaiting_reply
      const existingTags = typeof meta.tags === 'string' ? JSON.parse(meta.tags || '[]') : [];
      const lastFromIsUser = isSelfSender(td.lastFrom);
      let newTags = (Array.isArray(existingTags) ? existingTags : []).filter((t: string) => t !== 'awaiting_reply');
      if (!lastFromIsUser) newTags.push('awaiting_reply');

      db.prepare(
        `UPDATE knowledge SET summary = ?, raw_content = ?, source_date = ?, metadata = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(
        newSummary,
        td.content,
        td.lastDate ? new Date(td.lastDate).toISOString() : null,
        JSON.stringify(newMeta),
        JSON.stringify(newTags),
        existing.id,
      );
      updatedThreads++;
    }
  }
  if (updatedThreads > 0) {
    console.log(`  Updated ${updatedThreads} threads with new replies`);
  }

  // Threads the AI classified as noise produce no knowledge row, so the dedup
  // below could never skip them — they were re-extracted every single tick.
  // Record them here instead, keyed on message_count so a genuine reply reopens
  // the thread for extraction.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_noise_threads (
      thread_id TEXT NOT NULL,
      source_account TEXT NOT NULL,
      message_count INTEGER,
      subject TEXT,
      last_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (thread_id, source_account)
    );
  `);

  // Dedup: skip threads already in the knowledge base
  const beforeDedup = threadData.length;
  let skippedNoise = 0;
  const deduped = threadData.filter(td => {
    const sourceAccount = options.sourceAccount || userEmail;
      const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ? AND (source_account = ? OR source_account IS NULL)').get(`thread:${td.id}`, sourceAccount);
    if (existing) return false;
    const known = db.prepare('SELECT message_count FROM gmail_noise_threads WHERE thread_id = ? AND source_account = ?').get(td.id, sourceAccount) as { message_count: number } | undefined;
    if (known && known.message_count >= td.messageCount) { skippedNoise++; return false; }
    return true;
  });
  if (skippedNoise > 0) {
    console.log(`  Skipping ${skippedNoise} known-noise threads (no new messages)`);
  }
  if (beforeDedup - deduped.length > 0) {
    console.log(`  Skipping ${beforeDedup - deduped.length} already indexed threads`);
  }
  // Replace threadData with deduped for processing
  threadData.length = 0;
  threadData.push(...deduped);

  
  // Pre-extraction noise filter: skip items that are clearly not business intelligence
  // IMPORTANT: Only match against SUBJECT and FROM — not full content.
  // Matching full content was too aggressive (filtered business threads mentioning Gusto, Quinn, etc.)
  const NOISE_SUBJECT_PATTERNS = [
    /newsletter/i, /unsubscribe/i, /promotional/i,
    /daily.*digest/i, /weekly.*report/i,
    /receipt.*payment/i, /order.*confirm/i,
    /promo.*code/i,
  ];
  const NOISE_FROM_PATTERNS = [
    /noreply|no-reply|donotreply/i,
    /SeatGeek|OpenTable|Yelp|DoorDash/i,
    /pdfFiller|Mailsuite/i, /surveymonkey|typeform/i,
    /marketing@|promotions@|news@|digest@/i,
  ];
  const beforeNoise = threadData.length;
  const filtered = threadData.filter(td => {
    const subjectNoise = NOISE_SUBJECT_PATTERNS.some(p => p.test(td.subject));
    const fromNoise = NOISE_FROM_PATTERNS.some(p => p.test(td.lastFrom));
    if (subjectNoise || fromNoise) {
      console.log(`    noise: "${td.subject.slice(0, 50)}" from ${td.lastFrom.slice(0, 40)}`);
    }
    return !subjectNoise && !fromNoise;
  });
  if (beforeNoise - filtered.length > 0) {
    console.log('  Filtered ' + (beforeNoise - filtered.length) + ' noise threads');
    threadData.length = 0;
    threadData.push(...filtered);
  }

  // Phase 2: AI extraction in parallel (Claude Code CLI calls)
  // Hard per-scan AI budget: whatever upstream filtering misses, one scan may
  // never hand the extractor an unbounded queue again.
  const MAX_AI_EXTRACTIONS_PER_SCAN = 40;
  if (threadData.length > MAX_AI_EXTRACTIONS_PER_SCAN) {
    console.log(`  Extraction budget: ${threadData.length} candidates capped at ${MAX_AI_EXTRACTIONS_PER_SCAN} (rest next tick)`);
    threadData.length = MAX_AI_EXTRACTIONS_PER_SCAN;
  }
  console.log(`  Extracting intelligence (${CONCURRENCY} concurrent)...`);
  let extracted = 0;
  let scanDegraded = false; // first 402 stops all further paid calls this scan

  async function processThread(td: typeof threadData[0]) {
    if (scanDegraded) return false;
    try {
      // Use V2 provenance extraction, fall back to V1
      let extV2;
      try {
        extV2 = await extractIntelligenceV2(td.content, apiKey);
      } catch {
        extV2 = null;
      }
      const ext = extV2 ? toV1(extV2) : await extractIntelligence(td.content, apiKey);

      const lastFromIsUser = isSelfSender(td.lastFrom);
      const daysSinceLastMessage = Math.floor((Date.now() - new Date(td.lastDate).getTime()) / 86400000);

      // Skip noise items (extraction identified as automated/marketing)
      // Checked before embedding so noise doesn't cost an embedding call too.
      if (ext.tags?.includes('noise') || ext.title === '[NOISE]') {
        console.log(`    ai-noise: "${td.subject.slice(0, 50)}"`);
        // This insert failing silently meant noise threads were re-extracted
        // every tick forever (gmail_noise_threads had ZERO rows on 2026-09-08).
        try {
          let lastIso: string | null = null;
          try { lastIso = td.lastDate ? new Date(td.lastDate).toISOString() : null; } catch (_e) {}
          db.prepare(
            'INSERT OR REPLACE INTO gmail_noise_threads (thread_id, source_account, message_count, subject, last_date) VALUES (?, ?, ?, ?, ?)'
          ).run(td.id, options.sourceAccount || userEmail, td.messageCount ?? 0, td.subject ?? '', lastIso);
        } catch (markErr: any) {
          console.error(`    noise-mark FAILED for ${td.id}: ${String(markErr?.message || markErr).slice(0, 120)}`);
        }
        return;
      }

      const embText = `${ext.title}\n${ext.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);

      let importance = ext.importance;
      if (!lastFromIsUser && daysSinceLastMessage > 7) {
        importance = daysSinceLastMessage > 30 ? 'critical' : daysSinceLastMessage > 14 ? 'high' : importance;
      }

      const item: KnowledgeItem = {
        id: uuid(),
        title: ext.title || `Email: ${td.subject}`,
        summary: ext.summary,
        source: 'gmail',
        source_account: options.sourceAccount || userEmail,
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
          ...(extV2 ? { extraction_v2: extV2 } : {}),
        },
      };

      insertKnowledge(db, item);

      // NOTE: We do NOT store raw_content here — that would bloat the DB.
      // raw_content is a CACHE populated on-demand by prime_retrieve
      // when it goes to the Gmail API shelf to fetch full content.
      // The extraction above already saw the full message bodies
      // (fetched with format: 'full'), so the index card is high-quality.

      // Mark extraction version for future re-extraction tracking
      db.prepare('UPDATE knowledge SET extraction_version = ? WHERE source_ref = ?')
        .run(extV2 ? 2 : 1, `thread:${td.id}`);
      extracted++;
      if (extracted % 10 === 0 || extracted === threadData.length) {
        process.stdout.write(`\r  Extracted: ${extracted}/${threadData.length}`);
      }
      return true;
    } catch (err: any) {
      if (/402|Insufficient Balance/i.test(String(err?.message))) {
        if (!scanDegraded) console.error('    402 — balance dead; degrading scan (no further paid calls this tick)');
        scanDegraded = true;
      } else console.error(`    thread ${td.id} FAILED: ${err.message}`);
      return false;
    }
  }

  // Run with concurrency limiter
  for (let i = 0; i < threadData.length; i += CONCURRENCY) {
    const batch = threadData.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processThread));
    items += results.filter(Boolean).length;
  }
  console.log('');

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(items);

  return { threads: threads.length, items };
}

// ============================================================
// Sent Mail Scanner — Phase 1 of v1.0 Brain Architecture
// Scans sent folder to:
// 1. Correct false "awaiting_reply" tags on existing items
// 2. Capture Zach-initiated threads not in the knowledge base
// ============================================================

export async function scanSentMail(
  db: Database.Database,
  options: { days?: number; maxThreads?: number } = {}
): Promise<{ scanned: number; corrected: number; newItems: number }> {
  const days = options.days || 90;
  const maxThreads = options.maxThreads || 300;

  // scanSentMail is service-account only (2026-08-31): the OAuth tokens were
  // bound to quinn@ and read the wrong mailbox for 10 days. The service account
  // (domain-wide delegation) impersonates Zach's own mailbox directly — his
  // SENT label is the same mailbox the inbox sync already reads. No routing
  // rules, no mail copies: access was always there, this was a code choice.
  const userEmail = 'zach.stock@recaptureinsurance.com';
  const saAuth = getServiceAccountAuth(userEmail, ['https://www.googleapis.com/auth/gmail.readonly']);
  if (!saAuth) throw new Error('Service account not configured for gmail.readonly');
  const gmail = google.gmail({ version: 'v1', auth: saAuth });

  const afterDate = new Date(Date.now() - days * 86400000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);

  // Fetch sent threads
  console.log('  Fetching sent mail threads...');
  const sentQuery = `from:me after:${afterEpoch}`;
  const sentThreads: { id: string }[] = [];
  let pageToken: string | undefined;

  while (sentThreads.length < maxThreads) {
    const response = await gmail.users.threads.list({
      userId: 'me',
      maxResults: Math.min(100, maxThreads - sentThreads.length),
      q: sentQuery,
      pageToken,
    });
    const batch = response.data.threads || [];
    for (const t of batch) {
      if (t.id) sentThreads.push({ id: t.id });
    }
    pageToken = response.data.nextPageToken || undefined;
    if (!pageToken || batch.length === 0) break;
  }

  console.log(`  Found ${sentThreads.length} sent threads in last ${days} days`);

  const stats = { scanned: 0, corrected: 0, newItems: 0 };
  const getHeader = (msg: any, name: string) =>
    msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';

  // ============================================================
  // PHASE A: Fetch all sent thread metadata (parallel, fast)
  // ============================================================
  console.log('  Phase A: Fetching sent thread details...');

  type SentThreadData = {
    id: string;
    subject: string;
    to: string;
    toEmails: string[];  // parsed email addresses from To/CC
    firstFrom: string;
    lastFrom: string;
    lastDate: string;
    snippet: string;
    messageCount: number;
    userSentFirst: boolean;
    userSentLast: boolean;
  };

  const threadData: SentThreadData[] = [];

  for (let i = 0; i < sentThreads.length; i += 10) {
    const batch = sentThreads.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (threadMeta) => {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadMeta.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        const messages = thread.data.messages || [];
        if (messages.length === 0) return null;

        const first = messages[0];
        const last = messages[messages.length - 1];
        const to = getHeader(first, 'To');
        const cc = getHeader(first, 'Cc');

        // Parse email addresses from To and CC
        const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
        const toEmails = [...(to.match(emailRegex) || []), ...(cc.match(emailRegex) || [])]
          .map(e => e.toLowerCase())
          .filter(e => !e.includes(userEmail.toLowerCase()));

        const firstFrom = getHeader(first, 'From');
        const lastFrom = getHeader(last, 'From');

        return {
          id: threadMeta.id,
          subject: getHeader(first, 'Subject'),
          to,
          toEmails,
          firstFrom,
          lastFrom,
          lastDate: getHeader(last, 'Date'),
          snippet: last.snippet || '',
          messageCount: messages.length,
          userSentFirst: firstFrom.toLowerCase().includes(userEmail.toLowerCase()),
          userSentLast: lastFrom.toLowerCase().includes(userEmail.toLowerCase()),
        };
      } catch { return null; }
    }));

    for (const r of results) {
      if (r) threadData.push(r);
    }
    if ((i + 10) % 50 === 0 || i + 10 >= sentThreads.length) {
      process.stdout.write(`\r  Fetched: ${Math.min(i + 10, sentThreads.length)}/${sentThreads.length}`);
    }
  }
  console.log(`\n  ${threadData.length} sent threads with data`);

  // ============================================================
  // PHASE B: Record outbound entity mentions (CRITICAL, no LLM)
  // This is the data that fixes solicitation detection.
  // ============================================================
  console.log('  Phase B: Recording outbound entity mentions...');
  let outboundMentions = 0;

  const findEntityByEmail = db.prepare(
    'SELECT id FROM entities WHERE email = ? AND user_dismissed = 0'
  );
  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date)
    VALUES (?, ?, ?, 'recipient', 'outbound', ?)
  `);

  for (const td of threadData) {
    // Find knowledge item for this thread (if exists)
    const sourceRef = `thread:${td.id}`;
    const knowledgeItem = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(sourceRef) as any;

    if (knowledgeItem) {
      for (const email of td.toEmails) {
        const entity = findEntityByEmail.get(email) as any;
        if (entity) {
          insertMention.run(uuid(), entity.id, knowledgeItem.id, td.lastDate ? new Date(td.lastDate).toISOString() : null);
          outboundMentions++;
        }
      }
    }
  }
  console.log(`  ${outboundMentions} outbound entity mentions recorded`);

  // ============================================================
  // PHASE C: Correct existing items (remove false "awaiting_reply")
  // ============================================================
  console.log('  Phase C: Correcting existing items...');

  for (const td of threadData) {
    // Try matching by thread ID first, then by subject (thread IDs differ between inbox/sent views)
    const sourceRef = `thread:${td.id}`;
    let existing = db.prepare('SELECT id, metadata, tags FROM knowledge WHERE source_ref = ?').get(sourceRef) as any;
    if (!existing && td.subject) {
      // Fallback: match by subject in inbox items. Guarded (audit 2026-08-31):
      // escape LIKE wildcards, require a distinctive subject, and skip when
      // ambiguous — clearing waiting_on_user on the WRONG thread silently
      // drops a genuinely-owed reply from the ball lists.
      const stripped = td.subject.replace(/^(Re:|Fwd:)\s*/gi, '').trim().slice(0, 50);
      if (stripped.length >= 20) {
        const escaped = stripped.replace(/([%_\\])/g, '\\$1');
        const matches = db.prepare("SELECT id, metadata, tags FROM knowledge WHERE source = 'gmail' AND title LIKE ? ESCAPE '\\' ORDER BY source_date DESC LIMIT 2")
          .all(`%${escaped}%`) as any[];
        if (matches.length === 1) existing = matches[0];
        // 2 matches = ambiguous fallback — do nothing rather than guess
      }
    }

    if (existing && td.userSentLast) {
      const meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});
      const tags = typeof existing.tags === 'string' ? JSON.parse(existing.tags) : (existing.tags || []);

      if (tags.includes('awaiting_reply') || meta.waiting_on_user) {
        const newTags = tags.filter((t: string) => t !== 'awaiting_reply');
        const newMeta = {
          ...meta,
          waiting_on_user: false,
          user_replied: true,
          replied_at: td.lastDate ? new Date(td.lastDate).toISOString() : new Date().toISOString(),
          last_from: td.lastFrom,
          days_since_last: td.lastDate ? Math.floor((Date.now() - new Date(td.lastDate).getTime()) / 86400000) : 0,
        };

        db.prepare(
          'UPDATE knowledge SET tags = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).run(JSON.stringify(newTags), JSON.stringify(newMeta), existing.id);

        stats.corrected++;
      }
    }
  }
  console.log(`  ${stats.corrected} items corrected (awaiting_reply removed)`);

  // ============================================================
  // PHASE D: Create items for Zach-initiated threads (uses DeepSeek)
  // ============================================================
  // Create items for threads where Zach sent the latest message but the thread
  // either doesn't exist in KB OR exists but hasn't been updated since Zach replied.
  // This ensures Prime knows about EVERY email Zach sends, not just ones he initiated.
  const newThreads = threadData.filter(td => {
    if (!td.userSentLast) return false; // Only care about threads where Zach was last to send
    const sourceRef = `thread:${td.id}`;
    const existing = db.prepare('SELECT id, source_date, source FROM knowledge WHERE source_ref = ?').get(sourceRef) as any;
    if (!existing) {
      // Thread not in KB at all — create it
      return true;
    }
    // Thread exists — check if the inbox version has been updated with Zach's reply
    // If the KB item is older than the thread's last message, it needs updating
    if (existing.source === 'gmail' && td.lastDate) {
      const kbDate = new Date(existing.source_date).getTime();
      const threadDate = new Date(td.lastDate).getTime();
      if (threadDate > kbDate + 60000) {
        // light-touch UPDATE (audit 2026-08-31): recreating via insertKnowledge
        // REPLACEd the rich extraction with a snippet row, nulled raw_content/
        // created_at, and flipped source to gmail-sent — permanently removing
        // the thread from ball-list queries. Refresh in place instead.
        try {
          const row = db.prepare('SELECT metadata FROM knowledge WHERE id = ?').get(existing.id) as any;
          const meta = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : (row?.metadata || {});
          const newMeta = { ...meta, waiting_on_user: false, user_replied: true, last_from: td.lastFrom,
            replied_at: new Date(td.lastDate).toISOString() };
          db.prepare("UPDATE knowledge SET source_date = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?")
            .run(new Date(td.lastDate).toISOString(), JSON.stringify(newMeta), existing.id);
        } catch {}
        return false;
      }
    }
    return false;
  });

  if (newThreads.length > 0) {
    console.log(`  Phase D: Creating/updating ${newThreads.length} items for Zach's sent messages...`);
    const CONCURRENCY = 5;

    for (let i = 0; i < newThreads.length; i += CONCURRENCY) {
      const batch = newThreads.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (td) => {
        try {
          const content = `Sent email thread: "${td.subject}"\nTo: ${td.to}\n${td.messageCount} messages, last from ${td.lastFrom} on ${td.lastDate}\nLast message: ${td.snippet}`;

          const apiKey = getConfig(db, 'openai_api_key');
          const extracted = await extractIntelligence(content, apiKey);
          const embText = `${extracted.title}\n${extracted.summary}`;
          const embedding = await generateEmbedding(embText, apiKey!);

          const daysSince = td.lastDate ? Math.floor((Date.now() - new Date(td.lastDate).getTime()) / 86400000) : 0;

          const item: KnowledgeItem = {
            id: uuid(),
            title: extracted.title || `Sent: ${td.subject}`,
            summary: extracted.summary,
            source: 'gmail-sent',
            source_account: userEmail,
            source_ref: `thread:${td.id}`,
            source_date: td.lastDate ? new Date(td.lastDate).toISOString() : undefined,
            contacts: extracted.contacts,
            organizations: extracted.organizations,
            decisions: extracted.decisions,
            commitments: extracted.commitments,
            action_items: extracted.action_items,
            tags: [...extracted.tags, 'sent', 'user-initiated', ...(td.userSentLast ? [] : ['awaiting_reply_from_them'])],
            project: extracted.project,
            importance: extracted.importance,
            embedding,
            metadata: {
              thread_id: td.id,
              message_count: td.messageCount,
              subject: td.subject,
              to: td.to,
              to_emails: td.toEmails,
              last_from: td.lastFrom,
              days_since_last: daysSince,
              user_initiated: true,
              waiting_on_them: !td.userSentLast,
            },
          };

          insertKnowledge(db, item);
          stats.newItems++;

          // Also record outbound entity mentions for the new item
          for (const email of td.toEmails) {
            const entity = findEntityByEmail.get(email) as any;
            if (entity) {
              insertMention.run(uuid(), entity.id, item.id, td.lastDate ? new Date(td.lastDate).toISOString() : null);
            }
          }
        } catch (_e) {}
      }));

      process.stdout.write(`\r  Extracted: ${Math.min(i + CONCURRENCY, newThreads.length)}/${newThreads.length}`);
    }
    console.log('');
  }

  stats.scanned = threadData.length;
  console.log(`  Done: ${stats.scanned} scanned, ${stats.corrected} corrected, ${stats.newItems} new, ${outboundMentions} outbound mentions`);

  // Update sync state — report total items processed (corrections + new items)
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('gmail-sent', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.corrected + stats.newItems);

  return stats;
}

// ============================================================
// Send Email — Execution Engine Phase A1
// ============================================================

// Zach's own sending identities — a self-forward is never "waiting on Zach"
export const SELF_SENDER = /zach\.stock@recaptureinsurance|zstock@stockinsgroup|zstockco@gmail/i;
export const isSelfSender = (from: string) => SELF_SENDER.test(String(from || ''));

export async function sendEmail(
  db: Database.Database,
  options: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    replyToThreadId?: string;  // reply to existing thread
    html?: boolean;
    from?: string;  // default: quinn@recaptureinsurance.com
    inReplyTo?: string;  // RFC Message-ID of the mail being answered — threads in the RECIPIENT's mailbox
  }
): Promise<{ success: boolean; messageId?: string; threadId?: string; error?: string }> {
  // Use service account for sending (domain-wide delegation with gmail.send scope)
  // Header values may originate from LLM output — CR/LF here is header
  // injection (a newline in Subject can smuggle a Bcc). Audit 2026-08-31.
  const cleanHeader = (v?: string) => (v || '').replace(/[\r\n]+/g, ' ').trim();
  // Non-ASCII in a raw RFC2822 header renders as mojibake (Â· â€") in most
  // clients — RFC 2047 encoded-words are required. Body is fine (charset=utf-8).
  // RFC 2047 §2: each encoded-word ≤ 75 chars → chunk on character boundaries
  const encodeHeader = (v: string) => {
    if (!/[^\x20-\x7E]/.test(v)) return v;
    const words: string[] = []; let chunk = '';
    for (const ch of v) {
      if (Buffer.byteLength(chunk + ch, 'utf-8') > 45) { words.push(chunk); chunk = ''; }
      chunk += ch;
    }
    if (chunk) words.push(chunk);
    return words.map(w => '=?UTF-8?B?' + Buffer.from(w, 'utf-8').toString('base64') + '?=').join('\r\n ');
  };
  options = { ...options, to: cleanHeader(options.to), subject: cleanHeader(options.subject),
    cc: options.cc ? cleanHeader(options.cc) : undefined, bcc: options.bcc ? cleanHeader(options.bcc) : undefined };
  const fromEmail = options.from || 'quinn@recaptureinsurance.com';
  // Email budget: one choke point for everything Prime sends Zach (2026-09-01,
  // "too many emails"). Held messages are logged; the brief reports the count.
  const zachOnly = /zach\.stock@recaptureinsurance/i.test(options.to) && !/,/.test(options.to);
  if (zachOnly) {
    try {
      const { emailBudgetAllows } = await import('../email-budget.js');
      const verdict = emailBudgetAllows(db, options.subject, options.inReplyTo);
      if (!verdict.allowed) {
        console.log(`[email-budget] HELD (${verdict.reason}): ${options.subject.slice(0, 80)}`);
        return { success: false, error: `held by email budget: ${verdict.reason}` };
      }
    } catch (e: any) { console.log('[email-budget] check failed, sending: ' + (e?.message || e)); }
  }
  const saAuth = getServiceAccountAuth(fromEmail, ['https://www.googleapis.com/auth/gmail.send']);
  if (!saAuth) {
    return { success: false, error: 'Service account not configured for gmail.send' };
  }

  const gmail = google.gmail({ version: 'v1', auth: saAuth });
  const userEmail = fromEmail;

  // Build RFC 2822 message
  const contentType = options.html ? 'text/html' : 'text/plain';
  // Build headers (filter empty optional ones) then body
  const headers = [
    `From: ${userEmail}`,
    `To: ${options.to}`,
    options.cc ? `Cc: ${options.cc}` : null,
    options.bcc ? `Bcc: ${options.bcc}` : null,
    `Subject: ${encodeHeader(options.subject)}`,
    options.inReplyTo ? `In-Reply-To: ${cleanHeader(options.inReplyTo)}` : null,
    options.inReplyTo ? `References: ${cleanHeader(options.inReplyTo)}` : null,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=utf-8`,
  ].filter(h => h !== null).join('\r\n');

  // RFC 2822: blank line MUST separate headers from body
  const messageParts = headers + '\r\n\r\n' + options.body;

  const encodedMessage = Buffer.from(messageParts, 'utf-8').toString('base64url');

  try {
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: options.replyToThreadId || undefined,
      },
    });

    // Log the sent email — but mark system-sent emails as derived to prevent contamination
    // System emails ([ACT]/[REMIND]/[PRIME HEALTH]/MECHANIC/briefs to Zach) must NOT be
    // logged as primary gmail-sent — monitors search gmail-sent for closure evidence,
    // and Quinn's own alert about an action must never count as the action (audit 2026-08-31).
    // Anything quinn@ sends to Zach alone is a system email — never closure evidence
    const isSystemEmail = fromEmail === 'quinn@recaptureinsurance.com' && /zach\.stock@recaptureinsurance/i.test(options.to) && !/,/.test(options.to);
    const { v4: uuidv4 } = await import('uuid');
    insertKnowledge(db, {
      id: uuidv4(),
      title: `Sent: ${options.subject}`,
      summary: `Email sent to ${options.to}. ${options.body.slice(0, 200)}`,
      source: isSystemEmail ? 'agent-notification' : 'gmail-sent',
      source_ref: `sent:${result.data.id}`,
      source_date: new Date().toISOString(),
      contacts: [options.to.split('<').pop()?.replace('>', '').trim() || options.to],
      tags: isSystemEmail ? ['sent', 'system-email', 'quinn'] : ['sent', 'agent-action'],
      importance: 'normal',
      provenance: isSystemEmail ? 'derived' : 'primary',
      metadata: {
        message_id: result.data.id,
        thread_id: result.data.threadId,
        to: options.to,
        subject: options.subject,
        sent_by: 'prime-recall-agent',
      },
    });

    return {
      success: true,
      messageId: result.data.id || undefined,
      threadId: result.data.threadId || undefined,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
