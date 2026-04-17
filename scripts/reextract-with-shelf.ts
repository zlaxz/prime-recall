/**
 * Re-extract knowledge items that failed batch-reextract because they had
 * insufficient source text. This version fetches raw content from the Gmail
 * API ("goes to the shelf") BEFORE re-extracting.
 *
 * Targets: items with 'needs_reextraction' tag AND extraction_version != 3.
 * Gmail sources only (gmail, gmail-sent) — these are the ones that need API fetch.
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

const db = new Database(process.env.HOME + '/.prime/prime.db');
db.pragma('journal_mode = WAL');

const apiKey = process.env.OPENAI_API_KEY || '';

// ── Query items needing re-extraction ────────────────────────
const items = db.prepare(`
  SELECT id, source, source_ref, title, summary, raw_content,
    extraction_version, tags, source_account
  FROM knowledge
  WHERE tags LIKE '%needs_reextraction%'
    AND (extraction_version IS NULL OR extraction_version < 3)
    AND source IN ('gmail', 'gmail-sent')
  ORDER BY source_date DESC
`).all() as any[];

console.log(`Found ${items.length} Gmail items needing re-extraction with shelf fetch`);
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
      // Gmail fetch failed — mark v3 so we don't retry, move on
      markV3Stmt.run(item.id);
      fetchFailed++;
      return;
    }

    if (!content || content.length <= 100) {
      // Content too short even from API — mark v3 and skip
      markV3Stmt.run(item.id);
      contentTooShort++;
      return;
    }

    fetched++;

    // 3. Re-extract with V2 intelligence extraction
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
        item.id,
      );
      extracted++;
      return;
    }

    // 4. Update the knowledge item (strip needs_reextraction from tags)
    const newTags = (v2Result.tags || []).filter((t: string) => t !== 'needs_reextraction');

    // Flatten V2 contacts to string array for storage compatibility
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
      item.id,
    );

    // 5. Update embedding
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

  // Progress report every PROGRESS_INTERVAL items
  if (total % PROGRESS_INTERVAL === 0 || total === items.length) {
    console.log(
      `[${total}/${items.length}] ${(rate).toFixed(1)}/sec, ~${remaining}s left | ` +
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
console.log(`Content too short: ${contentTooShort}`);
console.log(`Time: ${totalTime}s`);
console.log(`Rate: ${(items.length / parseFloat(totalTime)).toFixed(1)} items/sec`);

db.close();
