import Database from 'better-sqlite3';
import { compileEntityPage } from '../src/wiki-agents.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Get Luke Porter's entity ID
const luke = db.prepare(`SELECT id, canonical_name FROM entities WHERE canonical_name = 'Luke Porter'`).get() as any;
if (!luke) { console.log('Luke Porter not found'); process.exit(1); }

console.log(`Recompiling Luke Porter with crawling prompt (${luke.id})...`);
const result = await compileEntityPage(db, luke.canonical_name, luke.id);
console.log(`Done: ${result.length} chars (was 309)\n`);
console.log(result);

db.close();
