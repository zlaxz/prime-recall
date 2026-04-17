import Database from 'better-sqlite3';
import { compileEntityPage } from '../src/wiki-agents.js';
import { lintAndExportWiki } from '../src/wiki-lint.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Get top entities by mention count — these are the ones that matter
const topEntities = db.prepare(`
  SELECT e.id, e.canonical_name, COUNT(em.id) as mentions
  FROM entities e
  JOIN entity_mentions em ON e.id = em.entity_id
  WHERE e.user_dismissed = 0
    AND e.canonical_name NOT IN ('Zach Stock', 'Recapture Insurance Services')
  GROUP BY e.id
  HAVING mentions >= 20
  ORDER BY mentions DESC
  LIMIT 15
`).all() as any[];

console.log(`Compiling ${topEntities.length} top entity pages from clean slate...\n`);

for (const e of topEntities) {
  console.log(`  ${e.canonical_name} (${e.mentions} mentions)...`);
  try {
    const result = await compileEntityPage(db, e.canonical_name, e.id);
    console.log(`    ✓ ${result.length} chars`);
  } catch (err: any) {
    console.log(`    ✗ ${err.message?.slice(0, 80)}`);
  }
}

console.log('\nExporting to markdown...');
const lint = await lintAndExportWiki(db);
console.log(`Exported ${lint.exportedFiles} files`);

db.close();
