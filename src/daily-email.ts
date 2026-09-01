import type Database from 'better-sqlite3';
import { readFileSync , readdirSync } from 'fs';
import { join } from 'path';
import { sendEmail } from './connectors/gmail.js';
import { buildCoverage, getProposals } from './ledger.js';
import { heldToday } from './email-budget.js';

// ============================================================
// Quinn's Daily Email — sends FOCUS.md as an email to Zach
//
// No separate LLM call. Quinn's FOCUS.md IS the intelligence.
// This module wraps it in clean HTML and sends it.
// ============================================================

export async function sendDailyIntelligenceEmail(db: Database.Database): Promise<boolean> {
  try {
    const homedir = process.env.HOME || '';

    // Read Quinn's FOCUS.md — her working state
    let focus = '';
    try { focus = readFileSync(join(homedir, '.prime', 'FOCUS.md'), 'utf-8'); } catch {}

    if (!focus || focus.length < 50) {
      console.log('[quinn-email] No FOCUS.md to send');
      return false;
    }

    // Load Quinn's identity
    let soul = '';
    try { soul = readFileSync(join(homedir, '.prime', 'agents', 'cos', 'SOUL.md'), 'utf-8'); } catch {}

    // Have Quinn WRITE the email as a COS — not just dump FOCUS.md
    const { runClaude } = await import('./utils/claude-spawn.js');

    const now = new Date();
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
    const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' })}`;

    const emailPrompt = [
      soul ? soul.slice(0, 2000) : 'You are Quinn Parker, AI Chief of Staff to Zach Stock at Recapture Insurance.',
      '',
      `TODAY IS: ${dateStr}`,
      '',
      'Below is your working state from your last investigation cycle. Use it to write a MORNING EMAIL to Zach.',
      '',
      '## YOUR WORKING STATE',
      focus,
      '',
      '## YOUR TASK',
      'Write a brief morning email to Zach. You are his Chief of Staff.',
      '',
      'CRITICAL RULES:',
      '- ONLY include information from the "What I Verified" section above. Those are things you actually read and confirmed.',
      '- The "What I Saw In Search Results" section is UNVERIFIED — search result summaries may be hallucinated by the extraction LLM. Do NOT present these as facts in the email.',
      '- If you want to mention something unverified, say explicitly "I haven\'t confirmed this yet, but search results suggest..."',
      '- Do NOT invent connections, timelines, or ownership claims that aren\'t in your working state.',
      '- Do NOT add ANY information that isn\'t in the working state above. You are summarizing, not creating.',
      '',
      'STYLE:',
      '- Write like a trusted colleague — conversational, direct',
      '- Lead with the ONE thing that matters. If nothing is urgent, say so.',
      '- Consider Zach\'s current state. Filter ruthlessly. Less is more.',
      '- If something can wait, say "this can wait"',
      '- Under 250 words. ADHD — shorter is better.',
      '- Render every date as a countdown first: "in 5 days (Sep 5)" — never a bare date. Time-blindness is real.',
      '- A status header (cleared items, open actions, system health) is prepended automatically — do NOT repeat that information.',
      '- NO bullet points, NO headers. Natural email.',
      '',
      'Return ONLY the email body text.',
    ].join('\n');

    console.log('[quinn-email] Quinn drafting email (Opus)...');
    const emailBody = await runClaude(emailPrompt, {
      model: 'claude-opus-4-7',
      maxTurns: 1,
      timeout: 60000,
    });

    if (!emailBody || emailBody.length < 30) {
      console.log('[quinn-email] Quinn produced empty email');
      return false;
    }

    // Structured brief data (deterministic, from the DB) → readable HTML.
    // Human words only: no monitor ids, ledger keys, tiers or cycle chatter.
    const { renderBriefHtml, renderBriefText, humanTitle, monitorName, whenText } = await import('./email-format.js');
    const { buildCoverage, getProposals } = await import('./ledger.js');
    const { heldToday } = await import('./email-budget.js');
    const briefData: any = { actions: [], cleared: [], proposals: [], deadlines: [], coverage: [], held: 0, system: '' };
    try {
      const acts = db.prepare(
        "SELECT title, next_action, deadline, ball_since, notified_at, monitor FROM ledger WHERE tier='act' AND status='open' ORDER BY notified_at IS NULL, deadline IS NULL, deadline LIMIT 3"
      ).all() as any[];
      briefData.actions = acts.map((a: any) => ({
        title: humanTitle(a.title), when: whenText(a.deadline),
        why: a.ball_since && !a.deadline ? `waiting since ${a.ball_since}` : '', inInbox: !!a.notified_at,
      }));
      const cleared = db.prepare(
        "SELECT title, deliverable FROM ledger WHERE status='resolved' AND resolved_at >= datetime('now','-1 day') ORDER BY resolved_at DESC LIMIT 5"
      ).all() as any[];
      briefData.cleared = cleared.map((c: any) => ({ title: humanTitle(c.title), file: c.deliverable }));
      const props: any[] = getProposals(db, 3);
      (briefData as any).props = props;
      briefData.proposals = props.map((pr: any, i: number) => ({ n: i + 1, title: humanTitle(pr.title.replace(/^I could\s+/i, ''), 110), from: monitorName(db, pr.monitor) }));
      const dl = db.prepare(
        "SELECT title, deadline FROM ledger WHERE status='open' AND deadline IS NOT NULL AND date(deadline) <= date('now','localtime','+7 days') ORDER BY date(deadline) LIMIT 6"
      ).all() as any[];
      briefData.deadlines = dl.map((x: any) => ({ title: humanTitle(x.title, 80), when: whenText(x.deadline) }));
      const cov: string[] = buildCoverage(db);
      briefData.coverage = cov.map((line: string) => {
        const name = line.split(' — ')[0];
        const never = /ran never/.test(line); const muted = /MUTED/.test(line);
        return { name, ok: !never && !muted, note: never ? 'has not run yet' : muted ? 'muted (you skipped its last actions)' : '' };
      });
      const monitors = (db.prepare("SELECT COUNT(*) n FROM agent_state WHERE agent_type='pm' AND last_run_at >= datetime('now','-1 day')").get() as any)?.n ?? '?';
      const mech = (db.prepare("SELECT COUNT(*) n FROM knowledge WHERE source='mechanic-report' AND created_at >= datetime('now','-1 day')").get() as any).n;
      let brokenTxt = 'health unknown';
      try { const n = readdirSync(join(homedir, '.prime', 'health-alerts')).filter((f: string) => !f.endsWith('.dispatched')).length; brokenTxt = n === 0 ? 'nothing broken' : `${n} issue${n === 1 ? '' : 's'} flagged`; } catch {}
      briefData.system = `${monitors} monitors ran · ${mech} mechanic run${mech === 1 ? '' : 's'} · ${brokenTxt}`;
      try { briefData.held = heldToday(db).n; } catch {}
    } catch (e: any) { console.log('[quinn-email] brief data failed: ' + (e?.message || e)); }
    const buildBriefHeader: any = () => '';
    (buildBriefHeader as any).props = (briefData as any).props || [];
    const briefHeader = '';

    // Get subject from brief or FOCUS
    const briefRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'intelligence_brief'"
    ).get() as any)?.value;
    const brief = briefRaw ? JSON.parse(briefRaw) : {};

    const date = now.toLocaleDateString('en-US', {
      timeZone: 'America/Denver',
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?';

    // Readable HTML brief; plain-text twin is what the reply intent layer sees
    const rawSubjectPre = brief.headline?.slice(0, 80) || (focus.match(/## The One Thing\n(.+)/)?.[1] || '').slice(0, 80) || 'Morning Brief';
    const full = { ...briefData, date, headline: rawSubjectPre, prose: emailBody.trim() };
    const html = renderBriefHtml(full);
    const bodyWithHeader = renderBriefText(full);

    const theOneThing = focus.match(/## The One Thing\n(.+)/)?.[1] || '';
    const rawSubject = brief.headline?.slice(0, 80) || theOneThing.slice(0, 80) || 'Morning Brief';
    const subject = '[BRIEF] ' + rawSubject.replace(/\u2014/g, '-').replace(/[^\x20-\x7E]/g, '');

    const result = await sendEmail(db, {
      to: 'zach.stock@recaptureinsurance.com',
      subject,
      body: html,
      html: true,
    });

    if (result.success) {
      // Store the email body for Quinn context
      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('cos_email_body', ?, datetime('now'))"
      ).run(focus);
      try {
        // keyed by SUBJECT (mailbox-safe; Gmail thread ids differ per mailbox) — the
        // exact list and body Zach saw, so "#2" means the #2 in THIS email forever
        const props: any[] = (buildBriefHeader as any).props || [];
        db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
          .run(`brief_sent:${subject.replace(/^\[BRIEF\]\s*/, '').slice(0, 120)}`, JSON.stringify({
            sent_at: new Date().toISOString(), body: bodyWithHeader.slice(0, 6000),
            proposals: props.map((pr: any) => ({ id: pr.id, title: pr.title, monitor: pr.monitor })),
          }));
      } catch {}
      console.log('[quinn-email] Sent: "' + subject.slice(0, 60) + '"');
      return true;
    } else {
      console.log('[quinn-email] Failed: ' + result.error);
      return false;
    }
  } catch (err: any) {
    console.log('[quinn-email] Error: ' + err.message?.slice(0, 100));
    return false;
  }
}
