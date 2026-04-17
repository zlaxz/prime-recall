import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';

// ============================================================
// PM Agent — Opus-powered Project Manager with persistent session
//
// Each PM has:
//   - SOUL.md (identity — who am I, what do I do)
//   - MEMORY.md (curated long-term memory — survives session resets)
//   - CONCERNS.md (watchlist — what am I tracking)
//   - Persistent --resume session (accumulates across cycles)
//   - Wiki page (output — updated each cycle)
//
// The PM uses MCP tools via the proxy to investigate.
// It reads actual emails, searches the KB, checks commitments.
// It then updates its wiki page with PM-level insights.
// ============================================================

const AGENT_DIR = join(homedir(), '.prime', 'agents');

interface PMConfig {
  project: string;          // e.g., 'Carefront', 'Foresite'
  agentId: string;          // e.g., 'carefront-pm', 'foresite-pm'
  maxTurns?: number;        // default 25
  timeoutSec?: number;      // default 600
}

interface PMResult {
  wikiPage: string;
  memoryUpdate: string;
  concernsUpdate: string;
  durationMs: number;
  sessionId: string;
}

function getAgentDir(agentId: string): string {
  const dir = join(AGENT_DIR, agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readFile(path: string): string {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function writeAgentFile(agentId: string, filename: string, content: string) {
  const dir = getAgentDir(agentId);
  writeFileSync(join(dir, filename), content, 'utf-8');
}

// Call the proxy to run Opus with MCP tools.
// MUST use curl — http.request returns early before multi-turn tool calls complete.
async function callProxy(prompt: string, maxTurns: number, timeoutSec: number, sessionId?: string): Promise<{ result: string; sessionId: string }> {
  const { promisify } = await import('util');
  const { execFile } = await import('child_process');
  const execFileAsync = promisify(execFile);

  const args = sessionId
    ? ['--resume', sessionId, '--max-turns', String(maxTurns)]
    : ['--max-turns', String(maxTurns)];

  const body = JSON.stringify({ prompt, timeout: timeoutSec, args });
  const tmpPath = `/tmp/pm-proxy-${Date.now()}.json`;

  try {
    writeFileSync(tmpPath, body);
    const { stdout } = await execFileAsync('/usr/bin/curl', [
      '-s', '-X', 'POST',
      'http://127.0.0.1:3211/claude',
      '-H', 'Content-Type: application/json',
      '-d', `@${tmpPath}`,
      '--max-time', String(timeoutSec + 30),
    ], { timeout: (timeoutSec + 60) * 1000, maxBuffer: 10 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    if (parsed.error) throw new Error(`Proxy error: ${parsed.error}`);
    return { result: parsed.result || '', sessionId: parsed.session_id || '' };
  } finally {
    try { const { unlinkSync } = await import('fs'); unlinkSync(tmpPath); } catch {}
  }
}

export async function runPMAgent(db: Database.Database, config: PMConfig): Promise<PMResult> {
  const start = Date.now();
  const dir = getAgentDir(config.agentId);
  const maxTurns = config.maxTurns || 200; // Claude via proxy — 1M context, let it investigate
  const timeoutSec = config.timeoutSec || 900;

  // Load agent identity and memory
  const soul = readFile(join(dir, 'SOUL.md'));
  const memory = readFile(join(dir, 'MEMORY.md'));
  const concerns = readFile(join(dir, 'CONCERNS.md'));
  const lastWikiPage = readFile(join(dir, 'wiki-page.md'));

  // Get existing session ID for --resume
  const agentState = db.prepare(
    'SELECT session_id FROM agent_state WHERE agent_type = ? AND subject_id = ?'
  ).get('pm', config.project) as any;
  const sessionId = agentState?.session_id || undefined;

  // Build the PM prompt
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const prompt = [
    soul || `You are the PM for ${config.project}.`,
    '',
    `TODAY IS: ${dateStr}`,
    '',
    memory ? `## WHAT I REMEMBER\n${memory}\n` : '',
    concerns ? `## WHAT I'M WATCHING\n${concerns}\n` : '',
    lastWikiPage ? `## MY LAST WIKI PAGE\n${lastWikiPage.slice(0, 3000)}\n` : '',
    '',
    'You have MCP tools. Use them to investigate what\'s new since your last cycle.',
    'Search for recent emails, check commitments, check the calendar.',
    'Read actual source material via prime_retrieve — don\'t rely on summaries.',
    '',
    'CRITICAL RULES FOR ACCURACY:',
    '- VERIFY OWNERSHIP: Before saying "Person X owns task Y," search for emails between X and the relevant party. Check WHO is actually in the email thread. If Zach has been emailing someone directly, that is Zach\'s relationship — do not attribute it to a team member just because they were mentioned nearby.',
    '- CITE OR DELETE: Every factual claim must trace to a specific email you retrieved via prime_retrieve. If you only read a summary or search result, you do NOT have evidence. Either retrieve the source or delete the claim.',
    '- SEPARATE VERIFIED FROM ASSUMED: In your wiki page, mark claims as [VERIFIED: thread:ID] or [UNVERIFIED: inference from summary]. Do not present inferences as facts.',
    '- CHECK YOUR PRIOR ASSUMPTIONS: Your memory from last cycle may be wrong. If you wrote "Forrest is handling X" last cycle, verify it this cycle by checking who is actually emailing about X.',
    '',
    'After investigating AND verifying your claims, produce THREE outputs separated by these exact markers:',
    '',
    '---WIKI_PAGE---',
    '(Your updated wiki page for ' + config.project + ')',
    '',
    '---MEMORY_UPDATE---',
    '(What you learned this cycle that you want to remember next time. Append to existing memory, don\'t replace it. Be concise — key facts, patterns noticed, relationship insights.)',
    '',
    '---CONCERNS_UPDATE---',
    '(What you\'re watching for next cycle. Replace the full list — keep it current.)',
  ].filter(Boolean).join('\n');

  // Call Opus via proxy with --resume
  console.log(`    PM ${config.agentId}: calling Opus${sessionId ? ' (resuming session)' : ' (new session)'}...`);
  const response = await callProxy(prompt, maxTurns, timeoutSec, sessionId);

  // Parse the three outputs
  const content = response.result;
  let wikiPage = content;
  let memoryUpdate = '';
  let concernsUpdate = '';

  const wikiMarker = content.indexOf('---WIKI_PAGE---');
  const memoryMarker = content.indexOf('---MEMORY_UPDATE---');
  const concernsMarker = content.indexOf('---CONCERNS_UPDATE---');

  if (wikiMarker >= 0 && memoryMarker >= 0) {
    wikiPage = content.slice(wikiMarker + '---WIKI_PAGE---'.length, memoryMarker).trim();
  } else if (wikiMarker >= 0) {
    wikiPage = content.slice(wikiMarker + '---WIKI_PAGE---'.length).trim();
  }

  if (memoryMarker >= 0 && concernsMarker >= 0) {
    memoryUpdate = content.slice(memoryMarker + '---MEMORY_UPDATE---'.length, concernsMarker).trim();
  } else if (memoryMarker >= 0) {
    memoryUpdate = content.slice(memoryMarker + '---MEMORY_UPDATE---'.length).trim();
  }

  if (concernsMarker >= 0) {
    concernsUpdate = content.slice(concernsMarker + '---CONCERNS_UPDATE---'.length).trim();
  }

  // Save wiki page
  writeAgentFile(config.agentId, 'wiki-page.md', wikiPage);

  // Append to MEMORY.md (don't replace — accumulate)
  if (memoryUpdate) {
    const existingMemory = readFile(join(dir, 'MEMORY.md'));
    const newMemory = existingMemory
      ? existingMemory + '\n\n## Cycle ' + dateStr + '\n' + memoryUpdate
      : '## Cycle ' + dateStr + '\n' + memoryUpdate;
    writeAgentFile(config.agentId, 'MEMORY.md', newMemory);
  }

  // Replace CONCERNS.md (current watchlist, not historical)
  if (concernsUpdate) {
    writeAgentFile(config.agentId, 'CONCERNS.md', concernsUpdate);
  }

  // Write daily note
  const notesDir = join(dir, 'daily-notes');
  if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
  const dateKey = now.toISOString().slice(0, 10);
  writeFileSync(join(notesDir, dateKey + '.md'), `# ${config.agentId} — ${dateStr}\n\n${content}`, 'utf-8');

  // Store wiki page in compiled_pages
  db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version,
      last_source_date, compiled_at, stale)
    VALUES (?, 'project', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?), 1),
      datetime('now'), datetime('now'), 0)
  `).run(uuid(), config.project, config.project, wikiPage, config.project);

  // Store session ID + update agent_state
  db.prepare(`
    INSERT OR REPLACE INTO agent_state (agent_type, subject_id, soul, memory, concerns, last_wiki_page, session_id, last_run_at)
    VALUES ('pm', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    config.project,
    soul,
    readFile(join(dir, 'MEMORY.md')),
    concernsUpdate || concerns,
    wikiPage.slice(0, 5000),
    response.sessionId || sessionId || '',
  );

  console.log(`    PM ${config.agentId}: done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return {
    wikiPage,
    memoryUpdate,
    concernsUpdate,
    durationMs: Date.now() - start,
    sessionId: response.sessionId || sessionId || '',
  };
}
