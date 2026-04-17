/**
 * Compare DeepSeek vs Claude (Opus via proxy) on Carefront PM task.
 * Same prompt, same tools, different models. Compare output quality.
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);
const db = new Database(process.env.HOME + '/.prime/prime.db');
const homedir = process.env.HOME || '';

// Load .env
try {
  const env = readFileSync(join(homedir, 'GitHub/prime/.env'), 'utf-8');
  for (const line of env.split('\n')) {
    if (line.includes('=') && !line.startsWith('#')) {
      const [k, ...v] = line.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const now = new Date();
const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

const prompt = [
  'You are the PM for Carefront.',
  '',
  `TODAY IS: ${dateStr}`,
  '',
  'You have MCP tools. Use them to investigate the current state of the Carefront project.',
  'Search for recent emails, check commitments, check the calendar.',
  'Read actual source material via prime_retrieve — don\'t rely on summaries.',
  '',
  'CRITICAL RULES FOR ACCURACY:',
  '- VERIFY OWNERSHIP: Before saying "Person X owns task Y," search for emails between X and the relevant party.',
  '- CITE OR DELETE: Every factual claim must trace to a specific email you retrieved.',
  '- SEPARATE VERIFIED FROM ASSUMED.',
  '',
  'Produce a brief project status update. Include:',
  '1. Current status (what actually happened in the last 48 hours, VERIFIED)',
  '2. What you think but haven\'t verified',
  '3. Top concern',
  '4. Recommended action',
].join('\n');

// --- CLAUDE (via proxy) ---
async function runClaude(): Promise<{ result: string; duration: number }> {
  const start = Date.now();
  const body = JSON.stringify({ prompt, timeout: 300, args: ['--max-turns', '25'] });
  const tmp = '/tmp/compare-claude.json';
  writeFileSync(tmp, body);

  const { stdout } = await execFileAsync('/usr/bin/curl', [
    '-s', '-X', 'POST', 'http://127.0.0.1:3211/claude',
    '-H', 'Content-Type: application/json',
    '-d', `@${tmp}`,
    '--max-time', '330',
  ], { timeout: 360000, maxBuffer: 10 * 1024 * 1024 });

  const parsed = JSON.parse(stdout);
  return { result: parsed.result || '', duration: (Date.now() - start) / 1000 };
}

// --- DEEPSEEK (via API) ---
async function runDeepSeek(): Promise<{ result: string; duration: number }> {
  const start = Date.now();
  const { getBulkProvider } = await import('../src/ai/providers.js');
  const provider = await getBulkProvider();

  // DeepSeek doesn't have MCP tools — give it the search results directly
  // First, get context via DB queries
  const recentItems = db.prepare(`
    SELECT title, summary, source_date, contacts FROM knowledge
    WHERE (project = 'Carefront' OR project = 'carefront' OR tags LIKE '%carefront%')
    AND source_date >= datetime('now', '-7 days')
    ORDER BY source_date DESC LIMIT 20
  `).all() as any[];

  const commitments = db.prepare(`
    SELECT text, state, owner, due_date FROM commitments
    WHERE project LIKE '%carefront%' OR project LIKE '%Carefront%'
    ORDER BY due_date ASC LIMIT 10
  `).all() as any[];

  const context = [
    prompt,
    '',
    '## RECENT ITEMS (last 7 days):',
    ...recentItems.map((i: any) => `[${i.source_date?.slice(0,10)}] ${i.title}: ${i.summary?.slice(0, 200)}`),
    '',
    '## COMMITMENTS:',
    ...commitments.map((c: any) => `[${c.state}] ${c.text} — ${c.owner || 'no owner'} (due: ${c.due_date || 'none'})`),
  ].join('\n');

  const response = await provider.chat(
    [
      { role: 'system', content: 'You are a project manager. Produce a brief, accurate status update.' },
      { role: 'user', content: context.slice(0, 30000) },
    ],
    { temperature: 0.1, max_tokens: 3000 }
  );

  return { result: response, duration: (Date.now() - start) / 1000 };
}

// Run both
console.log('=== COMPARING PM MODELS ON CAREFRONT ===\n');

console.log('Running Claude (Opus via proxy with MCP tools)...');
const claude = await runClaude();
console.log(`Claude: ${claude.duration.toFixed(0)}s, ${claude.result.length} chars\n`);

console.log('Running DeepSeek (API, no tools, pre-loaded context)...');
const deepseek = await runDeepSeek();
console.log(`DeepSeek: ${deepseek.duration.toFixed(0)}s, ${deepseek.result.length} chars\n`);

console.log('╔══════════════════════════════════════════╗');
console.log('║  CLAUDE (Opus, MCP tools, 25 turns)      ║');
console.log('╚══════════════════════════════════════════╝\n');
console.log(claude.result.slice(0, 3000));

console.log('\n╔══════════════════════════════════════════╗');
console.log('║  DEEPSEEK (API, pre-loaded context)       ║');
console.log('╚══════════════════════════════════════════╝\n');
console.log(deepseek.result.slice(0, 3000));

console.log('\n=== COMPARISON ===');
console.log(`Claude:   ${claude.duration.toFixed(0)}s | ${claude.result.length} chars | MCP tools used`);
console.log(`DeepSeek: ${deepseek.duration.toFixed(0)}s | ${deepseek.result.length} chars | pre-loaded context`);

// Save full outputs
writeFileSync('/tmp/compare-claude-output.md', claude.result);
writeFileSync('/tmp/compare-deepseek-output.md', deepseek.result);
console.log('\nFull outputs saved to /tmp/compare-*.md');

db.close();
