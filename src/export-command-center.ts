// Command Center export — living-state markdown for Zach's laptop surfaces
// (Claude Desktop's ~/Documents/Claude/Prime + Obsidian). Generated on the
// Mini each hourly block; the laptop's sync script pulls ~/.prime/export/.
import Database from 'better-sqlite3';
import { getDb } from './db.js';
import { getBallLists, buildCoverage, getProposals } from './ledger.js';
import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// SQLite 'YYYY-MM-DD HH:MM:SS' is UTC without a Z — parse it as such (audit: "ran -1d ago")
const parseDb = (d: string) => new Date(/^\d{4}-\d{2}-\d{2} \d/.test(d) ? d.replace(' ', 'T') + 'Z' : d);
// Deadlines are calendar dates: compare LOCAL calendar days, never UTC instants
const daysUntil = (deadline: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(deadline)) return null;
  const dl = new Date(deadline.slice(0, 10) + 'T00:00:00');
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (isNaN(dl.getTime())) return null;
  return Math.round((dl.getTime() - today.getTime()) / 86400000);
};
// markdown-safe URL: encodeURIComponent leaves ( ) ' which break [text](url)
const mdUrl = (u: string) => u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27');

// Returns the documents; writes files ONLY when write=true (the shift daemon).
// Resource reads from the MCP server use the strings — two processes must not
// race on the same files (audit H2), and writes are atomic (tmp + rename).
export function exportCommandCenter(db: Database.Database = getDb(), opts: { write?: boolean } = {}): { today: string; ledger: string } {
  const write = opts.write !== false;
  const dir = join(homedir(), '.prime', 'export');
  if (write) mkdirSync(dir, { recursive: true });
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Denver' });
  const days = (d: string | null) => d ? Math.floor((Date.now() - parseDb(d).getTime()) / 86400000) : '?';

  const open = db.prepare(
    "SELECT * FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, deadline IS NULL, deadline"
  ).all() as any[];
  const reminds = db.prepare(
    "SELECT * FROM ledger WHERE tier='remind' AND status='open' AND deadline IS NOT NULL ORDER BY date(deadline) LIMIT 10"
  ).all() as any[];
  const cleared = db.prepare(
    "SELECT title, monitor, deliverable FROM ledger WHERE status='resolved' AND resolved_at >= datetime('now','-2 day')"
  ).all() as any[];
  const deliverables = db.prepare(
    "SELECT title, monitor, deliverable, updated_at FROM ledger WHERE deliverable IS NOT NULL ORDER BY updated_at DESC LIMIT 10"
  ).all() as any[];
  const openDeliv = (d: string) => mdUrl('claude://cowork/new?q=' + encodeURIComponent('Review this Prime deliverable with me and suggest edits.') + '&file=' + encodeURIComponent('/Users/zstoc/Documents/Claude/Prime/' + d));
  const stalling = db.prepare(
    "SELECT title, monitor FROM ledger WHERE status='open' AND bumped_at IS NOT NULL AND tier='brief' ORDER BY bumped_at DESC LIMIT 8"
  ).all() as any[];
  const { youOwe, waitingOn } = getBallLists(db);
  const monitors = db.prepare(
    "SELECT p.agent_id, p.project, a.last_run_at FROM pm_agents p LEFT JOIN agent_state a ON a.subject_id = p.project AND a.agent_type='pm' WHERE p.active=1 ORDER BY p.created_at"
  ).all() as any[];
  const mech = (db.prepare("SELECT COUNT(*) n FROM knowledge WHERE source='mechanic-report' AND created_at >= datetime('now','-1 day')").get() as any).n;
  const issues = db.prepare("SELECT substr(id,1,8) i, status, substr(replace(observation, char(10), ' '),1,90) o FROM system_issues WHERE status IN ('open','dispatched','needs-zach','stalled') ORDER BY updated_at DESC LIMIT 6").all() as any[];

  // claude:// deep links — the direct bridge from Prime's state into Claude
  // Desktop: one click opens Quinn (chat) or a Cowork session with this file
  // attached and the action pre-filled. Laptop path is the target.
  const TODAY_PATH = '/Users/zstoc/Documents/Claude/Prime/TODAY.md';
  const quinnLink = (r: any) => mdUrl('claude://claude.ai/new?q=' + encodeURIComponent(
    `You are Quinn (Prime relay). Help me with this action: "${r.title}". Next step on file: ${r.next_action || 'n/a'}. Use prime tools to pull the sources, then give me one recommendation.`));
  const coworkLink = (r: any) => mdUrl('claude://cowork/new?q=' + encodeURIComponent(
    `Work this Prime action end to end: "${r.title}". Next step: ${r.next_action || 'n/a'}. Read the attached TODAY.md for context. Do not send email to anyone and do not create Gmail drafts — put any proposed email text directly in your reply so Zach can copy, edit, and send it himself.`)
    + '&file=' + encodeURIComponent(TODAY_PATH));

  const today: string[] = [
    `# Prime — Today`, ``, `_Updated ${now} (regenerates hourly; source of truth is the Mini)_`, ``,
    `## Open actions (each has an [ACT] email)`,
    ...(open.length ? open.map(r => `- **${r.title}** [${r.monitor}]${r.deadline ? ` — due ${r.deadline}` : ''}${r.notified_at ? '' : ' _(queued)_'}${r.next_action ? `\n  - Next: ${r.next_action}` : ''}\n  - [Ask Quinn](${quinnLink(r)}) · [Work it in Cowork](${coworkLink(r)})`) : ['- none']),
    ``, `## Deadlines ahead`,
    ...(reminds.length ? reminds.map(r => {
      const d = daysUntil(r.deadline);
      const tag = d === null ? '?' : d < 0 ? `OVERDUE ${-d}d` : d === 0 ? 'today' : `${d}d`;
      return `- ${r.deadline} (${tag}): ${r.title}`;
    }) : ['- none tracked']),
    ``, `## Cleared (last 48h)`,
    ...(cleared.length ? cleared.map(c => `- ✅ ${c.title} [${c.monitor}]${c.deliverable ? ` — [open](${openDeliv(c.deliverable)}) · ${c.deliverable}` : ''}`) : ['- nothing yet']),
    ``, `## Deliverables (what the staff produced)`,
    ...(deliverables.length ? deliverables.map(d => `- ${d.title} [${d.monitor}] — [open in Cowork](${openDeliv(d.deliverable)}) · \`${d.deliverable}\``) : ['- none yet']),
    ``, `## Stalling (emailed + bumped, no movement)`,
    ...(stalling.length ? stalling.map(s => `- ⚠️ ${s.title} [${s.monitor}]`) : ['- none']),
    ``, `## Staff coverage (who watched what)`,
    ...buildCoverage(db).map(c => `- ${c}`),
    ``, `## Staff proposals (say "yes to #n" to Quinn or Claude)`,
    ...(() => { const ps = getProposals(db, 3); return ps.length ? ps.map((pr, i) => `- **#${i + 1} [${String(pr.id).slice(0, 4)}] ${pr.title}** [${pr.monitor}]${pr.next_action ? ` — ${pr.next_action.slice(0, 160)}` : ''}`) : ['- none right now']; })(),
    ``, `## You owe a response`,
    ...(youOwe.length ? youOwe.map(l => `- ${l}`) : ['- clear']),
    ``, `## Waiting on them`,
    ...(waitingOn.length ? waitingOn.map(l => `- ${l}`) : ['- clear']),
    ``, `## System`,
    `- Monitors: ${monitors.map(m => `${m.project} (ran ${days(m.last_run_at)}d ago)`).join(' · ')}`,
    `- Mechanic runs last 24h: ${mech}`,
    ...(issues.length ? [`- Issues: ${issues.map(i => `${i.status}: ${i.o}`).join(' | ')}`] : ['- Issues: none open']),
  ];
  const todayText = today.join('\n');
  if (write) { writeFileSync(join(dir, 'TODAY.md.tmp'), todayText); renameSync(join(dir, 'TODAY.md.tmp'), join(dir, 'TODAY.md')); }

  const all = db.prepare("SELECT * FROM ledger WHERE status='open' ORDER BY monitor, tier, deadline IS NULL, deadline").all() as any[];
  const ledger: string[] = [
    `# Prime — Ledger (every ball in play)`, ``, `_Updated ${now}_`, ``,
    `| Monitor | Item | Tier | Ball | Since | Deadline | Next action |`,
    `|---|---|---|---|---|---|---|`,
    ...all.map(r => `| ${r.monitor} | ${r.title} | ${r.tier} | ${r.ball || ''} | ${r.ball_since || ''} | ${r.deadline || ''} | ${(r.next_action || '').slice(0, 80)} |`),
  ];
  const ledgerText = ledger.join('\n');
  if (write) { writeFileSync(join(dir, 'LEDGER.md.tmp'), ledgerText); renameSync(join(dir, 'LEDGER.md.tmp'), join(dir, 'LEDGER.md')); }
  return { today: todayText, ledger: ledgerText };
}
