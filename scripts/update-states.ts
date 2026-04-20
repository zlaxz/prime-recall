/**
 * Auto-age commitments: active with past due_date → overdue, old overdue → dropped.
 * SQL only, no LLM calls. Safe to run anytime.
 */
import Database from 'better-sqlite3';

const db = new Database('/Users/zachstock/.prime/prime.db');
db.pragma('journal_mode = WAL');

const before = db.prepare("SELECT state, COUNT(*) as cnt FROM commitments GROUP BY state").all();
console.log('Before:');
console.table(before);

// Active or detected items with due_date in past → overdue
const toOverdue = db.prepare(`
  UPDATE commitments
  SET state = 'overdue', state_changed_at = datetime('now'), updated_at = datetime('now')
  WHERE state IN ('active', 'detected', 'pending')
    AND due_date IS NOT NULL
    AND due_date < datetime('now')
`).run();
console.log(`\n  ${toOverdue.changes} items: active/detected/pending → overdue (past due date)`);

// Overdue items 30+ days past due date → dropped (stale, probably abandoned)
const toDropped = db.prepare(`
  UPDATE commitments
  SET state = 'dropped',
      state_changed_at = datetime('now'),
      fulfilled_evidence = 'Auto-dropped: overdue 30+ days, likely stale',
      updated_at = datetime('now')
  WHERE state = 'overdue'
    AND due_date IS NOT NULL
    AND due_date < datetime('now', '-30 days')
`).run();
console.log(`  ${toDropped.changes} items: overdue >30 days → dropped (stale)`);

// Detected items older than 60 days with no due date → dropped (probably noise)
const toDroppedOld = db.prepare(`
  UPDATE commitments
  SET state = 'dropped',
      state_changed_at = datetime('now'),
      fulfilled_evidence = 'Auto-dropped: 60+ days old, no deadline, no action',
      updated_at = datetime('now')
  WHERE state = 'detected'
    AND due_date IS NULL
    AND created_at < datetime('now', '-60 days')
`).run();
console.log(`  ${toDroppedOld.changes} items: detected >60d old, no deadline → dropped`);

const after = db.prepare("SELECT state, COUNT(*) as cnt FROM commitments GROUP BY state").all();
console.log('\nAfter:');
console.table(after);

db.close();
