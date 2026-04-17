import Database from 'better-sqlite3';
import { runPMAgent } from '../src/pm-agent.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Clear old session to start fresh (accumulated context was too large for proxy)
db.prepare(`UPDATE agent_state SET session_id = NULL WHERE agent_type = 'pm' AND subject_id = 'Carefront'`).run();
console.log('Cleared Carefront PM session\n');

console.log('Running Carefront PM (Opus 4.7, fresh session, 200 turns)...');
try {
  const result = await runPMAgent(db, { project: 'Carefront', agentId: 'carefront-pm' });
  console.log(`✓ ${(result.durationMs / 1000).toFixed(0)}s`);
} catch (e: any) {
  console.log(`✗ ${e.message?.slice(0, 200)}`);
}

db.close();
