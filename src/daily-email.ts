import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
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

    // Read Quinn's FOCUS.md — this is her working state
    let focus = '';
    try { focus = readFileSync(join(homedir, '.prime', 'FOCUS.md'), 'utf-8'); } catch {}

    if (!focus || focus.length < 50) {
      console.log('[quinn-email] No FOCUS.md to send');
      return false;
    }

    // Get the brief for the subject line
    const briefRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'intelligence_brief'"
    ).get() as any)?.value;
    const brief = briefRaw ? JSON.parse(briefRaw) : {};

    // Get health status
    const healthRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'source_health_alert'"
    ).get() as any)?.value;
    const health = healthRaw ? JSON.parse(healthRaw) : null;

    // Build the email from FOCUS.md
    const date = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/Denver',
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any)?.c || '?';

    // Convert markdown to basic HTML
    const mdToHtml = (md: string): string => {
      return md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^## (.+)$/gm, '<h3 style="color:#e2e8f0;margin:20px 0 8px 0;font-size:16px;">$1</h3>')
        .replace(/^# (.+)$/gm, '<h2 style="color:#f8fafc;margin:0 0 16px 0;font-size:20px;">$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#f8fafc;">$1</strong>')
        .replace(/\[VERIFIED[^\]]*\]/g, '<span style="color:#22c55e;font-size:11px;">$&</span>')
        .replace(/\[UNVERIFIED[^\]]*\]/g, '<span style="color:#f59e0b;font-size:11px;">$&</span>')
        .replace(/\[INFERRED[^\]]*\]/g, '<span style="color:#f59e0b;font-size:11px;">$&</span>')
        .replace(/^- (.+)$/gm, '<div style="padding:2px 0 2px 16px;">• $1</div>')
        .replace(/^\d+\. (.+)$/gm, '<div style="padding:2px 0 2px 16px;">$&</div>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
    };

    const healthSection = health?.criticals?.length > 0
      ? `<div style="margin-top:16px;padding:12px;background:#1a0505;border:1px solid #7f1d1d;border-radius:6px;">
          <div style="color:#fca5a5;font-weight:600;font-size:13px;">⚠️ System Alerts</div>
          <div style="color:#f87171;font-size:12px;margin-top:4px;">${health.criticals.join('<br>')}</div>
        </div>`
      : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:14px;color:#cbd5e1;line-height:1.75;">
    ${mdToHtml(focus)}
  </div>
  ${healthSection}
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;">
    <div style="font-size:13px;font-weight:500;color:#94a3b8;">Quinn Parker</div>
    <div style="font-size:11px;color:#475569;">AI Chief of Staff, Recapture Insurance</div>
    <div style="font-size:10px;color:#334155;margin-top:8px;">${date} | ${kbCount} items tracked | Reply to update Prime</div>
  </div>
</div></body></html>`;

    // Subject line from the brief headline or FOCUS.md The One Thing
    const theOneThing = focus.match(/## The One Thing\n(.+)/)?.[1] || '';
    const rawSubject = brief.headline?.slice(0, 80) || theOneThing.slice(0, 80) || 'Morning Brief';
    const subject = rawSubject.replace(/\u2014/g, '-').replace(/[^\x20-\x7E]/g, '');

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
