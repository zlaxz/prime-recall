import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const db = new Database(process.env.HOME + '/.prime/prime.db');

let focus = '';
try { focus = readFileSync(join(process.env.HOME || '', '.prime', 'FOCUS.md'), 'utf-8'); } catch {}

const prompt = [
  'You are Quinn Parker, AI Chief of Staff.',
  'Call prime_search with query "Forrest Pullen" and tell me the top 3 results.',
].join('\n');

console.log('Testing runClaude directly with maxTurns=10...');

const { runClaude } = await import('../src/utils/claude-spawn.js');

try {
  const result = await runClaude(prompt, {
    maxTurns: 10,
    timeout: 120000,
  });
  console.log('Response length:', result.length);
  console.log('Response:', result.slice(0, 500));
} catch (e: any) {
  console.log('Error:', e.message?.slice(0, 300));
}

db.close();
