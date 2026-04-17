import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Clear PM agent wiki state so they don't reference old pages
const pmCleared = db.prepare(`UPDATE agent_state SET last_wiki_page = NULL WHERE agent_type = 'pm'`).run();
console.log(`PM wiki state cleared: ${pmCleared.changes}`);

const wikiCleared = db.prepare(`UPDATE agent_state SET last_wiki_page = NULL, memory = NULL WHERE agent_type IN ('wiki_project', 'wiki_entity')`).run();
console.log(`Wiki agent state cleared: ${wikiCleared.changes}`);

// Verify compiled_pages is empty
const remaining = (db.prepare(`SELECT COUNT(*) as c FROM compiled_pages`).get() as any).c;
console.log(`Compiled pages remaining: ${remaining}`);

db.close();
