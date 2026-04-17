import Database from 'better-sqlite3';
import { runPMAgent } from '../src/pm-agent.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

const projects = [
  { project: 'Carefront', agentId: 'carefront-pm' },
  { project: 'Foresite', agentId: 'foresite-pm' },
];

console.log('=== RUNNING PM AGENTS (Claude via proxy, with tools) ===\n');

for (const pm of projects) {
  console.log(`Running ${pm.agentId}...`);
  try {
    const result = await runPMAgent(db, pm);
    console.log(`  ✓ ${pm.agentId}: ${(result.durationMs / 1000).toFixed(0)}s`);
  } catch (e: any) {
    console.log(`  ✗ ${pm.agentId}: ${e.message?.slice(0, 150)}`);
  }
  console.log('');
}

db.close();
console.log('Done. Check ~/.prime/agents/*/wiki-page.md for results.');
