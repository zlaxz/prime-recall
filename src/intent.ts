// Intent layer — ONE place that understands what Zach means, for every
// inbound channel (email replies now; iMessage capture and Quinn chat later).
//
// Understanding is intelligent (a model reads Zach's words WITH the context
// they were written in). Execution is deterministic and validated (only known
// operations on ids that exist in the context). Below confidence it ASKS;
// if the model is unreachable it never guesses. "undo" reverts the last plan.
import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { insertKnowledge } from './db.js';
import { ensureLedger } from './ledger.js';

const execFileAsync = promisify(execFile);
const CONFIDENCE_FLOOR = 0.7;

export interface IntentContext {
  channel: 'email-reply' | 'imessage' | 'chat';
  threadKey: string;                 // gmail threadId / imessage chat / session id
  repliedTo?: { subject: string; kind: 'brief' | 'act' | 'remind' | 'system' | 'other'; body?: string };
  proposals: { id: string; n: number; title: string; monitor: string }[];   // as numbered where Zach saw them
  actions: { id: string; title: string; monitor: string; inThread: boolean }[];
}

export interface PlanStep {
  op: 'accept_proposal' | 'decline_proposal' | 'resolve_action' | 'dismiss_action' | 'note' | 'monitor_request' | 'undo' | 'unclear';
  target_id?: string;
  text?: string;
  confidence: number;
  reason?: string;
}
export interface Plan { steps: PlanStep[]; reply: string; }

function ensureTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS intent_log (
    id TEXT PRIMARY KEY, thread_key TEXT, channel TEXT, text TEXT, plan TEXT, executed TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
}

// ── Understanding: the model reads the words in context ──
async function askModel(text: string, ctx: IntentContext): Promise<Plan | null> {
  const prompt = [
    'You interpret a short message from Zach Stock to Prime, his AI chief-of-staff system, and turn it into a structured plan. Output ONLY JSON.',
    '',
    `CHANNEL: ${ctx.channel}`,
    ctx.repliedTo ? `HE IS REPLYING TO: [${ctx.repliedTo.kind}] "${ctx.repliedTo.subject}"` : 'NOT A REPLY (fresh message)',
    ctx.repliedTo?.body ? `THAT EMAIL SAID (excerpt):\n${ctx.repliedTo.body.slice(0, 2500)}` : '',
    '',
    'STAFF PROPOSALS as numbered where he saw them (accept/decline by id):',
    ctx.proposals.length ? ctx.proposals.map(p => `  #${p.n} id=${p.id} "${p.title}" [${p.monitor}]`).join('\n') : '  (none)',
    '',
    'OPEN ACTIONS (resolve = he did it; dismiss = drop it):',
    ctx.actions.length ? ctx.actions.map(a => `  id=${a.id} "${a.title}" [${a.monitor}]${a.inThread ? '  <-- THIS is the action in the thread he replied to' : ''}`).join('\n') : '  (none)',
    '',
    `ZACH WROTE: """${text.slice(0, 2000)}"""`,
    '',
    'Rules: a reply in an [act] thread that says done/sent/handled means resolve_action on THAT thread\'s action; skip/drop/kill means dismiss_action on it. "yes/no to #n" or a description means accept/decline that proposal — match by the numbering HE saw, or by title words. Multiple intents in one message = multiple steps. Anything that is information, a request, or an instruction for Quinn = op "note" with the text (never invent actions). A request to watch/track something new = "monitor_request" with text. "undo"/"wait no"/"scratch that" = op "undo". If you genuinely cannot tell what he means, op "unclear" with a one-line question in reply. confidence 0-1 per step; be honest — vague phrasing is low confidence.',
    'reply: ONE natural sentence confirming what you understood (or the clarifying question), in the voice of a sharp assistant — no preamble.',
    '',
    'JSON shape: {"steps":[{"op":"...","target_id":"...","text":"...","confidence":0.9,"reason":"..."}],"reply":"..."}',
  ].filter(l => l !== '').join('\n');

  const body = JSON.stringify({ prompt, timeout: 90, args: ['--max-turns', '1'] });
  const tmp = `/tmp/intent-${Date.now()}.json`;
  try {
    writeFileSync(tmp, body);
    const { stdout } = await execFileAsync('/usr/bin/curl', [
      '-s', '-X', 'POST', 'http://127.0.0.1:3211/claude',
      '-H', 'Content-Type: application/json', '-d', `@${tmp}`, '--max-time', '120',
    ], { timeout: 130000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    if (parsed.error || (parsed.exit_code !== undefined && parsed.exit_code !== 0)) return null;
    const raw = String(parsed.result || '');
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const plan = JSON.parse(raw.slice(start, end + 1)) as Plan;
    if (!Array.isArray(plan.steps)) return null;
    return plan;
  } catch { return null; }
  finally { try { unlinkSync(tmp); } catch {} }
}

// ── Execution: deterministic, validated against context ──
export async function resolveAndExecute(db: Database.Database, text: string, ctx: IntentContext): Promise<{ reply: string; executed: string[] }> {
  ensureTables(db); ensureLedger(db);
  const plan = await askModel(text, ctx);
  const executed: string[] = [];
  const prior: { id: string; status: string }[] = [];

  if (!plan) {
    saveNote(db, text, ctx, 'model unavailable');
    return { reply: `Got it — I've logged this for Quinn (I couldn't interpret it automatically right now, so nothing was changed). "${text.slice(0, 100)}"`, executed: ['note:fallback'] };
  }

  const propIds = new Set(ctx.proposals.map(p => p.id));
  const actIds = new Set(ctx.actions.map(a => a.id));
  const questions: string[] = [];

  for (const step of plan.steps) {
    const conf = typeof step.confidence === 'number' ? step.confidence : 0;
    if (step.op === 'undo') {
      const last = db.prepare("SELECT id, executed FROM intent_log WHERE thread_key = ? AND executed IS NOT NULL AND executed != '[]' ORDER BY created_at DESC LIMIT 1").get(ctx.threadKey) as any;
      if (last) {
        for (const p of JSON.parse(last.executed) as { id: string; status: string }[]) {
          db.prepare("UPDATE ledger SET status=?, updated_at=datetime('now') WHERE id=?").run(p.status, p.id);
        }
        db.prepare("UPDATE intent_log SET executed='[]' WHERE id=?").run(last.id);
        executed.push('undo');
      } else questions.push('Nothing to undo in this thread.');
      continue;
    }
    if (step.op === 'unclear' || conf < CONFIDENCE_FLOOR) {
      if (step.op !== 'note') questions.push(plan.reply || 'Could you clarify which item you meant?');
      else saveNote(db, step.text || text, ctx, 'low-confidence note');
      continue;
    }
    if ((step.op === 'accept_proposal' || step.op === 'decline_proposal') && step.target_id && propIds.has(step.target_id)) {
      const row = db.prepare("SELECT status FROM ledger WHERE id=?").get(step.target_id) as any;
      prior.push({ id: step.target_id, status: row?.status });
      db.prepare("UPDATE ledger SET status=?, updated_at=datetime('now') WHERE id=?").run(step.op === 'accept_proposal' ? 'accepted' : 'dismissed', step.target_id);
      executed.push(`${step.op}:${step.target_id}`);
    } else if ((step.op === 'resolve_action' || step.op === 'dismiss_action') && step.target_id && actIds.has(step.target_id)) {
      const row = db.prepare("SELECT status FROM ledger WHERE id=?").get(step.target_id) as any;
      prior.push({ id: step.target_id, status: row?.status });
      if (step.op === 'resolve_action') db.prepare("UPDATE ledger SET status='resolved', resolved_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(step.target_id);
      else db.prepare("UPDATE ledger SET status='dismissed', updated_at=datetime('now') WHERE id=?").run(step.target_id);
      executed.push(`${step.op}:${step.target_id}`);
    } else if (step.op === 'note' || step.op === 'monitor_request') {
      saveNote(db, step.text || text, ctx, step.op);
      executed.push(step.op);
    } else {
      questions.push(`I couldn't safely act on "${(step.text || step.op).slice(0, 60)}" — which item did you mean?`);
    }
  }

  db.prepare("INSERT INTO intent_log (id, thread_key, channel, text, plan, executed) VALUES (?,?,?,?,?,?)")
    .run(uuid(), ctx.threadKey, ctx.channel, text.slice(0, 2000), JSON.stringify(plan).slice(0, 4000), JSON.stringify(prior));

  let reply = plan.reply || 'Got it.';
  if (questions.length) reply = `${reply} ${questions.join(' ')}`.trim();
  if (executed.length) reply += ' (Reply "undo" to reverse.)';
  return { reply, executed };
}

function saveNote(db: Database.Database, text: string, ctx: IntentContext, kind: string) {
  insertKnowledge(db, {
    id: uuid(),
    title: `${kind === 'monitor_request' ? 'Monitor request' : 'Directive'} from Zach (${ctx.channel}): ${text.slice(0, 80)}`,
    summary: `Zach said${ctx.repliedTo ? ` (replying to "${ctx.repliedTo.subject}")` : ''}: ${text}`,
    source: 'directive',
    source_ref: `intent:${ctx.threadKey}:${Date.now()}`,
    source_date: new Date().toISOString(),
    importance: 'high',
    provenance: 'primary',
    tags: ['directive', ctx.channel, kind],
  } as any);
}
