import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Check all sources and their last sync date
const sources = db.prepare(
  "SELECT source, MAX(source_date) as last_date, COUNT(*) as total FROM knowledge GROUP BY source ORDER BY last_date DESC"
).all() as any[];

const now = Date.now();
console.log('=== SOURCE HEALTH CHECK ===\n');
for (const s of sources) {
  const age = s.last_date ? Math.round((now - new Date(s.last_date).getTime()) / 3600000) : 999;
  const status = age < 24 ? '✓' : age < 72 ? '⚠' : '✗';
  console.log(`${status} ${(s.source || 'unknown').padEnd(15)} Last: ${(s.last_date || 'never').slice(0, 16).padEnd(18)} Age: ${age}h  Items: ${s.total}`);
}

// Check connector state keys
const connState = db.prepare(
  `SELECT key, value, updated_at FROM graph_state WHERE key LIKE '%sync%' OR key LIKE '%gmail%' OR key LIKE '%connector%' OR key LIKE '%last_dream%' OR key LIKE '%token%'`
).all() as any[];

console.log('\n=== CONNECTOR STATE ===\n');
for (const c of connState) {
  const val = (c.value || '').slice(0, 100);
  console.log(`  ${c.key} = ${val}`);
  if (c.updated_at) console.log(`    updated: ${c.updated_at}`);
}

// Check gmail token / auth
const gmailTokens = db.prepare(
  `SELECT key, substr(value, 1, 50) as val_preview, updated_at FROM graph_state WHERE key LIKE '%gmail%' OR key LIKE '%oauth%' OR key LIKE '%refresh%' OR key LIKE '%token%'`
).all() as any[];

console.log('\n=== AUTH/TOKEN STATE ===\n');
for (const t of gmailTokens) {
  console.log(`  ${t.key} = ${t.val_preview}...  (updated: ${t.updated_at})`);
}

// Check shift daemon last run
const shift = db.prepare(
  `SELECT value, updated_at FROM graph_state WHERE key = 'last_dream_run'`
).get() as any;
console.log('\n=== SHIFT/DREAM STATE ===\n');
console.log(`  Last dream run: ${shift?.value || 'never'} (updated: ${shift?.updated_at})`);

db.close();
