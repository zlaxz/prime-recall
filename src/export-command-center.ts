// Command Center export — living-state markdown for Zach's laptop surfaces
// (Claude Desktop's ~/Documents/Claude/Prime + Obsidian). Generated on the
// Mini each hourly block; the laptop's sync script pulls ~/.prime/export/.
import Database from 'better-sqlite3';
import { getDb } from './db.js';
import { getBallLists, buildCoverage, getProposals } from './ledger.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function exportCommandCenter(db: Database.Database = getDb()): void {
  const dir = join(homedir(), '.prime', 'export');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Denver' });
  const days = (d: string | null) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : '?';

  const open = db.prepare(
    "SELECT * FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, deadline IS NULL, deadline"
  ).all() as any[];
  const reminds = db.prepare(
    "SELECT * FROM ledger WHERE tier='remind' AND status='open' AND deadline IS NOT NULL ORDER BY date(deadline) LIMIT 10"
  ).all() as any[];
  const cleared = db.prepare(
    "SELECT title, monitor FROM ledger WHERE status='resolved' AND resolved_at >= datetime('now','-2 day')"
  ).all() as any[];
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
  const quinnLink = (r: any) => 'claude://claude.ai/new?q=' + encodeURIComponent(
    `You are Quinn (Prime relay). Help me with this action: "${r.title}". Next step on file: ${r.next_action || 'n/a'}. Use prime tools to pull the sources, then give me one recommendation.`);
  const coworkLink = (r: any) => 'claude://cowork/new?q=' + encodeURIComponent(
    `Work this Prime action end to end: "${r.title}". Next step: ${r.next_action || 'n/a'}. Read the attached TODAY.md for context. Do not send email to anyone — draft only.`)
    + '&file=' + encodeURIComponent(TODAY_PATH);

  const today: string[] = [
    `# Prime — Today`, ``, `_Updated ${now} (regenerates hourly; source of truth is the Mini)_`, ``,
    `## Open actions (each has an [ACT] email)`,
    ...(open.length ? open.map(r => `- **${r.title}** [${r.monitor}]${r.deadline ? ` — due ${r.deadline}` : ''}${r.notified_at ? '' : ' _(queued)_'}${r.next_action ? `\n  - Next: ${r.next_action}` : ''}\n  - [Ask Quinn](${quinnLink(r)}) · [Work it in Cowork](${coworkLink(r)})`) : ['- none']),
    ``, `## Deadlines ahead`,
    ...(reminds.length ? reminds.map(r => {
      const d = days(r.deadline);
      const tag = d === '?' ? '?' : (d as number) > 0 ? `OVERDUE ${d}d` : `${-(d as number)}d`;
      return `- ${r.deadline} (${tag}): ${r.title}`;
    }) : ['- none tracked']),
    ``, `## Cleared (last 48h)`,
    ...(cleared.length ? cleared.map(c => `- ✅ ${c.title} [${c.monitor}]`) : ['- nothing yet']),
    ``, `## Stalling (emailed + bumped, no movement)`,
    ...(stalling.length ? stalling.map(s => `- ⚠️ ${s.title} [${s.monitor}]`) : ['- none']),
    ``, `## Staff coverage (who watched what)`,
    ...buildCoverage(db).map(c => `- ${c}`),
    ``, `## Staff proposals (say "yes to #n" to Quinn or Claude)`,
    ...(() => { const ps = getProposals(db, 3); return ps.length ? ps.map((pr, i) => `- **#${i + 1} ${pr.title}** [${pr.monitor}]${pr.next_action ? ` — ${pr.next_action.slice(0, 160)}` : ''}`) : ['- none right now']; })(),
    ``, `## You owe a response`,
    ...(youOwe.length ? youOwe.map(l => `- ${l}`) : ['- clear']),
    ``, `## Waiting on them`,
    ...(waitingOn.length ? waitingOn.map(l => `- ${l}`) : ['- clear']),
    ``, `## System`,
    `- Monitors: ${monitors.map(m => `${m.project} (ran ${days(m.last_run_at)}d ago)`).join(' · ')}`,
    `- Mechanic runs last 24h: ${mech}`,
    ...(issues.length ? [`- Issues: ${issues.map(i => `${i.status}: ${i.o}`).join(' | ')}`] : ['- Issues: none open']),
  ];
  writeFileSync(join(dir, 'TODAY.md'), today.join('\n'));

  const all = db.prepare("SELECT * FROM ledger WHERE status='open' ORDER BY monitor, tier, deadline IS NULL, deadline").all() as any[];
  const ledger: string[] = [
    `# Prime — Ledger (every ball in play)`, ``, `_Updated ${now}_`, ``,
    `| Monitor | Item | Tier | Ball | Since | Deadline | Next action |`,
    `|---|---|---|---|---|---|---|`,
    ...all.map(r => `| ${r.monitor} | ${r.title} | ${r.tier} | ${r.ball || ''} | ${r.ball_since || ''} | ${r.deadline || ''} | ${(r.next_action || '').slice(0, 80)} |`),
  ];
  writeFileSync(join(dir, 'LEDGER.md'), ledger.join('\n'));
}
