import Database from 'better-sqlite3';
import { compileEntityPage } from '../src/wiki-agents.js';
import { lintAndExportWiki } from '../src/wiki-lint.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Get all entity pages that need recompilation
const entityPages = db.prepare(`
  SELECT subject_id, subject_name FROM compiled_pages
  WHERE page_type = 'entity'
  ORDER BY compiled_at ASC
`).all() as any[];

// Also need entity IDs for the function call
const entities = db.prepare(`
  SELECT id, canonical_name FROM entities
  WHERE canonical_name IN (${entityPages.map(() => '?').join(',')})
`).all(...entityPages.map(p => p.subject_name)) as any[];

const entityMap = new Map(entities.map((e: any) => [e.canonical_name, e.id]));

console.log(`Recompiling ${entityPages.length} entity pages...\n`);

for (const page of entityPages) {
  const entityId = entityMap.get(page.subject_name);
  if (!entityId) {
    console.log(`  ✗ ${page.subject_name} — entity not found in DB, skipping`);
    continue;
  }

  console.log(`  Compiling ${page.subject_name}...`);
  try {
    const result = await compileEntityPage(db, page.subject_name, entityId);
    console.log(`  ✓ ${page.subject_name} — ${result.length} chars`);
  } catch (e: any) {
    console.log(`  ✗ ${page.subject_name} — ${e.message?.slice(0, 100)}`);
  }
}

// Export to markdown
console.log('\nExporting to markdown...');
const lint = await lintAndExportWiki(db);
console.log(`Exported ${lint.exportedFiles} files`);

db.close();
console.log('\nDone. Run sync-wiki-to-obsidian.sh to update Obsidian.');
