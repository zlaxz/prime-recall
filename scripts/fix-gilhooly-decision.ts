import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Delete all the derivative artifacts from the mistaken "Forrest can handle all three" response
const refs = [
  'mcp:1776271971856',
  'notification:1776272046754',
  'agent-report:1776272036699',
  'task:f38c25b6-bce3-47b6-91f1-3191582cefbb',
  'prime-question:a8ec304c-294f-46b5-93f8-542e4e2b54c5',
];

console.log('Removing mistaken Gilhooly ownership entries...\n');
for (const ref of refs) {
  const result = db.prepare(`DELETE FROM knowledge WHERE source_ref = ?`).run(ref);
  console.log(`  ${ref}: ${result.changes > 0 ? 'deleted' : 'not found'}`);
}

// Add a correction
const { v4: uuid } = await import('uuid');
db.prepare(`
  INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, tags, importance, provenance)
  VALUES (?, ?, ?, 'correction', ?, datetime('now'), '["correction","gilhooly","gallagher"]', 'high', 'primary')
`).run(
  uuid(),
  'CORRECTION: Zach handles Gallagher/Gilhooly directly — not Forrest',
  'Zach Stock is the direct relationship holder with Dan Gilhooly at Arthur J. Gallagher. Forrest may assist with logistics (packaging documents) but the Gallagher partnership, contract negotiation, and deliverables are Zach\'s responsibility. A prior system entry incorrectly attributed full ownership of 3 Gilhooly deliverables to Forrest based on a misinterpreted casual response. The countersigned Gallagher contract in particular is a legal document in Zach\'s domain.',
  'correction:gilhooly-ownership-' + Date.now(),
);
console.log('\n✓ Correction added: Zach handles Gallagher/Gilhooly directly');

db.close();
