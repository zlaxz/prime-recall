import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';

// ============================================================
// PM Agent — Opus-powered Project Manager (fresh session each cycle)
//
// Each PM has:
//   - SOUL.md (identity — who am I, what do I do)
//   - MEMORY.md (curated long-term memory — survives session resets)
//   - CONCERNS.md (watchlist — what am I tracking)
//   - Wiki page (output — updated each cycle)
//
// NO --resume: each cycle is a fresh session. Institutional memory
// is preserved through MEMORY.md, CONCERNS.md, and the last wiki
// page — all loaded into the prompt. This avoids session context
// accumulation that pushes past the proxy body limit (~128KB).
//
// MEMORY.md is capped at 10 most recent cycle entries. Older
// entries are summarized into a single "historical context" block.
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

const MAX_MEMORY_CYCLES = 10;

/**
 * Cap MEMORY.md to the last N cycle entries.
 * Older entries are collapsed into a single "Historical Context" summary.
 * Each cycle entry starts with "## Cycle ".
 */
function capMemory(memoryContent: string): string {
  if (!memoryContent) return memoryContent;

  // Split on cycle headers
  const parts = memoryContent.split(/(?=^## Cycle )/m);
  // Filter out empty parts, but preserve any leading non-cycle content (e.g., historical summary)
  const historicalParts: string[] = [];
  const cycleParts: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('## Cycle ')) {
      cycleParts.push(trimmed);
    } else {
      historicalParts.push(trimmed);
    }
  }

  if (cycleParts.length <= MAX_MEMORY_CYCLES) {
    return memoryContent; // Under cap, no changes needed
  }

  // Keep last N cycles, summarize the rest
  const toSummarize = cycleParts.slice(0, cycleParts.length - MAX_MEMORY_CYCLES);
  const toKeep = cycleParts.slice(cycleParts.length - MAX_MEMORY_CYCLES);

  // Extract key facts from old cycles (take first line of each as a summary bullet)
  const summaryBullets = toSummarize.map(cycle => {
    const lines = cycle.split('\n').filter(l => l.trim());
    const header = lines[0] || '';
    // Take the first substantive line after the header
    const firstFact = lines.slice(1).find(l => l.trim().length > 10) || '';
    const dateMatch = header.match(/## Cycle (.+)/);
    const date = dateMatch ? dateMatch[1] : 'unknown date';
    return `- ${date}: ${firstFact.trim().slice(0, 200)}`;
  });

  const historicalBlock = [
    '## Historical Context (summarized from older cycles)',
    ...summaryBullets,
    '',
  ].join('\n');

  return [...historicalParts, historicalBlock, ...toKeep].join('\n\n');
}

// Call the proxy to run Opus with MCP tools.
// MUST use curl — http.request returns early before multi-turn tool calls complete.
async function callProxy(prompt: string, maxTurns: number, timeoutSec: number): Promise<{ result: string; sessionId: string }> {
  const { promisify } = await import('util');
  const { execFile } = await import('child_process');
  const execFileAsync = promisify(execFile);

  // Always fresh session — no --resume. Persistent memory lives in files, not session context.
  const args = ['--model', 'claude-opus-4-7', '--max-turns', String(maxTurns)];

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
    if (parsed.exit_code !== undefined && parsed.exit_code !== 0) {
      throw new Error(`Proxy exit_code ${parsed.exit_code}: ${String(parsed.result || '').slice(0, 120)}`);
    }
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
  const memoryRaw = readFile(join(dir, 'MEMORY.md'));
  const memory = memoryRaw.length > 40000 ? '(older memory truncated)\n' + memoryRaw.slice(-40000) : memoryRaw;
  const concerns = readFile(join(dir, 'CONCERNS.md'));
  const lastWikiPage = readFile(join(dir, 'wiki-page.md'));

  // Build the PM prompt
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  // Proposals Zach accepted → this cycle's work orders for this monitor
  let acceptedBlock = '';
  try {
    const { ensureLedger } = await import('./ledger.js');
    ensureLedger(db);
    const acc = db.prepare("SELECT item, title, next_action FROM ledger WHERE monitor=? AND tier='propose' AND status='accepted'").all(config.agentId) as any[];
    if (acc.length) {
      acceptedBlock = '## ACCEPTED PROPOSALS — DO THESE THIS CYCLE\n' + acc.map((a: any) => `- [${a.item}] ${a.title}\n  Plan: ${a.next_action || ''}`).join('\n') +
        '\nExecute each within your walls (documents go in your wiki page, drafts in the ledger draft field, research into the wiki). When done, re-emit the item in your LEDGER block with "status":"resolved" and put a one-line summary in MEMORY_UPDATE.';
    }
  } catch {}

  // Existing keys (so updates match) and Zach's decisions (so they aren't re-pitched)
  let keysBlock = '';
  try {
    const existing = db.prepare("SELECT item, tier, status, substr(title,1,70) t FROM ledger WHERE monitor=? AND (status='open' OR updated_at >= datetime('now','-30 days')) ORDER BY status, tier").all(config.agentId) as any[];
    if (existing.length) {
      keysBlock = '## YOUR LEDGER KEYS — reuse these exact item keys; never invent a new key for the same thing\n' +
        existing.map((e: any) => `- ${e.item} [${e.tier}/${e.status}] ${e.t}`).join('\n') +
        '\nItems marked dismissed or declined are Zach\'s decisions: do NOT re-emit them as open and do NOT re-propose them.';
    }
  } catch {}

  const prompt = [
    soul || `You are the PM for ${config.project}.`,
    '',
    `TODAY IS: ${dateStr}`,
    '',
    memory ? `## WHAT I REMEMBER\n${memory}\n` : '',
    concerns ? `## WHAT I'M WATCHING\n${concerns}\n` : '',
    lastWikiPage ? `## MY LAST WIKI PAGE\n${lastWikiPage.slice(0, 3000)}\n` : '',
    acceptedBlock,
    keysBlock,
    '',
    'You have MCP tools. Use them to investigate what\'s new since your last cycle.',
    'Search for recent emails, check commitments, check the calendar.',
    'Read actual source material via prime_retrieve — don\'t rely on summaries.',
    '',
    'CRITICAL RULES FOR ACCURACY:',
    '- VERIFY OWNERSHIP: Before saying "Person X owns task Y," search for emails between X and the relevant party. Check WHO is actually in the email thread. If Zach has been emailing someone directly, that is Zach\'s relationship — do not attribute it to a team member just because they were mentioned nearby.',
    '- CITE OR DELETE: Every factual claim must trace to a specific email you retrieved via prime_retrieve. If you only read a summary or search result, you do NOT have evidence. Either retrieve the source or delete the claim.',
    '- SEPARATE VERIFIED FROM ASSUMED: In your wiki page, mark claims as [VERIFIED: thread:ID] or [UNVERIFIED: inference from summary]. Do not present inferences as facts.',
    '- NO SEND AUTHORITY: You must NEVER call prime_send_email, prime_notify, prime_approve_action, prime_schedule_meeting, or any tool that emails Zach or contacts a third party. Outbound text goes ONLY into the ledger draft field — Zach sends it himself.',
    '- ACT BUDGET: at most 2 act-tier ledger items per cycle. If more qualify, keep the two most costly to delay and tier the rest remind or brief.',
    '- CHECK YOUR PRIOR ASSUMPTIONS: Your memory from last cycle may be wrong. If you wrote "Forrest is handling X" last cycle, verify it this cycle by checking who is actually emailing about X.',
    '',
    'After investigating AND verifying your claims, produce FOUR outputs separated by these exact markers:',
    '',
    '---WIKI_PAGE---',
    '(Your updated wiki page for ' + config.project + ')',
    '',
    '---MEMORY_UPDATE---',
    '(What you learned this cycle that you want to remember next time. Append to existing memory, don\'t replace it. Be concise — key facts, patterns noticed, relationship insights.)',
    '',
    '---CONCERNS_UPDATE---',
    '(What you\'re watching for next cycle. Replace the full list — keep it current.)',
    '',
    '---LEDGER---',
    '(JSON array of ball-in-play items for your domain — the structured version of your wiki. Each: {"item":"stable-key-that-matches-prior-cycles","title":"short human line","counterparty":"who","state":"where it stands","ball":"zach|other","ball_since":"YYYY-MM-DD","deadline":"YYYY-MM-DD or null","next_action":"one concrete step","draft":"ready-to-send text or null","tier":"act|remind|brief|wiki","status":"open|resolved"}.',
    'TIER RULES — tier "act" ONLY when ALL THREE hold: a finished draft is attached, delay costs something real (deadline/stall/money/legal), and only Zach can do it. Deadline-shaped with no decision → "remind". Awareness only → "brief". Something YOU watch → "wiki". Overuse of "act" makes every alert meaningless.',
    'ATTACHMENTS: search results with source attachment-index are document CARDS (dec pages, signed agreements, loss runs, filings). When a task turns on what a document actually says, call prime_read_attachment with the card\'s message_id and filename to read it live. Cite documents you read as [VERIFIED: attachment:message_id:filename].',
    'PROPOSALS RULE: you may include at most ONE ledger item per cycle with "tier":"propose" — an OFFER of something you COULD do for Zach beyond your current instructions: a document (claim chronology, renewal package, comparison sheet), a research task, a new watch item, a draft he did not ask for. Title it as an offer ("I could build…"), put the concrete plan in next_action, ball "agent", no deadline. Never propose sending anything to a third party. Do not re-propose something already declined.',
    'RESOURCES RULE: every act/remind item should include "links": [{"label":"...","url":"..."}] — up to 4. Convert the thread ids you cite into Gmail deep links: https://mail.google.com/mail/u/0/#all/THREAD_ID (drop the "thread:" prefix). CRITICALLY: hunt for the artifact that would COMPLETE the task (the policy document, the filing portal, the attachment) — link the email that carries it, a Drive URL if one appears in the record, or the official portal URL if one is cited in the sources. If the completing artifact does NOT exist in the record after searching, say so explicitly in next_action ("searched: no renewed dec page exists in email history") — a verified absence is decisive information.',
    'EVIDENCE GATE: an act-tier item MUST carry at least one link (Gmail deep link to the source thread, portal, or Drive) or it will be downgraded automatically — Zach never gets an action email without evidence.',
    'CLOSURE BY OBSERVATION: before emitting an item, search Zach\'s sent mail (source gmail-sent) — if he already took the recommended action, set status "resolved". Keep item keys stable so updates match.)',
    '',
    '---DELIVERABLE---',
    '(OPTIONAL, repeatable. When you complete an ACCEPTED PROPOSAL or produce any finished document — a claim chronology, tender packet, renewal package, comparison — emit it here so it lands in Zach\'s hands as a file, not buried in your wiki. First line: item: <the ledger item key it fulfills>. Second line: filename: <short-slug>.md. Then the full markdown document. Keep the fulfilled ledger item in your LEDGER block with status "resolved".)',
  ].filter(Boolean).join('\n');

  // Call Opus via proxy — fresh session each cycle
  console.log(`    PM ${config.agentId}: calling Opus (fresh session)...`);
  const response = await callProxy(prompt, maxTurns, timeoutSec);

  // Parse the three outputs
  const content = response.result;
  let wikiPage = content;
  let memoryUpdate = '';
  let concernsUpdate = '';

  const wikiMarker = content.indexOf('---WIKI_PAGE---');
  const memoryMarker = content.indexOf('---MEMORY_UPDATE---');
  const concernsMarker = content.indexOf('---CONCERNS_UPDATE---');
  const ledgerMarkerPos = content.indexOf('---LEDGER---');
  // A missing middle marker must not let a slice swallow later blocks
  // (MEMORY.md was ingesting the raw LEDGER JSON when CONCERNS was absent).
  const nextMarkerAfter = (pos: number): number | undefined => {
    const later = [memoryMarker, concernsMarker, ledgerMarkerPos, content.indexOf('---DELIVERABLE---')].filter(m => m > pos);
    return later.length ? Math.min(...later) : undefined;
  };

  if (wikiMarker >= 0) {
    wikiPage = content.slice(wikiMarker + '---WIKI_PAGE---'.length, nextMarkerAfter(wikiMarker)).trim();
  }
  if (memoryMarker >= 0) {
    memoryUpdate = content.slice(memoryMarker + '---MEMORY_UPDATE---'.length, nextMarkerAfter(memoryMarker)).trim();
  }

  const ledgerMarker = ledgerMarkerPos;
  if (concernsMarker >= 0) {
    const cEnds = [ledgerMarker, content.indexOf('---DELIVERABLE---')].filter(m => m > concernsMarker);
    concernsUpdate = content.slice(concernsMarker + '---CONCERNS_UPDATE---'.length, cEnds.length ? Math.min(...cEnds) : undefined).trim();
  }

  // Parse + store ledger rows (structured ball-tracking behind the wiki)
  if (ledgerMarker >= 0) {
    try {
      const delivMarker = content.indexOf('---DELIVERABLE---');
      let raw = content.slice(ledgerMarker + '---LEDGER---'.length, delivMarker > ledgerMarker ? delivMarker : undefined).trim();
      raw = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
      if (start >= 0 && end > start) {
        const rows = JSON.parse(raw.slice(start, end + 1));
        const { upsertLedgerRows } = await import('./ledger.js');
        const n = upsertLedgerRows(db, config.agentId, rows);
        console.log(`    PM ${config.agentId}: ${n} ledger rows upserted`);
      }
    } catch (e: any) {
      console.log(`    PM ${config.agentId}: ledger parse failed — ${(e.message || '').slice(0, 80)}`);
    }
  }

  // Deliverables → files Zach can open (synced to ~/Documents/Claude/Prime/deliverables/)
  try {
    const blocks = content.split('---DELIVERABLE---').slice(1);
    if (blocks.length) {
      const outDir = join(homedir(), '.prime', 'export', 'deliverables', config.agentId);
      mkdirSync(outDir, { recursive: true });
      const { ensureLedger } = await import('./ledger.js');
      ensureLedger(db);
      for (const b of blocks) {
        const lines = b.trim().split('\n');
        const itemLine = lines.find(l => /^item:/i.test(l)) || '';
        const fileLine = lines.find(l => /^filename:/i.test(l)) || '';
        const itemKey = itemLine.replace(/^item:\s*/i, '').trim();
        let fname = fileLine.replace(/^filename:\s*/i, '').trim().replace(/[^\w.-]/g, '_') || `deliverable-${Date.now()}.md`;
        if (!/\.md$/i.test(fname)) fname += '.md';
        const bodyStart = lines.findIndex(l => !/^(item|filename):/i.test(l) && l.trim() !== '');
        const doc = lines.slice(Math.max(bodyStart, 0)).join('\n').trim();
        if (doc.length < 200) { console.log(`    PM ${config.agentId}: deliverable "${fname}" too short (${doc.length} chars) — not saved`); continue; }
        if (itemKey) fname = `${itemKey.replace(/[^\w.-]/g, '_').slice(0, 40)}--${fname}`;  // no cross-item overwrites
        const fp = join(outDir, fname);
        writeFileSync(fp, `<!-- ${config.agentId} · ${dateStr} · fulfills: ${itemKey || 'n/a'} -->\n\n${doc}`, 'utf-8');
        if (itemKey) db.prepare("UPDATE ledger SET deliverable=? WHERE monitor=? AND item=?").run(`deliverables/${config.agentId}/${fname}`, config.agentId, itemKey);
        console.log(`    PM ${config.agentId}: deliverable saved — ${fname}`);
      }
    }
  } catch (e: any) {
    console.log(`    PM ${config.agentId}: deliverable parse failed — ${(e.message || '').slice(0, 80)}`);
  }

  // Save wiki page — only when markers parsed and content is substantive.
  // An unmarked or tiny response means the run failed; keep the old page.
  const wikiValid = wikiMarker >= 0 && wikiPage.length >= 200;
  if (wikiValid) {
    writeAgentFile(config.agentId, 'wiki-page.md', wikiPage);
  } else {
    console.log(`    PM ${config.agentId}: wiki output invalid (marker=${wikiMarker >= 0}, len=${wikiPage.length}) — keeping previous page`);
  }

  // Append to MEMORY.md (don't replace — accumulate, but cap at MAX_MEMORY_CYCLES)
  if (memoryUpdate) {
    const existingMemory = readFile(join(dir, 'MEMORY.md'));
    const appended = existingMemory
      ? existingMemory + '\n\n## Cycle ' + dateStr + '\n' + memoryUpdate
      : '## Cycle ' + dateStr + '\n' + memoryUpdate;
    const capped = capMemory(appended);
    writeAgentFile(config.agentId, 'MEMORY.md', capped);
  }

  // Replace CONCERNS.md (current watchlist, not historical)
  if (concernsUpdate) {
    writeAgentFile(config.agentId, 'CONCERNS.md', concernsUpdate);
  }

  // Write daily note
  const notesDir = join(dir, 'daily-notes');
  if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
  const dateKey = now.toISOString().slice(0, 10);
  writeFileSync(join(notesDir, dateKey + '.md'), `\n\n# ${config.agentId} — ${dateStr} — run ${now.toISOString().slice(11, 16)}\n\n${content}`, { encoding: 'utf-8', flag: 'a' });

  // Store wiki page in compiled_pages
  if (wikiValid) db.prepare(`
    INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version,
      last_source_date, compiled_at, stale)
    VALUES (?, 'project', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?), 1),
      datetime('now'), datetime('now'), 0)
  `).run(uuid(), config.project, config.project, wikiPage, config.project);

  // Update agent_state (no session_id — each cycle is fresh)
  db.prepare(`
    INSERT OR REPLACE INTO agent_state (agent_type, subject_id, soul, memory, concerns, last_wiki_page, session_id, last_run_at)
    VALUES ('pm', ?, ?, ?, ?, ?, '', datetime('now'))
  `).run(
    config.project,
    soul,
    readFile(join(dir, 'MEMORY.md')),
    concernsUpdate || concerns,
    wikiPage.slice(0, 5000),
  );

  console.log(`    PM ${config.agentId}: done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return {
    wikiPage,
    memoryUpdate,
    concernsUpdate,
    durationMs: Date.now() - start,
    sessionId: '', // Fresh session each cycle — no persistence
  };
}
