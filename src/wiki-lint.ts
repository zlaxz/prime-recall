import type Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Wiki Lint + Export — checks compiled pages for quality issues
 * and exports them as markdown files for human auditability.
 *
 * Called by the shift daemon every 4 hours.
 */

interface LintResult {
  stalePages: string[];
  missingPages: string[];
  exportedFiles: number;
  issues: string[];
}

export async function lintAndExportWiki(db: Database.Database): Promise<LintResult> {
  const wikiDir = join(process.env.HOME || '', '.prime', 'wiki');
  const result: LintResult = { stalePages: [], missingPages: [], exportedFiles: 0, issues: [] };

  // ── 1. CHECK STALENESS ──
  // Find compiled pages where source knowledge items are newer than the compilation
  const pages = db.prepare(`
    SELECT page_type, subject_id, subject_name, content, compiled_at, version
    FROM compiled_pages
  `).all() as any[];

  for (const page of pages) {
    const ageHours = (Date.now() - new Date(page.compiled_at).getTime()) / 3600000;

    // Project pages should be <24h old, entity pages <72h
    const threshold = page.page_type === 'project' ? 24 : 72;
    if (ageHours > threshold) {
      result.stalePages.push(`${page.page_type}:${page.subject_id} (${Math.round(ageHours)}h old)`);
      // Mark as stale in DB
      db.prepare(`UPDATE compiled_pages SET stale = 1 WHERE page_type = ? AND subject_id = ?`)
        .run(page.page_type, page.subject_id);
    }

    // Check for empty/stub pages
    if (!page.content || page.content.length < 100) {
      result.issues.push(`STUB: ${page.page_type}:${page.subject_id} (${(page.content || '').length} chars)`);
    }
  }

  // ── 2. CHECK MISSING PAGES ──
  // Entities with many mentions but no compiled page
  const entitiesWithoutPages = db.prepare(`
    SELECT e.canonical_name, COUNT(em.id) as mention_count
    FROM entities e
    JOIN entity_mentions em ON e.id = em.entity_id
    LEFT JOIN compiled_pages cp ON cp.page_type = 'entity'
      AND cp.subject_id = lower(replace(replace(e.canonical_name, ' ', '-'), '.', ''))
    WHERE cp.id IS NULL AND e.user_dismissed = 0
    GROUP BY e.id
    HAVING mention_count >= 10
    ORDER BY mention_count DESC
    LIMIT 10
  `).all() as any[];

  for (const e of entitiesWithoutPages) {
    result.missingPages.push(`${e.canonical_name} (${e.mention_count} mentions, no wiki page)`);
  }

  // ── 3. EXPORT TO MARKDOWN ──
  // Write all compiled pages as human-readable .md files
  mkdirSync(join(wikiDir, 'people'), { recursive: true });
  mkdirSync(join(wikiDir, 'projects'), { recursive: true });

  const indexEntries: string[] = [];

  for (const page of pages) {
    if (!page.content || page.content.length < 50) continue;

    const subdir = page.page_type === 'entity' ? 'people' : 'projects';
    const filename = `${page.subject_id}.md`;
    const filepath = join(wikiDir, subdir, filename);

    // Add metadata header
    const header = [
      `<!-- Compiled by Prime | ${page.compiled_at} | v${page.version} -->`,
      `<!-- This is a READ-ONLY export. Source of truth is SQLite compiled_pages table. -->`,
      '',
    ].join('\n');

    writeFileSync(filepath, header + page.content);
    result.exportedFiles++;

    const ageH = Math.round((Date.now() - new Date(page.compiled_at).getTime()) / 3600000);
    const status = ageH < 24 ? 'fresh' : ageH < 72 ? 'aging' : 'STALE';
    indexEntries.push(`- [${page.subject_name || page.subject_id}](${subdir}/${filename}) — ${status}, v${page.version}, ${page.content.length} chars`);
  }

  // Write index.md
  const indexContent = [
    '# Prime Wiki Index',
    `Last updated: ${new Date().toISOString()}`,
    `Pages: ${result.exportedFiles}`,
    '',
    '## People',
    ...indexEntries.filter(e => e.includes('people/')),
    '',
    '## Projects',
    ...indexEntries.filter(e => e.includes('projects/')),
    '',
    `## Health`,
    `Stale pages: ${result.stalePages.length}`,
    `Missing pages: ${result.missingPages.length}`,
    `Issues: ${result.issues.length}`,
  ].join('\n');

  writeFileSync(join(wikiDir, 'index.md'), indexContent);

  // Write lint report
  const lintReport = [
    '# Wiki Lint Report',
    `Run: ${new Date().toISOString()}`,
    '',
    result.stalePages.length > 0 ? `## Stale Pages (${result.stalePages.length})\n${result.stalePages.map(s => `- ${s}`).join('\n')}` : '## Stale Pages\nNone',
    '',
    result.missingPages.length > 0 ? `## Missing Pages (${result.missingPages.length})\n${result.missingPages.map(s => `- ${s}`).join('\n')}` : '## Missing Pages\nNone',
    '',
    result.issues.length > 0 ? `## Issues (${result.issues.length})\n${result.issues.map(s => `- ${s}`).join('\n')}` : '## Issues\nNone',
  ].join('\n');

  writeFileSync(join(wikiDir, 'lint-report.md'), lintReport);

  return result;
}
