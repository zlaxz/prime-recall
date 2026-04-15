/**
 * Batch re-extraction of flagged items using DeepSeek.
 * 100 concurrent extractions at a time.
 *
 * DeepSeek cost: ~$0.28/M input tokens, ~$1.10/M output tokens
 * Average item: ~2K input + ~500 output = ~$0.001 per item
 * 5,115 items × $0.001 = ~$5.12 total
 */

import Database from 'better-sqlite3';
import { extractIntelligenceV2 } from '../src/ai/extract.js';
import { generateEmbedding } from '../src/embedding.js';

const CONCURRENCY = 100;
const BATCH_SIZE = 500; // Process in batches to show progress

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Load .env for API keys
import { readFileSync } from 'fs';
try {
  const env = readFileSync(process.env.HOME + '/GitHub/prime/.env', 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const apiKey = process.env.OPENAI_API_KEY || '';

// Get all flagged items
const flagged = db.prepare(`
  SELECT id, source, source_ref, title, summary, raw_content,
    extraction_version, tags, source_account
  FROM knowledge
  WHERE tags LIKE '%needs_reextraction%'
  ORDER BY source_date DESC
`).all() as any[];

console.log(`Found ${flagged.length} items flagged for re-extraction`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log(`Estimated cost: ~$${(flagged.length * 0.001).toFixed(2)}\n`);

// For gmail items, we need to fetch full content from the API at re-extraction time
// For other items, use summary + raw_content as input
function getExtractionContent(item: any): string {
  // If raw_content exists and is substantial, use it
  if (item.raw_content && item.raw_content.length > 100) {
    return item.raw_content.slice(0, 8000);
  }
  // Otherwise use the summary (which is what the original extraction produced)
  // This won't improve much — the real value is for items that NOW have raw_content
  // from the full-body fetch, or for items where v2 extraction is simply better than v1
  return `${item.title || ''}\n\n${item.summary || ''}`;
}

// Convert V2 extraction to V1 format for storage
function toV1(v2: any): any {
  return {
    title: v2.title || '',
    summary: v2.summary || '',
    contacts: v2.contacts || [],
    organizations: v2.organizations || [],
    decisions: v2.decisions || [],
    commitments: v2.commitments || [],
    action_items: v2.action_items || [],
    tags: v2.tags || [],
    project: v2.project || null,
    importance: v2.importance || 'normal',
  };
}

let processed = 0;
let improved = 0;
let failed = 0;
let skipped = 0;

async function reextractItem(item: any): Promise<void> {
  try {
    const content = getExtractionContent(item);

    // Skip if content is too short to extract anything useful
    if (content.length < 30) {
      skipped++;
      return;
    }

    const v2Result = await extractIntelligenceV2(content, apiKey);
    if (!v2Result) {
      failed++;
      return;
    }

    const ext = toV1(v2Result);

    // Check if extraction actually improved
    const oldContacts = item.tags?.includes('[]') ? 0 : (item.tags?.match(/contacts/g) || []).length;
    const newContacts = (ext.contacts || []).length;
    const titleImproved = !ext.title.startsWith('Email thread:') && item.title.startsWith('Email thread:');

    // Update the item
    const newTags = (ext.tags || []).filter((t: string) => t !== 'needs_reextraction');

    db.prepare(`
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
    `).run(
      ext.title || item.title,
      ext.summary || item.summary,
      JSON.stringify(ext.contacts || []),
      JSON.stringify(ext.organizations || []),
      JSON.stringify(ext.decisions || []),
      JSON.stringify(ext.commitments || []),
      JSON.stringify(ext.action_items || []),
      JSON.stringify(newTags),
      ext.project,
      ext.importance || 'normal',
      item.id,
    );

    // Update embedding for the new title+summary
    try {
      const embText = `${ext.title}\n${ext.summary}`;
      const embedding = await generateEmbedding(embText, apiKey);
      if (embedding) {
        const embBlob = Buffer.from(new Float32Array(embedding).buffer);
        db.prepare('UPDATE knowledge SET embedding = ? WHERE id = ?').run(embBlob, item.id);
      }
    } catch {} // Non-fatal — embedding update is optional

    if (titleImproved || newContacts > 0) improved++;
    processed++;
  } catch (err: any) {
    failed++;
  }
}

// Process in batches with concurrency
const startTime = Date.now();

for (let batchStart = 0; batchStart < flagged.length; batchStart += BATCH_SIZE) {
  const batch = flagged.slice(batchStart, batchStart + BATCH_SIZE);
  console.log(`\nBatch ${Math.floor(batchStart / BATCH_SIZE) + 1}: items ${batchStart + 1}-${Math.min(batchStart + BATCH_SIZE, flagged.length)}...`);

  // Process batch with CONCURRENCY limit
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(item => reextractItem(item)));

    const total = batchStart + i + chunk.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = total / elapsed;
    const remaining = Math.round((flagged.length - total) / rate);
    process.stdout.write(`\r  ${total}/${flagged.length} (${Math.round(rate)}/sec, ~${remaining}s remaining) — ${improved} improved, ${failed} failed, ${skipped} skipped`);
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\n=== COMPLETE ===`);
console.log(`Total: ${flagged.length} items`);
console.log(`Processed: ${processed}`);
console.log(`Improved: ${improved} (better title or new contacts)`);
console.log(`Failed: ${failed}`);
console.log(`Skipped: ${skipped} (content too short)`);
console.log(`Time: ${totalTime}s`);
console.log(`Rate: ${(flagged.length / parseFloat(totalTime)).toFixed(1)} items/sec`);

db.close();
