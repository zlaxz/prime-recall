import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('=== QUESTION CLEANUP ===\n');

// Count before
const before = (db.prepare(`SELECT COUNT(*) as c FROM prime_questions WHERE status = 'pending'`).get() as any).c;
console.log(`Pending questions before: ${before}`);

// 1. Expire all questions older than 3 days
const expired = db.prepare(`
  UPDATE prime_questions SET status = 'expired'
  WHERE status = 'pending' AND created_at < datetime('now', '-3 days')
`).run();
console.log(`Expired (>3 days old): ${expired.changes}`);

// 2. Delete meta-questions (Quinn complaining about the queue)
const metaDeleted = db.prepare(`
  DELETE FROM prime_questions
  WHERE question LIKE '%pending question%' OR question LIKE '%accumulated%questions%'
    OR question LIKE '%question-and-answer model%' OR question LIKE '%question queue%'
`).run();
console.log(`Deleted meta-questions: ${metaDeleted.changes}`);

// 3. Deduplicate remaining pending — keep newest, expire older variants
const pending = db.prepare(`SELECT id, question, created_at FROM prime_questions WHERE status = 'pending' ORDER BY created_at DESC`).all() as any[];
const seen = new Map<string, string>(); // normalized prefix → kept id
let deduped = 0;
for (const q of pending) {
  // Normalize: first 40 chars lowercased
  const key = (q.question || '').toLowerCase().slice(0, 40).replace(/[^a-z0-9 ]/g, '');
  if (seen.has(key)) {
    db.prepare(`UPDATE prime_questions SET status = 'expired' WHERE id = ?`).run(q.id);
    deduped++;
  } else {
    seen.set(key, q.id);
  }
}
console.log(`Deduped (same prefix): ${deduped}`);

// 4. Update graph_state pending_questions to only show the remaining
const remaining = db.prepare(`SELECT * FROM prime_questions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`).all() as any[];
db.prepare(`INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('pending_questions', ?, datetime('now'))`)
  .run(JSON.stringify(remaining));
console.log(`\nRemaining pending: ${remaining.length}`);

// Show what's left
console.log('\n=== SURVIVING QUESTIONS ===\n');
for (const q of remaining) {
  console.log(`[${q.priority || 'normal'}] ${q.created_at?.slice(0, 10)} "${(q.question || '').slice(0, 80)}"`);
}

const after = (db.prepare(`SELECT COUNT(*) as c FROM prime_questions WHERE status = 'pending'`).get() as any).c;
console.log(`\nBefore: ${before} pending → After: ${after} pending`);

db.close();
