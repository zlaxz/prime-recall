/**
 * Fair comparison: Claude (proxy+MCP) vs DeepSeek (tool-calling agent)
 * Both get tool access to search and retrieve.
 */

import Database from 'better-sqlite3';
import { writeFileSync, readFileSync } from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Load .env
try {
  const env = readFileSync(join(process.env.HOME || '', 'GitHub/prime/.env'), 'utf-8');
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

const taskPrompt = [
  `TODAY IS: ${dateStr}`,
  '',
  'You are the PM for Carefront, a senior living liability insurance MGA.',
  'Investigate the current state of the project using your tools.',
  '',
  'RULES:',
  '- Search for recent activity, then RETRIEVE actual emails to verify claims.',
  '- VERIFY OWNERSHIP: check WHO is in email threads before assigning tasks.',
  '- CITE OR DELETE: every claim must trace to a retrieved source.',
  '- Separate VERIFIED from UNVERIFIED.',
  '',
  'Produce a brief status: (1) verified facts, (2) unverified assumptions, (3) top concern, (4) recommended action.',
].join('\n');

// --- CLAUDE via proxy ---
async function runClaude(): Promise<{ result: string; duration: number }> {
  const start = Date.now();
  const body = JSON.stringify({ prompt: taskPrompt, timeout: 300, args: ['--max-turns', '25'] });
  const tmp = '/tmp/compare-fair-claude.json';
  writeFileSync(tmp, body);

  const { stdout } = await execFileAsync('/usr/bin/curl', [
    '-s', '-X', 'POST', 'http://127.0.0.1:3211/claude',
    '-H', 'Content-Type: application/json',
    '-d', `@${tmp}`, '--max-time', '330',
  ], { timeout: 360000, maxBuffer: 10 * 1024 * 1024 });

  const parsed = JSON.parse(stdout);
  return { result: parsed.result || '', duration: (Date.now() - start) / 1000 };
}

// --- DEEPSEEK with tool-calling agent ---
async function runDeepSeek(): Promise<{ result: string; duration: number; turns: number; toolCalls: number }> {
  const start = Date.now();
  const { DeepSeekAgent } = await import('../src/deepseek-agent.js');

  const agent = new DeepSeekAgent(db, {
    model: 'deepseek-chat',
    maxTurns: 25,
    maxTokens: 4000,
    temperature: 0.1,
  });

  const agentResult = await agent.run(taskPrompt);

  return {
    result: agentResult.content,
    duration: (Date.now() - start) / 1000,
    turns: agentResult.turns,
    toolCalls: agentResult.toolCalls,
  };
}

console.log('=== FAIR COMPARISON: Claude vs DeepSeek (both with tools, PARALLEL) ===\n');
console.log('Running both simultaneously...\n');

const [claude, deepseek] = await Promise.all([
  runClaude().then(r => { console.log(`Claude finished: ${r.duration.toFixed(0)}s, ${r.result.length} chars`); return r; }),
  runDeepSeek().then(r => { console.log(`DeepSeek finished: ${r.duration.toFixed(0)}s, ${r.result.length} chars, ${r.toolCalls} tool calls`); return r; }),
]);
console.log('');

console.log('╔══════════════════════════════════════════╗');
console.log('║  CLAUDE (Opus, MCP tools)                ║');
console.log('╚══════════════════════════════════════════╝\n');
console.log(claude.result.slice(0, 4000));

console.log('\n╔══════════════════════════════════════════╗');
console.log('║  DEEPSEEK (tool-calling agent)            ║');
console.log('╚══════════════════════════════════════════╝\n');
console.log(deepseek.result.slice(0, 4000));

console.log('\n=== COMPARISON ===');
console.log(`Claude:   ${claude.duration.toFixed(0)}s | ${claude.result.length} chars`);
console.log(`DeepSeek: ${deepseek.duration.toFixed(0)}s | ${deepseek.result.length} chars`);

db.close();
