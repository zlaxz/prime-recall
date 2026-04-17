import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const yesterday = JSON.stringify('2026-04-15T00:00:00Z');
db.prepare(`UPDATE graph_state SET value = ? WHERE key = 'last_full_cycle'`).run(yesterday);
db.prepare(`UPDATE graph_state SET value = ? WHERE key = 'last_dream_run'`).run(yesterday);
db.prepare(`UPDATE graph_state SET value = ? WHERE key = 'last_dream_completed'`).run(yesterday);

console.log('Dream pipeline gates reset to yesterday — next shift tick will trigger full cycle');
db.close();
