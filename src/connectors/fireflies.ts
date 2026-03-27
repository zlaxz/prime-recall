import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding, generateEmbeddings } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

// ============================================================
// Fireflies.ai Connector — GraphQL API
// API docs: https://docs.fireflies.ai/
// ============================================================

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';

interface FirefliesMeeting {
  id: string;
  title: string;
  date: string;
  duration: number; // seconds
  organizers: string[];
  participants: string[];
  sentences: { text: string; speaker_name: string; start_time: number; end_time: number }[];
  summary: {
    action_items: string[];
    keywords: string[];
    overview: string;
    outline: string[];
    shorthand_bullet: string[];
  };
  speakers: { name: string; email: string; duration: number; word_count: number }[];
  audio_url: string;
  meeting_link: string;
}

async function firefliesQuery(apiKey: string, query: string, variables?: any): Promise<any> {
  const response = await fetch(FIREFLIES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Fireflies API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  if (data.errors) {
    throw new Error(`Fireflies GraphQL error: ${data.errors[0]?.message}`);
  }

  return data.data;
}

// ============================================================
// Connect — verify API key
// ============================================================

export async function connectFireflies(db: Database.Database, apiKey?: string): Promise<boolean> {
  let key = apiKey || process.env.FIREFLIES_API_KEY || getConfig(db, 'fireflies_api_key');

  if (!key) {
    console.log('  Fireflies API key needed.');
    console.log('  Get yours at: https://app.fireflies.ai/integrations/custom/fireflies');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
    key = (await ask('  Fireflies API key: ')).trim();
    rl.close();

    if (!key) {
      console.log('  ✗ No API key provided.');
      return false;
    }
  }

  // Verify by fetching user info
  try {
    const data = await firefliesQuery(key, `query { user { email name } }`);
    const user = data.user;

    setConfig(db, 'fireflies_api_key', key);
    setConfig(db, 'fireflies_email', user.email);

    db.prepare(
      `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('fireflies', 'connected', ?, datetime('now'))`
    ).run(JSON.stringify({ email: user.email, name: user.name }));

    console.log(`  ✓ Connected to Fireflies.ai: ${user.name} (${user.email})`);
    return true;
  } catch (err: any) {
    console.log(`  ✗ Failed to connect: ${err.message}`);
    return false;
  }
}

// ============================================================
// Scan — pull meetings and create knowledge items
// ============================================================

export async function scanFireflies(
  db: Database.Database,
  options: { days?: number; maxMeetings?: number } = {}
): Promise<{ meetings: number; items: number; skipped: number }> {
  const days = options.days || 90;
  const maxMeetings = options.maxMeetings || 100;

  const apiKey = getConfig(db, 'fireflies_api_key');
  const embeddingKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('Fireflies not connected. Run: recall connect fireflies');
  if (!embeddingKey) throw new Error('No OpenAI API key. Run: recall init');

  const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const toDate = new Date().toISOString().split('T')[0];

  const stats = { meetings: 0, items: 0, skipped: 0 };

  // Fetch meetings list
  console.log(`  Fetching meetings from ${fromDate} to ${toDate}...`);
  const data = await firefliesQuery(apiKey, `
    query($fromDate: String!, $toDate: String!) {
      transcripts(fromDate: $fromDate, toDate: $toDate) {
        id
        title
        date
        duration
        organizers
        participants
        summary {
          action_items
          keywords
          overview
          shorthand_bullet
        }
        speakers {
          name
          email
          duration
          word_count
        }
      }
    }
  `, { fromDate, toDate });

  const meetings = (data.transcripts || []).slice(0, maxMeetings);
  console.log(`  Found ${meetings.length} meetings`);

  // Filter already indexed
  const toProcess: any[] = [];
  for (const meeting of meetings) {
    const sourceRef = `fireflies:${meeting.id}`;
    const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(sourceRef);
    if (existing) {
      stats.skipped++;
    } else {
      toProcess.push(meeting);
    }
  }

  if (toProcess.length === 0) {
    console.log(`  All ${meetings.length} meetings already indexed`);
    return stats;
  }

  console.log(`  ${toProcess.length} new meetings to process`);

  // Process each meeting
  const CONCURRENCY = 3;
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (meeting: any) => {
      try {
        const summary = meeting.summary || {};
        const speakers = meeting.speakers || [];
        const participants = meeting.participants || [];
        const durationMin = Math.round((meeting.duration || 0) / 60);

        // Build content for extraction
        const content = [
          `Meeting: ${meeting.title}`,
          `Date: ${meeting.date}`,
          `Duration: ${durationMin} minutes`,
          speakers.length ? `Speakers: ${speakers.map((s: any) => `${s.name}${s.email ? ` (${s.email})` : ''}`).join(', ')}` : '',
          participants.length ? `Participants: ${participants.join(', ')}` : '',
          summary.overview ? `\nSummary: ${summary.overview}` : '',
          summary.shorthand_bullet?.length ? `\nKey Points:\n${summary.shorthand_bullet.join('\n')}` : '',
          summary.action_items?.length ? `\nAction Items:\n${summary.action_items.join('\n')}` : '',
        ].filter(Boolean).join('\n');

        // Extract intelligence
        const extracted = await extractIntelligence(content, embeddingKey);

        // Build embedding
        const embText = `${meeting.title}\n${summary.overview || ''}\n${speakers.map((s: any) => s.name).join(', ')}`;
        const embedding = await generateEmbedding(embText, embeddingKey);

        // Merge contacts: speakers with emails + extracted contacts
        const speakerNames = speakers.map((s: any) => s.name).filter(Boolean);
        const allContacts = [...new Set([...speakerNames, ...(extracted.contacts || [])])];

        const item: KnowledgeItem = {
          id: uuid(),
          title: extracted.title || `Meeting: ${meeting.title}`,
          summary: summary.overview || extracted.summary,
          source: 'fireflies',
          source_ref: `fireflies:${meeting.id}`,
          source_date: meeting.date ? new Date(meeting.date).toISOString() : new Date().toISOString(),
          contacts: allContacts,
          organizations: extracted.organizations,
          decisions: extracted.decisions,
          commitments: [...(extracted.commitments || []), ...(summary.action_items || [])],
          action_items: extracted.action_items,
          tags: [...(extracted.tags || []), 'meeting', 'fireflies', ...(summary.keywords || [])],
          project: extracted.project,
          importance: extracted.importance,
          embedding,
          metadata: {
            fireflies_id: meeting.id,
            duration_minutes: durationMin,
            speaker_count: speakers.length,
            participant_count: participants.length,
            speakers: speakers.map((s: any) => ({ name: s.name, email: s.email, duration: s.duration, words: s.word_count })),
            action_items: summary.action_items,
            keywords: summary.keywords,
            audio_url: meeting.audio_url,
            meeting_link: meeting.meeting_link,
            overview: summary.overview,
          },
        };

        insertKnowledge(db, item);
        stats.items++;
        stats.meetings++;
      } catch {
        stats.skipped++;
      }
    }));

    process.stdout.write(`\r  Processed: ${Math.min(i + CONCURRENCY, toProcess.length)}/${toProcess.length}`);
  }
  console.log('');

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('fireflies', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.items);

  return stats;
}
