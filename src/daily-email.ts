import type Database from 'better-sqlite3';
import { readFileSync , readdirSync } from 'fs';
import { join } from 'path';
import { sendEmail } from './connectors/gmail.js';

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

    // Deterministic ADHD header — CLEARED first (dopamine, evidence-only),
    // then open-actions index, then a system heartbeat so Zach never has to
    // ask "is it working". Computed from the DB, never from the LLM.
    const buildBriefHeader = (): string => {
      const lines: string[] = [];
      try {
        const cleared = db.prepare(
          "SELECT title, monitor FROM ledger WHERE status='resolved' AND resolved_at >= datetime('now','-1 day')"
        ).all() as any[];
        if (cleared.length) {
          lines.push('CLEARED since yesterday:');
          for (const c of cleared.slice(0, 5)) lines.push(`  DONE ${c.title} [${c.monitor}]`);
        }
        const openActs = db.prepare(
          "SELECT COUNT(*) n FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NOT NULL"
        ).get() as any;
        const queued = db.prepare(
          "SELECT COUNT(*) n FROM ledger WHERE tier='act' AND status='open' AND notified_at IS NULL"
        ).get() as any;
        if (openActs.n || queued.n) {
          lines.push(`ACTIONS: ${openActs.n} open in your inbox${queued.n ? `, ${queued.n} queued` : ''}`);
        }
        // actual completions in 24h, not roster size — the heartbeat must not
        // read "7 monitors ran" on a morning when zero did (audit finding)
        const monitors = (db.prepare("SELECT COUNT(*) n FROM agent_state WHERE agent_type='pm' AND last_run_at >= datetime('now','-1 day')").get() as any)?.n ?? '?';
        const mech = db.prepare(
          "SELECT COUNT(*) n FROM knowledge WHERE source='mechanic-report' AND created_at >= datetime('now','-1 day')"
        ).get() as any;
        let brokenTxt = 'health unknown';
        try {
          const n = readdirSync(join(homedir, '.prime', 'health-alerts')).filter((f: string) => !f.endsWith('.dispatched')).length;
          brokenTxt = n === 0 ? 'nothing broken' : `${n} issue(s) flagged`;
        } catch {}
        lines.push(`SYSTEM: ${monitors} monitors ran · ${mech.n} mechanic run${mech.n === 1 ? '' : 's'} · ${brokenTxt}`);
      } catch {}
      return lines.join('\n');
    };
    const briefHeader = buildBriefHeader();

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

    // Clean HTML email
    const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const bodyWithHeader = briefHeader ? briefHeader + '\n\n---\n\n' + emailBody : emailBody;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:15px;color:#cbd5e1;line-height:1.7;">
    ${esc(bodyWithHeader)}
  </div>
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;">
    <div style="font-size:13px;font-weight:500;color:#94a3b8;">Quinn Parker</div>
    <div style="font-size:11px;color:#475569;">AI Chief of Staff, Recapture Insurance</div>
    <div style="font-size:10px;color:#334155;margin-top:8px;">${date} | ${kbCount} items tracked | Reply to update Prime</div>
  </div>
</div></body></html>`;

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
