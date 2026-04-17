import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Find the questions table
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%question%'`).all() as any[];
console.log('Question-related tables:', tables.map(t => t.name));

// Check graph_state for question data
const qState = db.prepare(`SELECT key, length(value) as len, updated_at FROM graph_state WHERE key LIKE '%question%'`).all() as any[];
console.log('\nQuestion-related graph_state keys:');
for (const q of qState) console.log(`  ${q.key} (${q.len} chars, updated: ${q.updated_at})`);

// Check if questions are in the intelligence brief
const brief = db.prepare(`SELECT value FROM graph_state WHERE key = 'intelligence_brief'`).get() as any;
if (brief) {
  const b = JSON.parse(brief.value);
  if (b.questions) {
    console.log(`\nQuestions in brief: ${b.questions.length}`);
    for (const q of b.questions) console.log(`  - ${JSON.stringify(q).slice(0, 100)}`);
  }
}

// Check prime_questions MCP tool — find where questions come from
const pendingActions = db.prepare(`SELECT id, title, action_type, status FROM action_inbox WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10`).all() as any[];
console.log('\nPending actions:', pendingActions.length);
for (const a of pendingActions) console.log(`  [${a.action_type || 'no-type'}] ${(a.title || '').slice(0, 60)}`);

// Check for the strategic_questions table or similar
const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
const questionTables = allTables.filter((t: any) => t.name.includes('question') || t.name.includes('pending') || t.name.includes('ask'));
console.log('\nAll potentially question-related tables:', questionTables.map((t: any) => t.name));

// Check knowledge items that ARE questions
const questionItems = db.prepare(`SELECT id, title, source, source_date FROM knowledge WHERE source = 'question' OR tags LIKE '%question%' ORDER BY source_date DESC LIMIT 10`).all() as any[];
console.log('\nQuestion knowledge items:', questionItems.length);
for (const q of questionItems) console.log(`  ${q.source_date?.slice(0,10)} [${q.source}] ${(q.title || '').slice(0, 60)}`);

db.close();
