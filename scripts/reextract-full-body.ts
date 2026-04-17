/**
 * Re-extract Gmail knowledge items using the NEWLY FIXED extraction limits.
 *
 * The extractIntelligenceV2 function was updated:
 *   - Input limit: 12K → 30K chars
 *   - Output tokens: 2.5K → 3K
 *
 * All existing Gmail items were extracted with the old limits, producing
 * truncated summaries and missing contacts. This script re-extracts them
 * by fetching full email content from the Gmail API and running V2 extraction
 * with the new 30K limit.
 *
 * Targets:
 *   - extraction_version < 3 (never properly extracted)
 *   - extraction_version = 3 but updated_at before 2026-04-16T20:00:00 (old limits)
 *
 * Concurrency: 50 (Gmail API safe limit).
 * Cost: ~$0.001/item via DeepSeek bulk provider.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { retrieveGmailThread } from '../src/source-retrieval.js';
import { extractIntelligenceV2 } from '../src/ai/extract.js';
import { generateEmbedding } from '../src/embedding.js';

// ── Load .env ────────────────────────────────────────────────
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const CONCURRENCY = 50;
const PROGRESS_INTERVAL = 100;
const CUTOFF_DATE = '2026-04-16T20:00:00'; // Before this = old extraction limits

const db = new Database(process.env.HOME + '/.prime/prime.db');
db.pragma('journal_mode = WAL');

const apiKey = process.env.OPENAI_API_KEY || '';

// ── Query items needing re-extraction ────────────────────────
// Two groups:
//   1. extraction_version < 3 (never fully extracted from source)
//   2. extraction_version = 3 but extracted before the limit fix
const items = db.prepare(`
  SELECT id, source, source_ref, title, summary, source_account,
    extraction_version, updated_at
  FROM knowledge
  WHERE source IN ('gmail', 'gmail-sent')
    AND (
      extraction_version IS NULL
      OR extraction_version < 3
      OR (extraction_version = 3 AND updated_at < ?)
    )
  ORDER BY source_date DESC
`).all(CUTOFF_DATE) as any[];

console.log(`Found ${items.length} Gmail items to re-extract with 30K limit`);
console.log(`Cutoff: items extracted before ${CUTOFF_DATE}`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log(`Estimated cost: ~$${(items.length * 0.001).toFixed(2)}\n`);

if (items.length === 0) {
  console.log('Nothing to do.');
  db.close();
  process.exit(0);
}

// ── Prepared statements ──────────────────────────────────────
const updateStmt = db.prepare(`
  UPDATE knowledge SET
    title = ?,
    summary = ?,
    contacts = ?,
    organizations = ?,
    decisions = ?,
    commitments = ?,
    action_items = ?,
    tags = ?,
    project = COALESCE(?, project),
    importance = ?,
    extraction_version = 3,
    metadata = json_set(COALESCE(metadata, '{}'), '$.extraction_v2', ?),
    updated_at = datetime('now')
  WHERE id = ?
`);

const updateEmbeddingStmt = db.prepare(
  'UPDATE knowledge SET embedding = ? WHERE id = ?'
);

// Mark item as v3 even if Gmail fetch fails (so we don't retry endlessly)
const markV3Stmt = db.prepare(
  "UPDATE knowledge SET extraction_version = 3, updated_at = datetime('now') WHERE id = ?"
);

// ── Counters ─────────────────────────────────────────────────
let fetched = 0;
let extracted = 0;
let fetchFailed = 0;
let extractFailed = 0;
let contentTooShort = 0;

// ── Process a single item ────────────────────────────────────
async function processItem(item: any): Promise<void> {
  try {
    // 1. Parse threadId from source_ref (formats: "thread:XXXXX", "sent:XXXXX", or bare ID)
    const threadId = (item.source_ref || '').replace(/^(thread:|sent:)/, '');
    if (!threadId) {
      markV3Stmt.run(item.id);
      fetchFailed++;
      return;
    }

    // 2. Fetch full content from Gmail API
    let content: string | null = null;
    try {
      content = await retrieveGmailThread(db, threadId, item.source_account);
    } catch (err: any) {
      markV3Stmt.run(item.id);
      fetchFailed++;
      return;
    }

    if (!content || content.length <= 200) {
      markV3Stmt.run(item.id);
      contentTooShort++;
      return;
    }

    fetched++;

    // 3. Re-extract with V2 intelligence extraction (now uses 30K input limit)
    let v2Result;
    try {
      v2Result = await extractIntelligenceV2(content);
    } catch (err: any) {
      markV3Stmt.run(item.id);
      extractFailed++;
      return;
    }

    if (!v2Result || v2Result.title === '[NOISE]') {
      // Noise items — still update to mark as processed
      const noiseTags = JSON.stringify(['noise']);
      updateStmt.run(
        v2Result?.title || item.title,
        v2Result?.summary || item.summary,
        '[]', '[]', '[]', '[]', '[]',
        noiseTags,
        null,
        'low',
        JSON.stringify(v2Result || {}),
        item.id,
      );
      extracted++;
      return;
    }

    // 4. Flatten V2 structured results to string arrays for storage
    const contactNames = (v2Result.contacts || []).map((c: any) =>
      typeof c === 'string' ? c : c.name
    );
    const orgNames = (v2Result.organizations || []).map((o: any) =>
      typeof o === 'string' ? o : o.name
    );
    const decisionTexts = (v2Result.decisions || []).map((d: any) =>
      typeof d === 'string' ? d : d.text
    );
    const commitmentTexts = (v2Result.commitments || []).map((c: any) =>
      typeof c === 'string' ? c : c.text
    );
    const actionTexts = (v2Result.action_items || []).map((a: any) =>
      typeof a === 'string' ? a : a.text
    );

    const projectName = v2Result.project
      ? (typeof v2Result.project === 'string' ? v2Result.project : v2Result.project.name)
      : null;

    const newTags = (v2Result.tags || []).filter((t: string) =>
      t !== 'needs_reextraction'
    );

    updateStmt.run(
      v2Result.title || item.title,
      v2Result.summary || item.summary,
      JSON.stringify(contactNames),
      JSON.stringify(orgNames),
      JSON.stringify(decisionTexts),
      JSON.stringify(commitmentTexts),
      JSON.stringify(actionTexts),
      JSON.stringify(newTags),
      projectName,
      v2Result.importance || 'normal',
      JSON.stringify(v2Result),
      item.id,
    );

    // 5. Update embedding from new title + summary
    try {
      const embText = `${v2Result.title}\n${v2Result.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);
      if (embedding) {
        const embBlob = Buffer.from(new Float32Array(embedding).buffer);
        updateEmbeddingStmt.run(embBlob, item.id);
      }
    } catch {} // Non-fatal

    // DO NOT store raw_content permanently (library metaphor — it's a cache)

    extracted++;
  } catch (err: any) {
    // Catch-all: mark v3 so we don't retry
    try { markV3Stmt.run(item.id); } catch {}
    extractFailed++;
  }
}

// ── Main loop with concurrency control ───────────────────────
const startTime = Date.now();

for (let i = 0; i < items.length; i += CONCURRENCY) {
  const chunk = items.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(item => processItem(item)));

  const total = Math.min(i + CONCURRENCY, items.length);
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = total / elapsed;
  const remaining = Math.round((items.length - total) / rate);

  if (total % PROGRESS_INTERVAL === 0 || total === items.length) {
    console.log(
      `[${total}/${items.length}] ${rate.toFixed(1)}/sec, ~${remaining}s left | ` +
      `fetched=${fetched} extracted=${extracted} fetchFail=${fetchFailed} ` +
      `extractFail=${extractFailed} tooShort=${contentTooShort}`
    );
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n=== COMPLETE ===`);
console.log(`Total items: ${items.length}`);
console.log(`Gmail fetched: ${fetched}`);
console.log(`Successfully extracted: ${extracted}`);
console.log(`Gmail fetch failed: ${fetchFailed}`);
console.log(`Extraction failed: ${extractFailed}`);
console.log(`Content too short (<200 chars): ${contentTooShort}`);
console.log(`Time: ${totalTime}s`);
console.log(`Rate: ${(items.length / parseFloat(totalTime)).toFixed(1)} items/sec`);

db.close();
