import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Build the exact same prompt Quinn agent builds
let focus = '';
try { focus = readFileSync(join(process.env.HOME || '', '.prime', 'FOCUS.md'), 'utf-8'); } catch {}

const corrections = db.prepare(
  "SELECT title FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
).all() as any[];

const prompt = [
  'You are Quinn Parker, AI Chief of Staff to Zach Stock at Recapture Insurance.',
  '',
  'TODAY IS: Wednesday, April 16, 2026',
  '',
  '## YOUR WORKING STATE',
  focus.slice(0, 2000) || '(First cycle)',
  '',
  '## YOUR TASK',
  'Call prime_search with query "Forrest Pullen" and tell me the top 3 results.',
].join('\n');

console.log('Prompt length:', prompt.length, 'chars');

// Call proxy directly with curl (which we know works)
const { execSync } = await import('child_process');
const { writeFileSync, unlinkSync } = await import('fs');
const body = JSON.stringify({ prompt, timeout: 120, args: ['--max-turns', '10'] });
const tmp = '/tmp/quinn-debug.json';
writeFileSync(tmp, body);
console.log('Body length:', body.length, 'bytes');

try {
  const result = execSync(`/usr/bin/curl -s -X POST http://127.0.0.1:3211/claude -H 'Content-Type: application/json' -d @${tmp} --max-time 150`,
    { timeout: 180000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
  console.log('\nProxy response:', result.slice(0, 500));

  const parsed = JSON.parse(result);
  console.log('\nExit code:', parsed.exit_code);
  console.log('Session ID:', parsed.session_id);
  console.log('Result length:', (parsed.result || '').length);
  console.log('Result:', (parsed.result || '').slice(0, 300));
} catch (e: any) {
  console.log('Error:', e.message?.slice(0, 200));
}

unlinkSync(tmp);
db.close();
