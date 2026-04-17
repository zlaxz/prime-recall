import { google } from 'googleapis';
import type Database from 'better-sqlite3';
import { getConfig } from './db.js';

// ============================================================
// Source Retrieval — "Go back to the shelf"
//
// The knowledge base is an INDEX (card catalog).
// When the dream pipeline needs deep understanding, it uses
// this module to retrieve the ACTUAL source content via APIs.
//
// The index tells us WHAT to look at (source_ref).
// This module retrieves the actual content.
// ============================================================

export interface RetrievedSource {
  source: string;
  source_ref: string;
  content: string;          // the actual full content
  content_type: 'email_thread' | 'meeting_transcript' | 'conversation' | 'unknown';
  retrieved_at: string;
}

// ── Gmail: Retrieve actual email thread content ──────────────

async function getGmailClient(db: Database.Database) {
  const tokens = getConfig(db, 'gmail_tokens');
  if (!tokens) return null;

  const parsed = typeof tokens === 'string' ? JSON.parse(tokens) : tokens;

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || getConfig(db, 'google_client_id') || '',
    process.env.GOOGLE_CLIENT_SECRET || getConfig(db, 'google_client_secret') || '',
    'http://localhost:9876/callback'
  );
  oauth2.setCredentials(parsed);

  // Auto-refresh expired tokens
  if (parsed.expiry_date && Date.now() > parsed.expiry_date && parsed.refresh_token) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      // Persist refreshed tokens
      const { setConfig } = await import('./db.js');
      setConfig(db, 'gmail_tokens', credentials);
    } catch (err: any) {
      console.log(`  Token refresh failed: ${err.message?.slice(0, 80)}`);
      return null;
    }
  }

  return google.gmail({ version: 'v1', auth: oauth2 });
}

// Gmail client via service account — for team member emails (Forrest, etc.)
async function getGmailClientForAccount(db: Database.Database, email: string) {
  try {
    const { getServiceAccountAuth } = await import('./connectors/gmail.js');
    const auth = getServiceAccountAuth(email, ['https://www.googleapis.com/auth/gmail.readonly']);
    if (!auth) return null;
    return google.gmail({ version: 'v1', auth });
  } catch {
    return null;
  }
}

// Smart Gmail client — ALWAYS use service account when available.
// The OAuth token is for quinn@ and can't access Zach's or Forrest's threads.
async function getSmartGmailClient(db: Database.Database, sourceAccount?: string) {
  // Try service account first for ANY account (including Zach's)
  const account = sourceAccount || 'zach.stock@recaptureinsurance.com';
  const saClient = await getGmailClientForAccount(db, account);
  if (saClient) return saClient;

  // Fallback to OAuth only if service account unavailable
  return getGmailClient(db);
}


export async function retrieveGmailThread(db: Database.Database, threadId: string, sourceAccount?: string): Promise<string | null> {
  const gmail = await getSmartGmailClient(db, sourceAccount);
  if (!gmail) return null;

  try {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = thread.data.messages || [];
    const parts: string[] = [];

    for (const msg of messages) {
      const headers = msg.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';

      // Extract body text
      let body = '';
      if (msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
      } else if (msg.payload?.parts) {
        for (const part of msg.payload.parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
          }
        }
        // Fallback to HTML if no plain text
        if (!body) {
          for (const part of msg.payload.parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
              const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
              body = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              break;
            }
          }
        }
      }

      parts.push(`--- ${from} (${date}) ---\nSubject: ${subject}\n${body.slice(0, 8000)}`);
    }

    return parts.join('\n\n');
  } catch (err: any) {
    console.log(`  Warning: Could not retrieve Gmail thread ${threadId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Fireflies: Retrieve full meeting transcript ──────────────

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';

export async function retrieveFirefliesTranscript(db: Database.Database, meetingId: string): Promise<string | null> {
  const apiKey = getConfig(db, 'fireflies_api_key');
  if (!apiKey) return null;

  try {
    const response = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query { transcript(id: "${meetingId}") {
          title
          sentences { text speaker_name start_time }
          summary { overview action_items shorthand_bullet }
        }}`,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json() as any;
    const transcript = data.data?.transcript;
    if (!transcript) return null;

    const parts: string[] = [];
    parts.push(`Meeting: ${transcript.title}`);

    if (transcript.summary?.overview) {
      parts.push(`\nOverview: ${transcript.summary.overview}`);
    }

    // Full transcript with speaker attribution
    if (transcript.sentences?.length) {
      parts.push('\n--- Full Transcript ---');
      let currentSpeaker = '';
      for (const s of transcript.sentences) {
        if (s.speaker_name !== currentSpeaker) {
          currentSpeaker = s.speaker_name;
          parts.push(`\n[${currentSpeaker}]`);
        }
        parts.push(s.text);
      }
    }

    if (transcript.summary?.action_items?.length) {
      parts.push('\n--- Action Items ---');
      const items = Array.isArray(transcript.summary.action_items)
        ? transcript.summary.action_items
        : [transcript.summary.action_items];
      for (const item of items) parts.push(`- ${item}`);
    }

    return parts.join('\n').slice(0, 50000); // Opus 4.6 1M context — generous cap
  } catch (err: any) {
    console.log(`  Warning: Could not retrieve Fireflies transcript ${meetingId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Gmail Attachment Retrieval ──────────────────────────────

export async function retrieveGmailAttachments(
  db: Database.Database,
  messageId: string
): Promise<Array<{ filename: string; content: string; mimeType: string }>> {
  const gmail = await getGmailClient(db);
  if (!gmail) return [];

  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const attachments: Array<{ filename: string; content: string; mimeType: string }> = [];
    const parts = msg.data.payload?.parts || [];

    for (const part of parts) {
      if (!part.filename || !part.body?.attachmentId) continue;

      // Only process readable document types
      const readable = ['.docx', '.doc', '.txt', '.pdf', '.md', '.csv', '.xlsx'];
      const ext = part.filename.toLowerCase();
      if (!readable.some(r => ext.endsWith(r))) continue;

      try {
        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body.attachmentId,
        });

        const buffer = Buffer.from(attachment.data.data!, 'base64');
        let text = '';

        if (ext.endsWith('.txt') || ext.endsWith('.md') || ext.endsWith('.csv')) {
          text = buffer.toString('utf-8');
        } else if (ext.endsWith('.docx') || ext.endsWith('.doc')) {
          // macOS textutil converts Word docs to text
          const { execSync } = await import('child_process');
          const { writeFileSync, unlinkSync } = await import('fs');
          const tmpPath = `/tmp/prime_attachment_${Date.now()}.docx`;
          writeFileSync(tmpPath, buffer);
          try {
            const { spawnSync } = await import('child_process');
            const r = spawnSync('textutil', ['-convert', 'txt', '-stdout', tmpPath], { timeout: 10000 });
            text = r.stdout?.toString() || '';
          } catch {
            text = `[Could not extract text from ${part.filename}]`;
          }
          try { unlinkSync(tmpPath); } catch (_e) {}
        } else if (ext.endsWith('.pdf')) {
          const { spawnSync } = await import('child_process');
          const { writeFileSync, unlinkSync } = await import('fs');
          const tmpPath = `/tmp/prime_attachment_${Date.now()}.pdf`;
          writeFileSync(tmpPath, buffer);
          try {
            // Use spawn with array args — prevents command injection via tmpPath
            const pdfScript = `
import sys
try:
    import fitz
    doc = fitz.open(sys.argv[1])
    text = '\\n'.join(page.get_text() for page in doc)
    print(text[:10000])
except:
    print('[PDF extraction requires PyMuPDF: pip install pymupdf]')
`;
            const result = spawnSync('python3', ['-c', pdfScript, tmpPath], { timeout: 15000 });
            text = result.stdout?.toString() || '';
          } catch {
            text = `[Could not extract text from ${part.filename}]`;
          }
          try { unlinkSync(tmpPath); } catch (_e) {}
        }

        if (text && text.length > 10) {
          attachments.push({
            filename: part.filename,
            content: text.slice(0, 15000), // Cap at 15K chars per document
            mimeType: part.mimeType || 'unknown',
          });
        }
      } catch (_e) {}
    }

    return attachments;
  } catch (err: any) {
    console.log(`  Warning: Could not retrieve attachments for ${messageId}: ${err.message?.slice(0, 80)}`);
    return [];
  }
}

// ── Master retrieval: Given a knowledge item, get the full source ──

export async function retrieveSourceContent(
  db: Database.Database,
  item: { source: string; source_ref: string; metadata?: any }
): Promise<RetrievedSource | null> {
  const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});

  // Check raw_content cache first (populated during dream runs, NOT permanent storage)
  try {
    const stored = db.prepare(
      'SELECT raw_content FROM knowledge WHERE source_ref = ? AND raw_content IS NOT NULL'
    ).get(item.source_ref) as any;
    if (stored?.raw_content) {
      const contentType = item.source === 'fireflies' ? 'meeting_transcript' :
                          item.source === 'gmail' || item.source === 'gmail-sent' ? 'email_thread' :
                          item.source === 'claude' || item.source === 'cowork' ? 'conversation' : 'unknown';
      return {
        source: item.source,
        source_ref: item.source_ref,
        content: stored.raw_content,
        content_type: contentType as any,
        retrieved_at: new Date().toISOString(),
      };
    }
  } catch (_e) {}

  // Retrieve via API — the index points to the source, go read it
  if (item.source === 'gmail' || item.source === 'gmail-sent') {
    const threadId = item.source_ref.replace('thread:', '');
    if (!threadId) return null;

    const content = await retrieveGmailThread(db, threadId, item.source_account);
    if (!content) return null;

    // Cache for this dream run (can be cleared later to save space)
    try {
      db.prepare('UPDATE knowledge SET raw_content = ? WHERE source_ref = ?')
        .run(content, item.source_ref);
    } catch (_e) {}

    return {
      source: item.source,
      source_ref: item.source_ref,
      content,
      content_type: 'email_thread',
      retrieved_at: new Date().toISOString(),
    };
  }

  if (item.source === 'fireflies') {
    // source_ref format: "fireflies:{meetingId}"
    const meetingId = item.source_ref.replace('fireflies:', '');
    if (!meetingId) return null;

    const content = await retrieveFirefliesTranscript(db, meetingId);
    if (!content) return null;

    return {
      source: item.source,
      source_ref: item.source_ref,
      content,
      content_type: 'meeting_transcript',
      retrieved_at: new Date().toISOString(),
    };
  }

  // Claude.ai conversations — retrieve via internal API
  if (item.source === 'claude') {
    const convUuid = item.source_ref.replace('claude:', '').replace('claude-artifact:', '').split(':')[0];
    if (!convUuid) return null;

    try {
      const sessionKey = getConfig(db, 'claude_session_key');
      const orgId = getConfig(db, 'claude_active_org');
      if (!sessionKey || !orgId) return null;

      const https = await import('https');
      const content = await new Promise<string | null>((resolve, reject) => {
        const req = https.request({
          hostname: 'claude.ai',
          path: `/api/organizations/${orgId}/chat_conversations/${convUuid}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
            'Cookie': `sessionKey=${sessionKey}`,
            'Accept': 'application/json',
          },
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const msgs = parsed.chat_messages || [];
              const text = msgs.map((m: any) => `[${m.sender}]: ${m.text || ''}`).join('\n\n');
              resolve(text || null);
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.setTimeout(15000);
        req.end();
      });

      if (content) {
        // Cache for this session
        try {
          db.prepare('UPDATE knowledge SET raw_content = ? WHERE source_ref = ?')
            .run(content.slice(0, 50000), item.source_ref);
        } catch (_e) {}

        return {
          source: item.source,
          source_ref: item.source_ref,
          content,
          content_type: 'conversation' as const,
          retrieved_at: new Date().toISOString(),
        };
      }
    } catch (_e) {}
  }

  // Otter.ai meetings — retrieve via internal API
  if (item.source === 'otter') {
    const otid = item.source_ref.replace('otter:', '');
    if (!otid) return null;

    try {
      const sessionId = getConfig(db, 'otter_session_id');
      const csrfToken = getConfig(db, 'otter_csrf_token');
      if (!sessionId || !csrfToken) return null;

      const https = await import('https');
      const content = await new Promise<string | null>((resolve, reject) => {
        const req = https.request({
          hostname: 'otter.ai',
          path: `/forward/api/v1/speech?otid=${otid}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
            'Cookie': `sessionid=${sessionId}; csrftoken=${csrfToken}`,
            'X-CSRFToken': csrfToken,
            'Referer': 'https://otter.ai/',
            'Accept': 'application/json',
          },
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const speech = parsed.speech || {};
              // Build text from outline segments
              const outline = speech.speech_outline || [];
              const flatten = (items: any[]): string[] => {
                const texts: string[] = [];
                for (const item of (Array.isArray(items) ? items : [])) {
                  if (item.text) texts.push(item.text);
                  if (item.segments) texts.push(...flatten(item.segments));
                }
                return texts;
              };
              const outlineText = flatten(outline).join('\n');
              const text = `Meeting: ${speech.title}\nSpeakers: ${(speech.speakers || []).map((s: any) => s.speaker_name).join(', ')}\nSummary: ${speech.summary || ''}\n\nOutline:\n${outlineText}`;
              resolve(text || null);
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.setTimeout(15000);
        req.end();
      });

      if (content) {
        return {
          source: item.source,
          source_ref: item.source_ref,
          content,
          content_type: 'meeting_transcript' as const,
          retrieved_at: new Date().toISOString(),
        };
      }
    } catch (_e) {}
  }

  // For other sources (cowork, etc.), use stored metadata.conversation_text if available
  if (meta?.conversation_text) {
    return {
      source: item.source,
      source_ref: item.source_ref,
      content: meta.conversation_text,
      content_type: 'conversation' as const,
      retrieved_at: new Date().toISOString(),
    };
  }

  return null;
}

// ── Selective retrieval for dream pipeline ────────────────────
// Given a list of knowledge items for an entity, retrieve full
// source content for the N most important/recent items.

export async function retrieveDeepContext(
  db: Database.Database,
  items: any[],
  maxRetrievals: number = 3
): Promise<string> {
  // Prioritize: most recent first, prefer gmail and fireflies (richest sources)
  const candidates = items
    .filter(i => i.source === 'gmail' || i.source === 'fireflies' || i.source === 'gmail-sent')
    .sort((a, b) => {
      // Fireflies first (meeting transcripts are richest), then by date
      if (a.source === 'fireflies' && b.source !== 'fireflies') return -1;
      if (b.source === 'fireflies' && a.source !== 'fireflies') return 1;
      return (b.source_date || '').localeCompare(a.source_date || '');
    })
    .slice(0, maxRetrievals);

  const retrieved: string[] = [];

  for (const item of candidates) {
    const result = await retrieveSourceContent(db, item);
    if (result) {
      retrieved.push(`\n=== FULL SOURCE: ${item.title} (${result.content_type}) ===\n${result.content}`);
    }
  }

  return retrieved.join('\n');
}
