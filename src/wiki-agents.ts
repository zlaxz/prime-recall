import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
// http.request removed — all proxy calls via curl now

// ============================================================
// Wiki Agents — Per-project/entity research agents that maintain
// authoritative wiki pages by going to the shelf (actual sources)
//
// Architecture:
//   1. Agent gets focused prompt: "Research everything about [subject]"
//   2. Agent uses MCP tools (prime_search, prime_retrieve, prime_entity)
//   3. Agent reads ACTUAL source material (emails, docs) not summaries
//   4. Agent produces a structured markdown wiki page
//   5. Page stored in compiled_pages table
//   6. Prime COS reads wiki pages instead of raw KB
// ============================================================

// Call Claude via proxy for wiki compilation.
// Uses Sonnet 4.6 (1M context) — good enough for compilation, saves Opus allocation for strategic work.
// All calls via curl (http.request doesn't wait for tool sessions).
async function callAgent(prompt: string, maxTurns: number = 50, timeoutSec: number = 600): Promise<string> {
  const { writeFileSync } = await import('fs');
  const { promisify } = await import('util');
  const { execFile } = await import('child_process');
  const execFileAsync = promisify(execFile);

  const body = JSON.stringify({
    prompt,
    timeout: timeoutSec,
    args: ['--model', 'claude-sonnet-4-6', '--max-turns', String(maxTurns)],
  });
  const tmpPath = `/tmp/wiki-agent-${Date.now()}.json`;

  try {
    writeFileSync(tmpPath, body);
    const { stdout } = await execFileAsync('/usr/bin/curl', [
      '-s', '-X', 'POST',
      'http://127.0.0.1:3211/claude',
      '-H', 'Content-Type: application/json',
      '-d', `@${tmpPath}`,
      '--max-time', String(timeoutSec + 30),
    ], { timeout: (timeoutSec + 60) * 1000, maxBuffer: 10 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    if (parsed.error) throw new Error(`Proxy error: ${parsed.error}`);
    return parsed.result || '';
  } finally {
    try { const { unlinkSync } = await import('fs'); unlinkSync(tmpPath); } catch {}
  }
}

// Compile a wiki page for a PROJECT
export async function compileProjectPage(db: Database.Database, projectName: string): Promise<string> {
  const now = new Date();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });

  // Load corrections for this project
  const corrections = db.prepare(
    "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 10"
  ).all('%' + projectName + '%', '%' + projectName + '%') as any[];

  const correctionText = corrections.length > 0
    ? '\n\nVERIFIED CORRECTIONS (absolute truth — bake these into the page):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  const prompt = [
    'You are a project research analyst. Your job: produce an authoritative wiki page for the project "' + projectName + '".',
    '',
    'TODAY IS: ' + dateStr + '. Include day-of-week for ALL dates.',
    '',
    'PROCESS:',
    '1. Call prime_search with "' + projectName + '" to find all related knowledge items',
    '2. Call prime_get_commitments to find open commitments for this project',
    '3. For the 3-5 most important recent items, call prime_retrieve to read the ACTUAL source material (emails, documents)',
    '4. If key people are involved, call prime_entity on them',
    '5. Write the wiki page based on what you ACTUALLY READ — not summaries',
    '',
    'OUTPUT FORMAT (return ONLY this markdown):',
    '# ' + projectName,
    '**Status:** [accelerating/steady/stalling/stalled] | **Updated:** ' + dateStr,
    '',
    '## Current Situation',
    '[2-3 sentences: what is happening RIGHT NOW based on the most recent data you retrieved]',
    '',
    '## Key People',
    '[For each person: name, role, last action, what they are doing]',
    '',
    '## Recent Timeline',
    '[Chronological list of recent events with VERIFIED dates including day-of-week]',
    '',
    '## Open Items',
    '[Commitments, action items, decisions needed — with owners]',
    '',
    '## What Zach Should Know',
    '[1-3 bullets]',
    '',
    '## Sources Consulted',
    '[List of source_refs you actually retrieved and read, e.g., "thread:abc123 — Costas email April 1"]',
    '[1-3 bullet points: the things that matter for Zach\'s decisions]',
    '',
    'RULES:',
    '- MANDATORY: Every factual claim MUST end with a citation in format [thread:ID] or [source_ref]. Example: "Forrest confirmed the rates are ready [thread:19d729ca04c7a103]." A page without citations is REJECTED.',
    '- When you call prime_retrieve, copy the source_ref ID and use it as your citation',
    '- ONLY state facts you verified by reading source material via prime_retrieve',
    '- If you did not read the actual email/document, do NOT claim to know what it says',
    '- Include day-of-week for ALL dates',
    '- Cite sources: "(per [person] email [date])" or "(per calendar)"',
    '- If something is unclear or you could not verify it, say so',
    correctionText,
  ].join('\n');

  const result = await callAgent(prompt, 50, 600);

  // Extract the markdown page from the response
  let page = result;
  // If the response has markdown fences, extract
  const mdMatch = result.match(/```(?:markdown)?\n([\s\S]*?)```/);
  if (mdMatch) page = mdMatch[1];
  // If it starts with #, it's already markdown
  if (!page.startsWith('#')) {
    const hashIdx = page.indexOf('\n#');
    if (hashIdx >= 0) page = page.slice(hashIdx + 1);
  }

  // Store in compiled_pages
  db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version, source_item_count, last_source_date, compiled_at, stale)
    VALUES (?, 'project', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?), 1), ?, datetime('now'), datetime('now'), 0)
  `).run(
    uuid(), projectName, projectName, page,
    projectName, 0
  );

  return page;
}

// Compile a wiki page for an ENTITY (person)
export async function compileEntityPage(db: Database.Database, entityName: string, entityId: string): Promise<string> {
  const now = new Date();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });

  const corrections = db.prepare(
    "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 10"
  ).all('%' + entityName + '%', '%' + entityName + '%') as any[];

  const correctionText = corrections.length > 0
    ? '\n\nVERIFIED CORRECTIONS (absolute truth):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  const prompt = [
    'You are an entity research analyst. Produce an authoritative wiki page for "' + entityName + '".',
    '',
    'TODAY IS: ' + dateStr + '.',
    '',
    'PROCESS — CRAWL, don\'t just search once:',
    '1. Call prime_entity with "' + entityName + '" — note their connections, organizations, projects',
    '2. Search BROADLY — do multiple searches:',
    '   - Search "' + entityName + '" (full name)',
    '   - Search their FIRST NAME alone (catches informal references)',
    '   - Search their ORGANIZATION/COMPANY name (catches threads about their company)',
    '   - Search any connected PROJECT they\'re involved in + their name',
    '3. RETRIEVE at least 5-8 actual sources — prioritize meeting transcripts (fireflies, otter), Claude conversations, and cowork sessions over email summaries. These have the richest context.',
    '4. Follow connections — if the entity profile mentions relationships, search for threads involving BOTH people',
    '5. Write the wiki page based on what you ACTUALLY READ across ALL source types',
    '',
    'OUTPUT FORMAT (return ONLY this markdown):',
    '# ' + entityName,
    '**Role:** [their role/title] | **Relationship:** [how they relate to Zach] | **Updated:** ' + dateStr,
    '',
    '## Current State',
    '[What is this person doing right now? What is their stance/position?]',
    '',
    '## Key Facts (verified)',
    '[Bullet list of facts verified from actual source material. Tag corrections with [CORRECTION]]',
    '',
    '## Recent Communication',
    '[Last 3-5 interactions with dates, day-of-week, and what was discussed]',
    '',
    '## Open Items',
    '[What this person owes Zach, what Zach owes them, pending decisions]',
    '',
    'RULES:',
    '- MANDATORY: Every factual claim MUST end with [thread:ID] or [source_ref] citation. A page without citations is REJECTED.',
    '- Copy the source_ref from prime_retrieve results and use it as citation.',
    '- Only state facts you verified by reading actual source. Include day-of-week on all dates.',
    correctionText,
  ].join('\n');

  const result = await callAgent(prompt, 50, 600); // Let the agent crawl across all sources

  let page = result;
  const mdMatch = result.match(/```(?:markdown)?\n([\s\S]*?)```/);
  if (mdMatch) page = mdMatch[1];
  if (!page.startsWith('#')) {
    const hashIdx = page.indexOf('\n#');
    if (hashIdx >= 0) page = page.slice(hashIdx + 1);
  }

  // Use slugified name as subject_id for readability (not opaque UUID)
  const slugId = (entityName || entityId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Clean up old UUID-based page if it exists
  db.prepare(`DELETE FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?`).run(entityId);

  db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version, last_source_date, compiled_at, stale)
    VALUES (?, 'entity', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?), 1), datetime('now'), datetime('now'), 0)
  `).run(uuid(), slugId, entityName, page, slugId);

  return page;
}

// Get all compiled wiki pages as context for the COS
export function getWikiContext(db: Database.Database): string {
  const pages = db.prepare(
    "SELECT page_type, subject_name, content, compiled_at FROM compiled_pages ORDER BY page_type, compiled_at DESC"
  ).all() as any[];

  if (pages.length === 0) return '(No wiki pages compiled yet)';

  const sections: string[] = [];
  sections.push('# COMPILED WIKI PAGES (authoritative, source-verified)\n');

  for (const page of pages) {
    sections.push(page.content);
    sections.push('\n---\n');
  }

  return sections.join('\n');
}
