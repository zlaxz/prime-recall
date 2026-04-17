import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Find the decision log entry
const decision = db.prepare(`
  SELECT title, summary, raw_content, source, source_ref, source_date, metadata
  FROM knowledge
  WHERE source_ref = 'mcp:1776271971856'
`).get() as any;

if (decision) {
  console.log('=== DECISION LOG ENTRY ===\n');
  console.log('Title:', decision.title);
  console.log('Date:', decision.source_date);
  console.log('Source:', decision.source);
  console.log('Ref:', decision.source_ref);
  console.log('\nSummary:', decision.summary);
  console.log('\nRaw content:', decision.raw_content || '(none)');
  console.log('\nMetadata:', decision.metadata);
} else {
  console.log('Entry not found. Searching for Gilhooly decision...');
}

// Also search for the question that prompted this answer
const questions = db.prepare(`
  SELECT question, answer, created_at, answered_at, status
  FROM prime_questions
  WHERE question LIKE '%Gilhooly%' OR question LIKE '%deliverable%' OR answer LIKE '%Forrest can handle%'
  ORDER BY created_at DESC LIMIT 5
`).all() as any[];

console.log('\n=== RELATED QUESTIONS ===\n');
for (const q of questions) {
  console.log(`[${q.status}] ${q.created_at?.slice(0,10)}`);
  console.log(`  Q: ${q.question?.slice(0, 150)}`);
  console.log(`  A: ${q.answer?.slice(0, 150)}`);
  console.log('');
}

// Search for the actual user-feedback that contains "Forrest can handle"
const feedback = db.prepare(`
  SELECT title, summary, source_date, source_ref
  FROM knowledge
  WHERE summary LIKE '%Forrest can handle%' OR title LIKE '%Forrest%Gilhooly%'
  ORDER BY source_date DESC LIMIT 5
`).all() as any[];

console.log('=== USER FEEDBACK WITH "Forrest can handle" ===\n');
for (const f of feedback) {
  console.log(`${f.source_date?.slice(0,10)} [${f.source_ref}] ${f.title?.slice(0,80)}`);
  console.log(`  ${f.summary?.slice(0, 200)}`);
  console.log('');
}

db.close();
