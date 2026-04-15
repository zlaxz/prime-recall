import Database from 'better-sqlite3';
import { runIntelligenceCycleV2 } from '../src/intelligence-cycle-v2.js';

async function main() {
  const db = new Database(process.env.HOME + '/.prime/prime.db');
  console.log('Running intelligence cycle v2 with cleaned data...');
  const result = await runIntelligenceCycleV2(db);
  console.log(JSON.stringify(result, null, 2));
  db.close();
}
main();
