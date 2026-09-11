// Prime surfaces over MCP — resources + prompts + an activity tool.
//
// Tools let a chat ASK Prime. Resources let Prime PUBLISH live documents that
// Desktop shows in its attachment menu; prompts add Prime's own commands to
// every chat. Same connector, no files, no syncs — the connection itself
// becomes the window into the brain. Pull only: nothing here interrupts Zach.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../db.js';
import { exportCommandCenter } from '../export-command-center.js';

function fresh(file: 'TODAY.md' | 'LEDGER.md'): string {
  const db = getDb();
  // live, in-memory; only the shift daemon writes files (audit H2: two writers raced)
  try {
    const out = exportCommandCenter(db, { write: false });
    return file === 'TODAY.md' ? out.today : out.ledger;
  } catch (e: any) {
    console.error('[mcp-surfaces] export failed: ' + (e?.message || e));
    try { return readFileSync(join(homedir(), '.prime', 'export', file), 'utf-8') + '\n\n_(served from the last hourly file — live export failed)_'; }
    catch { return `(${file} not available — export failed: ${(e?.message || '').slice(0, 120)})`; }
  }
}

export function buildActivity(hours = 24): string {
  const db = getDb();
  const since = `-${hours} hours`;
  const lines: string[] = [`# What Prime did in the last ${hours}h`, ''];
  const runs = db.prepare(
    "SELECT subject_id, last_run_at FROM agent_state WHERE agent_type='pm' AND last_run_at >= datetime('now', ?) ORDER BY last_run_at DESC"
  ).all(since) as any[];
  lines.push(`## Monitors that ran (${runs.length})`);
  lines.push(...(runs.length ? runs.map(r => `- ${r.subject_id} — ${r.last_run_at} UTC`) : ['- none in window']));
  const quinn = db.prepare("SELECT value, updated_at FROM graph_state WHERE key='last_quinn_email'").get() as any;
  lines.push('', `## Quinn`, `- last morning brief sent: ${quinn?.updated_at || 'unknown'} UTC`);
  const ledgerMoves = db.prepare(
    "SELECT monitor, title, tier, status, updated_at FROM ledger WHERE updated_at >= datetime('now', ?) ORDER BY updated_at DESC LIMIT 25"
  ).all(since) as any[];
  lines.push('', `## Ledger movement (${ledgerMoves.length})`);
  lines.push(...(ledgerMoves.length ? ledgerMoves.map(m => `- [${m.tier}/${m.status}] ${m.title} — ${m.monitor}`) : ['- no changes']));
  const sent = db.prepare(
    "SELECT title, created_at FROM knowledge WHERE source='agent-notification' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 15"
  ).all(since) as any[];
  lines.push('', `## Emails Prime sent you (${sent.length})`);
  lines.push(...(sent.length ? sent.map(s => `- ${String(s.title).replace(/^Sent: /, '')} — ${s.created_at} UTC`) : ['- none']));
  const mech = db.prepare(
    "SELECT title, created_at FROM knowledge WHERE source='mechanic-report' AND created_at >= datetime('now', ?) ORDER BY created_at DESC"
  ).all(since) as any[];
  lines.push('', `## Mechanic (${mech.length} run${mech.length === 1 ? '' : 's'})`);
  lines.push(...(mech.length ? mech.map(m => `- ${m.title} — ${m.created_at} UTC`) : ['- idle']));
  const issues = db.prepare(
    "SELECT substr(id,1,8) i, status, substr(replace(observation,char(10),' '),1,100) o FROM system_issues WHERE updated_at >= datetime('now', ?) ORDER BY updated_at DESC LIMIT 8"
  ).all(since) as any[];
  lines.push('', `## System issues touched (${issues.length})`);
  lines.push(...(issues.length ? issues.map(i => `- ${i.status}: ${i.o}`) : ['- none']));
  const ingested = db.prepare(
    "SELECT source, COUNT(*) n FROM knowledge WHERE created_at >= datetime('now', ?) AND source NOT IN ('agent-notification','mechanic-report') GROUP BY source ORDER BY n DESC"
  ).all(since) as any[];
  lines.push('', `## Ingested`, ingested.length ? ingested.map(i => `${i.source}: ${i.n}`).join(' · ') : 'nothing new');
  return lines.join('\n');
}

export function registerPrimeSurfaces(srv: McpServer): void {
  // ── Resources: live documents Desktop can attach ──
  srv.resource('prime-today', 'prime://today', { description: "Today: open actions with next steps, deadlines, cleared, stalls, who-owes-whom, system health", mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fresh('TODAY.md') }] }));
  srv.resource('prime-ledger', 'prime://ledger', { description: 'Every ball in play across all monitors (the ledger)', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fresh('LEDGER.md') }] }));
  srv.resource('prime-activity', 'prime://activity', { description: "What Prime's agents did in the last 24 hours — monitors, Quinn, mechanic, emails, ingestion", mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: buildActivity(24) }] }));

  // ── Prompts: Prime's own commands inside any chat ──
  srv.prompt('prime-today', 'Open the day: what needs Zach, ranked, with one recommendation', async () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      `You are Quinn, Zach's AI Chief of Staff — a relay to Prime, not a substitute. Here is Prime's live state:\n\n${fresh('TODAY.md')}\n\nGive Zach ONE recommendation for what to do first and why, in under 120 words. Then list the other open actions as one line each. No option lists.` } }],
  }));
  srv.prompt('prime-activity', "What did Prime do while I wasn't looking", async () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      `Summarize what Prime's agents did in the last 24 hours for Zach, plainly, in under 150 words. Lead with anything that changed his priorities. Source:\n\n${buildActivity(24)}` } }],
  }));
  srv.prompt('prime-actions', 'Walk the open actions one at a time', async () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      `You are Quinn. Walk Zach through his open actions ONE at a time: state the action, the next step on file, then wait for him to say done/skip/next before continuing. Use prime tools (prime_retrieve, prime_read_attachment) to pull sources if he asks. Actions:\n\n${fresh('TODAY.md')}` } }],
  }));
  srv.prompt('ask-quinn', 'Ask Quinn about anything in Prime', { topic: z.string().describe('What to look into') }, async ({ topic }) => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      `You are Quinn, Zach's AI Chief of Staff (relay to Prime). Investigate: ${topic}. Use prime_search, then prime_retrieve for the actual sources; cite them. Separate VERIFIED (source read) from UNVERIFIED. End with one recommendation. Never draft outbound email unless asked, and never send anything.` } }],
  }));

  // ── Tool: for surfaces that cannot attach resources (phone, ChatGPT) ──
  srv.tool('prime_activity', "What Prime's agents did recently — monitors run, ledger changes, emails sent to Zach, mechanic runs, system issues, ingestion counts. Use when Zach asks what Prime has been doing or whether it's working.",
    { hours: z.number().optional().describe('Look-back window in hours (default 24)') },
    async ({ hours }) => ({ content: [{ type: 'text' as const, text: buildActivity(Math.min(168, Math.max(1, Math.floor(hours || 24)))) }] }));
}
