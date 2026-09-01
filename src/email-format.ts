// Email formatting — the one place Prime decides how things LOOK in Zach's inbox.
//
// Rules (ADHD, 2026-09-01 "not easy to understand and read"):
//   1. The most important sentence is the first thing on screen.
//   2. Human words only — no monitor ids, ledger keys, tiers, cycle numbers.
//   3. Clear sections, generous whitespace, high contrast, one accent color.
//   4. Everything you can DO is visually distinct from everything you just READ.
//   5. Machinery is one small grey line at the bottom, never the top.
import Database from 'better-sqlite3';

export const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Monitor agent ids → the name Zach uses
const NAME_CACHE = new Map<string, string>();
export function monitorName(db: Database.Database, agentId: string): string {
  if (!agentId) return '';
  if (NAME_CACHE.has(agentId)) return NAME_CACHE.get(agentId)!;
  let name = agentId.replace(/-pm$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  try { const r = db.prepare("SELECT project FROM pm_agents WHERE agent_id = ?").get(agentId) as any; if (r?.project) name = r.project; } catch {}
  if (agentId === 'claude-session') name = 'Claude';
  NAME_CACHE.set(agentId, name);
  return name;
}

// Strip the machine chatter monitors put in titles
export function humanTitle(t: string, max = 90): string {
  let s = String(t || '')
    .replace(/\s*\[[a-z0-9-]+-pm\]\s*/gi, ' ')
    .replace(/\s*—\s*(RESOLVED|resolved)\b.*$/i, '')
    .replace(/\s*[—-]\s*see\s+[a-z0-9-]+\s*$/i, '')                 // "— see baumann-daisy-mota-status"
    .replace(/\s*\((was|cycle|see|per)\b[^)]*\)\s*/gi, ' ')
    .replace(/\b(cycle \d+|item key|ledger)\b/gi, '')
    .replace(/\bZach's\b/g, 'your').replace(/\bZach\b/g, 'you')     // written for Zach, not about him
    .replace(/\s{2,}/g, ' ').trim();
  if (s.length > max) { s = s.slice(0, max); const sp = s.lastIndexOf(' '); if (sp > max * 0.6) s = s.slice(0, sp); s += '…'; }
  return s;
}

const daysFrom = (iso: string | null): number | null => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const dl = new Date(iso.slice(0, 10) + 'T00:00:00'); if (isNaN(dl.getTime())) return null;
  const n = new Date(); const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((dl.getTime() - today.getTime()) / 86400000);
};
export const whenText = (iso: string | null): string => {
  const d = daysFrom(iso); if (d === null) return '';
  return d < 0 ? `${-d} day${-d === 1 ? '' : 's'} overdue` : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : `due in ${d} days`;
};
// "waiting since 2026-05-11" → "waiting 113 days"; leaves other text alone
export const humanWhy = (why: string): string => String(why || '').replace(/waiting( on (?:you|them))? since (\d{4}-\d{2}-\d{2})/i, (_m, on, iso) => {
  const d = daysFrom(iso); return d === null ? _m : `waiting${on || ''} ${-d} day${-d === 1 ? '' : 's'}`;
});

// ── shared shell ──
const C = { text: '#1a1a1a', muted: '#6b7280', faint: '#9ca3af', accent: '#0f6fff', bg: '#f6f7f9', card: '#ffffff', line: '#e5e7eb', good: '#0a7a3b', warn: '#b45309' };
function shell(inner: string, footer: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.text};">
<div style="max-width:620px;margin:0 auto;padding:24px 16px;">
<div style="background:${C.card};border-radius:12px;padding:28px 28px 20px;border:1px solid ${C.line};">
${inner}
</div>
<div style="font-size:11px;color:${C.faint};padding:14px 8px 0;line-height:1.6;">${footer}</div>
</div></body></html>`;
}
const h = (label: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};margin:26px 0 8px;">${esc(label)}</div>`;
const p = (text: string, size = 16) => `<div style="font-size:${size}px;line-height:1.55;margin:0 0 10px;">${text}</div>`;
const li = (text: string) => `<div style="font-size:15px;line-height:1.5;padding:6px 0;border-top:1px solid ${C.line};">${text}</div>`;

// ── the morning brief ──
export interface BriefData {
  date: string;
  headline: string;                   // one line, the day in a sentence
  prose: string;                      // Quinn's short note (plain text)
  actions: { title: string; why: string; when: string; inInbox: boolean }[];
  cleared: { title: string; file?: string | null }[];
  proposals: { n: number; title: string; from: string }[];
  deadlines: { title: string; when: string }[];
  coverage: { name: string; ok: boolean; note: string }[];
  held: number; system: string;
}
export function renderBriefText(d: BriefData): string {
  const L: string[] = [d.headline, '', d.prose, ''];
  if (d.actions.length) { L.push('YOUR ACTIONS TODAY'); d.actions.forEach((a, i) => L.push(`${i + 1}. ${a.title}${a.when ? ` — ${a.when}` : ''}${a.inInbox ? ' (email in your inbox)' : ''}`)); L.push(''); }
  if (d.cleared.length) { L.push('CLEARED'); d.cleared.forEach(c => L.push(`✓ ${c.title}`)); L.push(''); }
  if (d.proposals.length) { L.push('STAFF PROPOSALS — reply "yes to #1" / "no to #2"'); d.proposals.forEach(pr => L.push(`#${pr.n} ${pr.title} (${pr.from})`)); L.push(''); }
  if (d.deadlines.length) { L.push('DEADLINES'); d.deadlines.forEach(x => L.push(`- ${x.when}: ${x.title}`)); L.push(''); }
  L.push(`Watched: ${d.coverage.map(c => c.ok ? c.name : `${c.name} (${c.note})`).join(' · ')}`);
  L.push(d.system);
  return L.join('\n');
}
export function renderBriefHtml(d: BriefData): string {
  const inner: string[] = [];
  inner.push(`<div style="font-size:12px;color:${C.muted};margin-bottom:6px;">${esc(d.date)}</div>`);
  inner.push(`<div style="font-size:21px;font-weight:600;line-height:1.3;margin-bottom:18px;">${esc(d.headline)}</div>`);
  inner.push(d.prose.split(/\n{2,}/).map(par => p(esc(par).replace(/\n/g, '<br>'))).join(''));

  if (d.actions.length) {
    inner.push(h('Your actions today'));
    d.actions.forEach((a, i) => inner.push(
      `<div style="padding:10px 14px;margin:6px 0;background:#eef4ff;border-left:4px solid ${C.accent};border-radius:6px;">
        <div style="font-size:15px;font-weight:600;">${i + 1}. ${esc(a.title)}</div>
        <div style="font-size:13px;color:${C.muted};margin-top:2px;">${esc([a.when, humanWhy(a.why)].filter(Boolean).join(' · '))}${a.inInbox ? ` · <span style="color:${C.accent}">draft in your inbox</span>` : ''}</div>
      </div>`));
  }
  if (d.cleared.length) {
    inner.push(h('Cleared'));
    d.cleared.forEach(c => inner.push(li(`<span style="color:${C.good};font-weight:600;">✓</span> ${esc(c.title)}${c.file ? ` <span style="color:${C.muted};font-size:12px;">· file ready</span>` : ''}`)));
  }
  if (d.proposals.length) {
    inner.push(h('Your staff is offering'));
    d.proposals.forEach(pr => inner.push(li(`<b>#${pr.n}</b> ${esc(pr.title)} <span style="color:${C.muted};font-size:12px;">— ${esc(pr.from)}</span>`)));
    inner.push(`<div style="font-size:12px;color:${C.muted};margin-top:6px;">Reply to this email: “yes to #1”, “no to #2”, or just say what you want.</div>`);
  }
  if (d.deadlines.length) {
    inner.push(h('Coming up'));
    d.deadlines.forEach(x => inner.push(li(`<span style="color:${/overdue/.test(x.when) ? C.warn : C.text};font-weight:600;">${esc(x.when)}</span> — ${esc(x.title)}`)));
  }
  const off = d.coverage.filter(c => !c.ok);
  inner.push(h('Watched overnight'));
  inner.push(`<div style="font-size:13px;color:${C.muted};line-height:1.6;">${d.coverage.map(c => c.ok ? esc(c.name) : `<span style="color:${C.warn}">${esc(c.name)} — ${esc(c.note)}</span>`).join(' · ')}${off.length ? '' : ' · <span style="color:' + C.good + '">all ran</span>'}</div>`);

  const footer = `${esc(d.system)}${d.held ? ` · ${d.held} email${d.held === 1 ? '' : 's'} held by your daily cap` : ''}<br>Quinn Parker · AI Chief of Staff · reply to this email in your own words`;
  return shell(inner.join('\n'), footer);
}

// ── action / reminder emails ──
export interface ActionData {
  title: string; when: string; why: string; nextAction: string; draft?: string | null;
  links: { label: string; url: string }[]; from: string; bump: boolean; kind: 'act' | 'remind';
}
export function renderActionHtml(a: ActionData): string {
  const inner: string[] = [];
  if (a.bump) inner.push(`<div style="font-size:12px;color:${C.warn};font-weight:600;margin-bottom:8px;">Still open after two days — this is the last email about it; the morning brief carries it from here.</div>`);
  inner.push(`<div style="font-size:20px;font-weight:600;line-height:1.3;">${esc(a.title)}</div>`);
  if (a.when || a.why) inner.push(`<div style="font-size:13px;color:${C.muted};margin:6px 0 16px;">${esc([a.when, humanWhy(a.why)].filter(Boolean).join(' · '))}</div>`);
  inner.push(`<div style="padding:12px 14px;background:#eef4ff;border-left:4px solid ${C.accent};border-radius:6px;font-size:15px;line-height:1.5;"><b>${a.kind === 'remind' ? 'Heads up' : 'Do this'}:</b> ${esc(a.nextAction || '—')}</div>`);
  if (a.draft) inner.push(`${h('Ready to send — copy from here')}<div style="padding:12px 14px;background:#fafafa;border:1px solid ${C.line};border-radius:6px;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(a.draft)}</div>`);
  if (a.links.length) inner.push(`${h('Sources')}${a.links.map(l => `<div style="font-size:13px;padding:3px 0;"><a href="${esc(l.url)}" style="color:${C.accent};text-decoration:none;">${esc(l.label)}</a></div>`).join('')}`);
  const footer = `From your ${esc(a.from)} monitor · when you act, Prime sees your sent mail and closes this · reply “done” or “skip” anytime`;
  return shell(inner.join('\n'), footer);
}
