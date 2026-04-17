import Database from 'better-sqlite3';
import { compileWikiPages } from '../src/wiki-compiler.js';
import { lintAndExportWiki } from '../src/wiki-lint.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('=== FULL WIKI RECOMPILATION ===\n');
console.log('This will recompile all project + entity pages with fresh data...\n');

try {
  const result = await compileWikiPages(db);
  console.log(`\nCompilation: ${result.compiled} compiled, ${result.skipped} skipped (${(result.durationMs / 1000).toFixed(0)}s)`);
} catch (e: any) {
  console.log('Compilation error:', e.message?.slice(0, 200));
}

// Run lint + export to update Obsidian files
console.log('\nRunning lint + export...');
try {
  const lint = await lintAndExportWiki(db);
  console.log(`Export: ${lint.exportedFiles} files, ${lint.stalePages.length} stale, ${lint.missingPages.length} missing`);
} catch (e: any) {
  console.log('Lint error:', e.message?.slice(0, 200));
}

db.close();
console.log('\nDone. Run sync-wiki-to-obsidian.sh to update Obsidian.');
