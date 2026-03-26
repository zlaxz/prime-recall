import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, getConfig, setConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

// ============================================================
// Otter.ai Direct API Connector
// ============================================================

const OTTER_API_BASE = 'https://otter.ai/forward/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';

interface OtterCredentials {
  sessionId: string;
  csrfToken: string;
}

interface OtterSpeaker {
  speaker_name: string;
  speaker_id?: string;
}

interface OtterOutlineSegment {
  text?: string;
  children?: OtterOutlineSegment[];
}

interface OtterSpeech {
  otid: string;
  title: string;
  summary?: string;
  duration?: number;
  created_at?: number;
  speakers?: OtterSpeaker[];
  speech_outline?: OtterOutlineSegment[];
  participant_organizations?: string[];
  action_item_count?: number;
  transcripts?: any[];
  calendar_meeting_id?: string;
  calendar_guests?: string[];
}

interface OtterSpeechesResponse {
  speeches?: OtterSpeech[];
  next_page_token?: string;
  has_more?: boolean;
}

// ============================================================
// Cookie Extraction from Otter Desktop App
// ============================================================

/**
 * Extract credentials from the Otter.ai desktop app's SQLite cookie store.
 * Cookies are stored unencrypted — just read the value column.
 */
export function extractOtterCredentials(): OtterCredentials | null {
  const cookiePath = join(
    homedir(),
    'Library',
    'Application Support',
    'com.otterai.desktop',
    'Cookies'
  );

  if (!existsSync(cookiePath)) {
    return null;
  }

  try {
    // Copy the cookie DB first — Otter holds a lock while running
    const tmpPath = join(homedir(), '.prime', 'otter-cookies-tmp.db');
    const { copyFileSync, unlinkSync } = require('fs');
    copyFileSync(cookiePath, tmpPath);

    const BetterSqlite3 = require('better-sqlite3');
    const cookieDb = new BetterSqlite3(tmpPath, { readonly: true });

    const sessionRow = cookieDb.prepare(
      "SELECT value FROM cookies WHERE name='sessionid' AND host_key LIKE '%otter%'"
    ).get() as { value: string } | undefined;

    const csrfRow = cookieDb.prepare(
      "SELECT value FROM cookies WHERE name='csrftoken' AND host_key LIKE '%otter%'"
    ).get() as { value: string } | undefined;

    cookieDb.close();
    try { unlinkSync(tmpPath); } catch {}

    if (!sessionRow?.value || !csrfRow?.value) {
      console.log('    DEBUG: session=', sessionRow?.value?.slice(0, 10), 'csrf=', csrfRow?.value?.slice(0, 10));
      return null;
    }

    return {
      sessionId: sessionRow.value,
      csrfToken: csrfRow.value,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Otter API Client
// ============================================================

async function otterApiGet<T>(path: string, creds: OtterCredentials): Promise<T> {
  const url = `${OTTER_API_BASE}${path}`;
  const { request: httpsRequest } = await import('https');

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const req = httpsRequest({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Cookie': `sessionid=${creds.sessionId}; csrftoken=${creds.csrfToken}`,
        'X-CSRFToken': creds.csrfToken,
        'Referer': 'https://otter.ai/',
      },
    }, async (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        let data = Buffer.concat(chunks);

        if (res.headers['content-encoding'] === 'gzip') {
          const { gunzipSync } = await import('zlib');
          data = gunzipSync(data);
        }

        if (res.statusCode === 403 || res.statusCode === 401) {
          reject(Object.assign(
            new Error(`Otter API ${res.statusCode}: Session expired or invalid`),
            { statusCode: res.statusCode, isSessionExpired: true }
          ));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Otter API error ${res.statusCode}: ${data.toString().slice(0, 200)}`));
          return;
        }

        try {
          resolve(JSON.parse(data.toString()));
        } catch (e) {
          reject(new Error(`Failed to parse response from ${path}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// Connect & Scan
// ============================================================

/**
 * Connect to Otter.ai — extracts credentials from desktop app and verifies API access.
 */
export async function connectOtter(db: Database.Database): Promise<boolean> {
  console.log('  Attempting auto-extraction from Otter Desktop...');

  const creds = extractOtterCredentials();
  if (!creds) {
    console.log('  ✗ Could not extract credentials from Otter Desktop.');
    console.log('  Make sure the Otter desktop app is installed and you are logged in.');
    console.log('  Cookie path: ~/Library/Application Support/com.otterai.desktop/Cookies');
    return false;
  }

  console.log('  ✓ Credentials extracted from Otter Desktop');

  // Verify by fetching speeches list
  try {
    const response = await otterApiGet<OtterSpeechesResponse>('/speeches?page_size=1', creds);
    const meetingCount = response.speeches?.length ?? 0;

    // Save credentials to config
    setConfig(db, 'otter_session_id', creds.sessionId);
    setConfig(db, 'otter_csrf_token', creds.csrfToken);

    db.prepare(
      `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('otter', 'connected', ?, datetime('now'))`
    ).run(JSON.stringify({ verified: true }));

    console.log(`  ✓ Connected to Otter.ai`);
    if (meetingCount > 0) {
      console.log(`  Meetings accessible via API`);
    }

    return true;
  } catch (err: any) {
    console.log(`  ✗ Failed to connect: ${err.message}`);
    return false;
  }
}

/**
 * Flatten an Otter speech outline into a list of text strings.
 */
function flattenOutline(segments: OtterOutlineSegment[] | undefined): string[] {
  if (!segments) return [];
  const texts: string[] = [];

  for (const seg of segments) {
    if (seg.text) texts.push(seg.text);
    if (seg.children) texts.push(...flattenOutline(seg.children));
  }

  return texts;
}

/**
 * Scan Otter.ai meetings and ingest into the knowledge base.
 */
export async function scanOtter(
  db: Database.Database,
  options: { days?: number; maxMeetings?: number } = {}
): Promise<{ meetings: number; items: number }> {
  const days = options.days || 90;
  const maxMeetings = options.maxMeetings || 200;

  const sessionId = getConfig(db, 'otter_session_id');
  const csrfToken = getConfig(db, 'otter_csrf_token');
  const apiKey = getConfig(db, 'openai_api_key');

  if (!sessionId || !csrfToken) throw new Error('Otter not connected. Run: recall connect otter');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const creds: OtterCredentials = { sessionId, csrfToken };
  const stats = { meetings: 0, items: 0 };
  const cutoff = Date.now() - days * 86400000;

  // Fetch all meetings via paginated speeches endpoint
  console.log(`  Fetching meetings from the last ${days} days...`);

  const allSpeeches: OtterSpeech[] = [];
  let pageSize = 50;
  let fetched = 0;
  let hasMore = true;

  // Otter uses page_size and offset-based pagination
  while (hasMore && allSpeeches.length < maxMeetings) {
    const url = `/speeches?page_size=${pageSize}${fetched > 0 ? `&offset=${fetched}` : ''}`;
    const response = await otterApiGet<OtterSpeechesResponse>(url, creds);
    const speeches = response.speeches || [];

    if (speeches.length === 0) break;

    for (const speech of speeches) {
      // created_at is typically in seconds
      const createdMs = (speech.created_at || 0) * 1000;
      if (createdMs < cutoff) {
        hasMore = false;
        break;
      }
      allSpeeches.push(speech);
    }

    fetched += speeches.length;
    hasMore = hasMore && (response.has_more !== false) && speeches.length === pageSize;
    process.stdout.write(`\r  Fetched: ${allSpeeches.length} meetings`);
  }
  console.log('');

  // Filter out already-indexed meetings
  const toProcess: OtterSpeech[] = [];
  for (const speech of allSpeeches) {
    const existing = db.prepare(
      `SELECT id FROM knowledge WHERE source_ref = ?`
    ).get(`otter:${speech.otid}`);
    if (!existing) {
      toProcess.push(speech);
    }
  }

  console.log(`  ${toProcess.length} to process, ${allSpeeches.length - toProcess.length} already indexed`);

  if (toProcess.length === 0) return stats;

  // Fetch full speech data and process in parallel (5 concurrent)
  const CONCURRENCY = 5;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (speechMeta) => {
      try {
        // Fetch full speech data
        const speech = await otterApiGet<OtterSpeech>(`/speech?otid=${speechMeta.otid}`, creds);

        // Build content for extraction
        const speakerNames = (speech.speakers || []).map(s => s.speaker_name).filter(Boolean);
        const organizations = speech.participant_organizations || [];
        const outlineTexts = flattenOutline(speech.speech_outline);
        const summaryKeywords = speech.summary || '';

        const content = [
          `Meeting: ${speech.title}`,
          speakerNames.length ? `Speakers: ${speakerNames.join(', ')}` : '',
          organizations.length ? `Organizations: ${organizations.join(', ')}` : '',
          summaryKeywords ? `Keywords: ${summaryKeywords}` : '',
          speech.duration ? `Duration: ${Math.round(speech.duration / 60)} minutes` : '',
          speech.calendar_meeting_id ? `Calendar meeting: ${speech.calendar_meeting_id}` : '',
          speech.calendar_guests?.length ? `Calendar guests: ${speech.calendar_guests.join(', ')}` : '',
          outlineTexts.length ? `\nOutline:\n${outlineTexts.join('\n')}` : '',
          speech.action_item_count ? `\nAction items: ${speech.action_item_count} items noted` : '',
        ].filter(Boolean).join('\n');

        // Run AI extraction
        const extracted = await extractIntelligence(content, apiKey);

        // Generate embedding
        const embText = `${extracted.title || speech.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        // Determine importance: boost for meetings >30min with multiple speakers
        const durationMinutes = (speech.duration || 0) / 60;
        let importance = extracted.importance || 'normal';
        if (durationMinutes > 30 && speakerNames.length > 1) {
          importance = importance === 'low' ? 'normal' : importance === 'normal' ? 'high' : importance;
        }

        // Build knowledge item
        const item: KnowledgeItem = {
          id: uuid(),
          title: extracted.title || `Meeting: ${speech.title}`,
          summary: extracted.summary,
          source: 'otter',
          source_ref: `otter:${speech.otid}`,
          source_date: speech.created_at
            ? new Date(speech.created_at * 1000).toISOString()
            : new Date().toISOString(),
          contacts: [
            ...speakerNames,
            ...extracted.contacts,
          ].filter((v, i, a) => a.indexOf(v) === i),
          organizations: [
            ...organizations,
            ...(extracted.organizations || []),
          ].filter((v, i, a) => a.indexOf(v) === i),
          decisions: extracted.decisions,
          commitments: extracted.commitments,
          action_items: extracted.action_items,
          tags: [...extracted.tags, 'meeting', 'otter'],
          project: extracted.project,
          importance,
          embedding,
          metadata: {
            otid: speech.otid,
            duration: speech.duration,
            duration_minutes: Math.round(durationMinutes),
            speakers: speakerNames,
            organizations,
            calendar_meeting_id: speech.calendar_meeting_id,
            outline_topics: outlineTexts.slice(0, 20),
          },
        };

        insertKnowledge(db, item);
        stats.meetings++;
        stats.items++;
      } catch {
        // Skip failed meetings silently
      }
    }));

    process.stdout.write(`\r  Processed: ${Math.min(i + CONCURRENCY, toProcess.length)}/${toProcess.length}`);
  }
  console.log('');

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('otter', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.items);

  return stats;
}

// ============================================================
// Legacy: File-based import (kept for backward compat)
// ============================================================

/**
 * Process an Otter.ai meeting transcript (legacy — from webhook or file).
 */
export async function processOtterMeeting(
  db: Database.Database,
  meeting: {
    title: string;
    transcript?: string;
    summary?: string;
    participants?: string[];
    meeting_date?: string;
    duration_minutes?: number;
    source_url?: string;
    action_items?: string[];
  }
): Promise<{ id: string; title: string; commitments: string[] }> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const content = [
    `Meeting: ${meeting.title}`,
    meeting.meeting_date ? `Date: ${meeting.meeting_date}` : '',
    meeting.participants?.length ? `Participants: ${meeting.participants.join(', ')}` : '',
    meeting.duration_minutes ? `Duration: ${meeting.duration_minutes} minutes` : '',
    meeting.summary ? `\nSummary:\n${meeting.summary}` : '',
    meeting.transcript ? `\nTranscript:\n${meeting.transcript.slice(0, 6000)}` : '',
    meeting.action_items?.length ? `\nAction Items:\n${meeting.action_items.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const extracted = await extractIntelligence(content, apiKey);
  const embText = `${extracted.title}\n${extracted.summary}`;
  const embedding = await generateEmbedding(embText, apiKey);

  const item: KnowledgeItem = {
    id: uuid(),
    title: extracted.title || `Meeting: ${meeting.title}`,
    summary: extracted.summary,
    source: 'otter',
    source_ref: meeting.source_url || `otter:${Date.now()}`,
    source_date: meeting.meeting_date || new Date().toISOString(),
    contacts: [...(meeting.participants || []), ...extracted.contacts].filter((v, i, a) => a.indexOf(v) === i),
    organizations: extracted.organizations,
    decisions: extracted.decisions,
    commitments: [...extracted.commitments, ...(meeting.action_items || [])],
    action_items: extracted.action_items,
    tags: [...extracted.tags, 'meeting', 'otter'],
    project: extracted.project,
    importance: extracted.importance,
    embedding,
    metadata: {
      duration_minutes: meeting.duration_minutes,
      participant_count: meeting.participants?.length || 0,
      has_transcript: !!meeting.transcript,
      otter_url: meeting.source_url,
    },
  };

  insertKnowledge(db, item);

  return {
    id: item.id,
    title: item.title,
    commitments: [...extracted.commitments, ...(meeting.action_items || [])],
  };
}

export async function importOtterFile(
  db: Database.Database,
  filePath: string,
  options: { project?: string } = {}
): Promise<{ id: string; title: string }> {
  const { readFileSync } = await import('fs');
  const content = readFileSync(filePath, 'utf-8');

  let meeting: any;

  try {
    meeting = JSON.parse(content);
  } catch {
    meeting = {
      title: filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Otter Meeting',
      transcript: content,
    };
  }

  const result = await processOtterMeeting(db, meeting);
  return result;
}
