import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Check prime_questions table
const schema = db.pragma('table_info(prime_questions)') as any[];
console.log('prime_questions columns:', schema.map(c => c.name).join(', '));

const questions = db.prepare(`SELECT * FROM prime_questions ORDER BY created_at DESC`).all() as any[];
console.log(`\n=== ${questions.length} QUESTIONS IN prime_questions ===\n`);
for (const q of questions) {
  console.log(`[${q.status || 'no-status'}] ${q.created_at?.slice(0, 10)} "${(q.question || q.text || JSON.stringify(q)).slice(0, 100)}"`);
}

// Check pending_questions in graph_state
const pending = db.prepare(`SELECT value FROM graph_state WHERE key = 'pending_questions'`).get() as any;
if (pending) {
  const pqs = JSON.parse(pending.value);
  console.log(`\n=== ${Array.isArray(pqs) ? pqs.length : 'N/A'} PENDING QUESTIONS (graph_state) ===\n`);
  if (Array.isArray(pqs)) {
    for (const q of pqs) {
      console.log(`- ${(q.question || q.text || JSON.stringify(q)).slice(0, 120)}`);
    }
  } else {
    console.log(JSON.stringify(pqs, null, 2).slice(0, 2000));
  }
}

// Look for duplicates
console.log('\n=== DUPLICATE CHECK ===\n');
if (Array.isArray(JSON.parse(pending?.value || '[]'))) {
  const pqs = JSON.parse(pending.value);
  const texts = pqs.map((q: any) => (q.question || q.text || '').toLowerCase().trim());
  const seen = new Map<string, number>();
  for (const t of texts) {
    // Normalize — first 50 chars as key
    const key = t.slice(0, 50);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([_, c]) => c > 1);
  if (dupes.length > 0) {
    console.log(`${dupes.length} duplicate question patterns:`);
    for (const [text, count] of dupes) {
      console.log(`  ${count}x: "${text}..."`);
    }
  } else {
    console.log('No exact duplicates found. Checking semantic similarity...');
    // Group by first 3 words
    const byPrefix = new Map<string, string[]>();
    for (const t of texts) {
      const prefix = t.split(/\s+/).slice(0, 4).join(' ');
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix)!.push(t);
    }
    const similar = [...byPrefix.entries()].filter(([_, qs]) => qs.length > 1);
    if (similar.length > 0) {
      console.log(`${similar.length} similar question groups:`);
      for (const [prefix, qs] of similar) {
        console.log(`  "${prefix}..." (${qs.length} variants)`);
        for (const q of qs) console.log(`    - ${q.slice(0, 80)}`);
      }
    }
  }
}

db.close();
