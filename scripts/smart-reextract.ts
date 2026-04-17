/**
 * Smart re-extraction: finds gmail items with poor extractions (v3 with missing
 * contacts, generic titles) and re-extracts using full email body from Gmail API.
 *
 * CRITICAL: Only overwrites if the new extraction is BETTER than the old one.
 * Compares contacts count, summary length, and title quality.
 *
 * Usage: npx tsx scripts/smart-reextract.ts
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { retrieveGmailThread } from '../src/source-retrieval.js';
import { extractIntelligenceV2 } from '../src/ai/extract.js';
import { generateEmbedding } from '../src/embedding.js';

// Load .env
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const CONCURRENCY = 30;
const BATCH_LIMIT = 500;
const apiKey = process.env.OPENAI_API_KEY || '';

const db = new Database(process.env.HOME + '/.prime/prime.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// Find items that could benefit from re-extraction
const candidates = db.prepare(`
  SELECT id, source_ref, source_account, title, summary, contacts,
    extraction_version
  FROM knowledge
  WHERE source = 'gmail'
    AND (
      -- v3 items with missing/empty contacts
      (extraction_version = 3 AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5))
      -- OR generic title pattern
      OR title LIKE 'Email thread:%'
    )
  ORDER BY source_date DESC
  LIMIT ?
`).all(BATCH_LIMIT) as any[];

console.log(`Found ${candidates.length} candidates for smart re-extraction`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log('');

let improved = 0;
let kept_original = 0;
let not_found = 0;
let failed = 0;

function parseContacts(raw: string | null): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isGenericTitle(title: string): boolean {
  return title.startsWith('Email thread:');
}

function isBetter(oldItem: any, newExt: any): { better: boolean; reason: string } {
  const oldContacts = parseContacts(oldItem.contacts);
  const newContacts = newExt.contacts || [];
  const oldSummaryLen = (oldItem.summary || '').length;
  const newSummaryLen = (newExt.summary || '').length;
  const oldTitleGeneric = isGenericTitle(oldItem.title || '');
  const newTitleGeneric = isGenericTitle(newExt.title || '');

  // New has more contacts
  if (newContacts.length > oldContacts.length) {
    return { better: true, reason: `contacts ${oldContacts.length} -> ${newContacts.length}` };
  }

  // Old had generic title, new doesn't
  if (oldTitleGeneric && !newTitleGeneric && newExt.title?.length > 5) {
    return { better: true, reason: `title improved from generic` };
  }

  // New summary is significantly longer (at least 1.5x and 50+ chars more)
  if (newSummaryLen > oldSummaryLen * 1.5 && newSummaryLen > oldSummaryLen + 50) {
    return { better: true, reason: `summary ${oldSummaryLen} -> ${newSummaryLen} chars` };
  }

  return { better: false, reason: 'new extraction not clearly better' };
}

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
    extraction_version = 4,
    updated_at = datetime('now')
  WHERE id = ?
`);

const updateEmbedding = db.prepare('UPDATE knowledge SET embedding = ? WHERE id = ?');

async function processItem(item: any): Promise<void> {
  try {
    // Extract thread ID from source_ref
    const threadId = (item.source_ref || '').replace('thread:', '');
    if (!threadId) {
      failed++;
      return;
    }

    // Fetch full email content from Gmail API
    const content = await retrieveGmailThread(db, threadId, item.source_account);
    if (!content) {
      not_found++;
      return;
    }

    // Skip if content too short to be useful
    if (content.length < 200) {
      kept_original++;
      return;
    }

    // Run extraction on full content
    const newExt = await extractIntelligenceV2(content, apiKey);
    if (!newExt) {
      failed++;
      return;
    }

    // Compare: only overwrite if better
    const comparison = isBetter(item, newExt);
    if (!comparison.better) {
      kept_original++;
      return;
    }

    // Update the knowledge item
    const newTags = (newExt.tags || []).filter((t: string) => t !== 'needs_reextraction');

    updateStmt.run(
      newExt.title || item.title,
      newExt.summary || item.summary,
      JSON.stringify(newExt.contacts || []),
      JSON.stringify(newExt.organizations || []),
      JSON.stringify(newExt.decisions || []),
      JSON.stringify(newExt.commitments || []),
      JSON.stringify(newExt.action_items || []),
      JSON.stringify(newTags),
      newExt.project?.name || null,
      newExt.importance || 'normal',
      item.id,
    );

    // Update embedding
    try {
      const embText = `${newExt.title}\n${newExt.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);
      if (embedding) {
        const embBlob = Buffer.from(new Float32Array(embedding).buffer);
        updateEmbedding.run(embBlob, item.id);
      }
    } catch {} // Non-fatal

    improved++;
    console.log(`  IMPROVED [${item.id.slice(0, 8)}]: ${comparison.reason} — "${newExt.title?.slice(0, 60)}"`);
  } catch (err: any) {
    failed++;
    console.log(`  FAILED [${item.id.slice(0, 8)}]: ${err.message?.slice(0, 100)}`);
  }
}

// Process with concurrency limit
const startTime = Date.now();

for (let i = 0; i < candidates.length; i += CONCURRENCY) {
  const chunk = candidates.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(item => processItem(item)));

  const done = Math.min(i + CONCURRENCY, candidates.length);
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = done / elapsed;
  const remaining = Math.round((candidates.length - done) / rate);
  process.stdout.write(`\r  Progress: ${done}/${candidates.length} (${rate.toFixed(1)}/sec, ~${remaining}s left) | improved=${improved} kept=${kept_original} not_found=${not_found} failed=${failed}`);
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n=== SMART RE-EXTRACTION COMPLETE ===`);
console.log(`Candidates: ${candidates.length}`);
console.log(`Improved:       ${improved}`);
console.log(`Kept original:  ${kept_original}`);
console.log(`Not found:      ${not_found} (thread no longer accessible)`);
console.log(`Failed:         ${failed}`);
console.log(`Time:           ${totalTime}s`);

db.close();
