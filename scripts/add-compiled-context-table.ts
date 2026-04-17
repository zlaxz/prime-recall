import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Create compiled_context table — pre-compiled summaries for the intelligence cycle
db.exec(`
  CREATE TABLE IF NOT EXISTS compiled_context (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source_count INTEGER DEFAULT 0,
    compiled_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+4 hours'))
  )
`);

console.log('✓ compiled_context table created');

// Verify
const info = db.pragma('table_info(compiled_context)') as any[];
console.log('Columns:', info.map(c => c.name).join(', '));

db.close();
