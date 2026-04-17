import type Database from 'better-sqlite3';
import { scanGmail, scanSentMail } from './gmail.js';
import { scanCalendar } from './calendar.js';
import { scanClaude, importClaudeConversations } from './claude.js';
import { scanCowork } from './cowork.js';
import { getConfig } from '../db.js';
import { join } from 'path';
import { homedir } from 'os';

export interface SyncResult {
  source: string;
  items: number;
  error?: string;
}

export async function syncAll(db: Database.Database): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Gmail — use service account for Zach's inbox (domain-wide delegation)
  // The OAuth token is for quinn@ (system email). Service account accesses all domain accounts.
  const saConfig = getConfig(db, 'gmail_service_account');
  const gmailEmail = getConfig(db, 'gmail_email') || 'zach.stock@recaptureinsurance.com';
  if (saConfig) {
    try {
      const { items } = await scanGmail(db, {
        days: 400,
        maxThreads: 500,
        sourceAccount: gmailEmail as string,
        useServiceAccount: true,
      });
      results.push({ source: 'gmail', items });
    } catch (err: any) {
      results.push({ source: 'gmail', items: 0, error: err.message });
    }
    // Drive scan for Zach (via same service account)
    try {
      const { scanDrive } = await import('./drive.js');
      const driveResult = await scanDrive(db, {
        days: 30,
        maxFiles: 50,
        sourceAccount: gmailEmail as string,
      });
      if (driveResult.items > 0) results.push({ source: 'drive', items: driveResult.items });
    } catch (err: any) {
      // Drive scan failed — not critical, log and continue
      if (!err.message?.includes('not configured')) {
        results.push({ source: 'drive', items: 0, error: err.message?.slice(0, 80) });
      }
    }
  } else {
    // Fallback to OAuth tokens if no service account
    const gmailTokens = getConfig(db, 'gmail_tokens');
    if (gmailTokens) {
      try {
        const { items } = await scanGmail(db, { days: 14, maxThreads: 100 });
        results.push({ source: 'gmail', items });
      } catch (err: any) {
        results.push({ source: 'gmail', items: 0, error: err.message });
      }
    }
  }

  // Calendar
  const calTokens = getConfig(db, 'calendar_tokens');
  if (calTokens) {
    try {
      const { items } = await scanCalendar(db);
      results.push({ source: 'calendar', items });
    } catch (err: any) {
      results.push({ source: 'calendar', items: 0, error: err.message });
    }
  }

  // Claude.ai
  const claudeKey = getConfig(db, 'claude_session_key');
  if (claudeKey) {
    try {
      const { items } = await scanClaude(db, { days: 7, maxConversations: 50 });
      results.push({ source: 'claude', items });
    } catch (err: any) {
      results.push({ source: 'claude', items: 0, error: err.message });
    }
  }

  // Claude.ai conversations from laptop scan (bypasses Cloudflare)
  const laptopClaudeFile = join(homedir(), 'laptop-sources', 'claude-api', 'new_conversations.jsonl');
  try {
    const { existsSync, unlinkSync } = await import('fs');
    if (existsSync(laptopClaudeFile)) {
      const { items, conversations } = await importClaudeConversations(db, laptopClaudeFile);
      if (items > 0) {
        results.push({ source: 'claude-laptop', items });
        unlinkSync(laptopClaudeFile); // Remove after successful import
      }
    }
  } catch (err: any) {
    results.push({ source: 'claude-laptop', items: 0, error: err.message });
  }

  // Cowork (Claude Desktop agent sessions)
  const coworkConnected = getConfig(db, 'cowork_connected');
  if (coworkConnected) {
    try {
      const { items } = await scanCowork(db, { days: 7, maxSessions: 50 });
      results.push({ source: 'cowork', items });
    } catch (err: any) {
      results.push({ source: 'cowork', items: 0, error: err.message });
    }
  }

  // Cowork output files (work products: docs, PDFs, CSVs)
  if (coworkConnected) {
    try {
      const { execSync } = await import('child_process');
      execSync('npx tsx scripts/index-cowork-outputs.ts', { cwd: join(homedir(), 'GitHub', 'prime'), timeout: 60000, stdio: 'ignore' });
      results.push({ source: 'cowork-output', items: 0 }); // count tracked internally
    } catch (_e) {}
  }

  // Claude Code sessions (from laptop-sources sync)
  try {
    const { scanClaudeCode } = await import('./claude-code.js');
    const ccResult = await scanClaudeCode(db, { days: 30, maxSessions: 100 });
    if (ccResult.items > 0) results.push({ source: 'claude-code', items: ccResult.items });
  } catch (err: any) {
    if (!err.message?.includes('Cannot find')) {
      results.push({ source: 'claude-code', items: 0, error: err.message?.slice(0, 80) });
    }
  }

  // Fireflies transcripts
  const ffKey = getConfig(db, 'fireflies_api_key');
  if (ffKey) {
    try {
      const { scanFireflies } = await import('./fireflies.js');
      const ffResult = await scanFireflies(db, { days: 30, maxMeetings: 50 });
      if (ffResult.items > 0) results.push({ source: 'fireflies', items: ffResult.items });
    } catch (err: any) {
      results.push({ source: 'fireflies', items: 0, error: err.message?.slice(0, 80) });
    }
  }

  // Gmail Sent — corrects false awaiting_reply tags + captures Zach-initiated threads
  if (gmailTokens) {
    try {
      const sent = await scanSentMail(db, { days: 7, maxThreads: 100 });
      results.push({ source: 'gmail-sent', items: sent.corrected + sent.newItems });
    } catch (err: any) {
      results.push({ source: 'gmail-sent', items: 0, error: err.message });
    }
  }

    // ── TEAM MEMBER SYNC (via service account) ──
  // Sync Gmail + Calendar for non-CEO team members using domain-wide delegation
  try {
    const teamMembers = db.prepare(
      "SELECT email, name, role FROM team_members WHERE active = 1 AND relationship_to_ceo != 'self'"
    ).all() as any[];

    for (const member of teamMembers) {
      if (member.sync_gmail) {
        try {
          const { items } = await scanGmail(db, {
            days: 400,
            maxThreads: 500,
            sourceAccount: member.email,
            useServiceAccount: true,
          });
          results.push({ source: `gmail:${member.name}`, items });
        } catch (err: any) {
          results.push({ source: `gmail:${member.name}`, items: 0, error: err.message?.slice(0, 80) });
        }
      }

      if (member.sync_calendar) {
        try {
          const { scanCalendarForAccount } = await import('./calendar.js');
          if (typeof scanCalendarForAccount === 'function') {
            const { items } = await scanCalendarForAccount(db, member.email);
            results.push({ source: `calendar:${member.name}`, items });
          }

        } catch (err: any) {
          results.push({ source: `calendar:${member.name}`, items: 0, error: err.message?.slice(0, 80) });
        }
      }
    

      if (member.sync_drive) {
        try {
          const { scanDrive } = await import('./drive.js');
          const driveResult = await scanDrive(db, {
            days: 30,
            maxFiles: 50,
            sourceAccount: member.email,
          });
          if (driveResult.items > 0) {
            results.push({ source: 'drive:' + member.name, items: driveResult.items });
          }
        } catch (driveErr: any) {
          // Drive scan failed — not critical
        }
      }
}
  } catch (teamErr: any) {
    console.log(`  Team sync error: ${teamErr.message?.slice(0, 60)}`);
  }

  // ── CALENDAR-TRIGGERED MEETING PREP ──
  // After sync, check if there's a meeting in the next 2 hours.
  // If so, store it in graph_state for the COS to pick up via prime_proactive_alerts.
  try {
    const upcomingMeetings = db.prepare(`
      SELECT title, summary, source_date, metadata
      FROM knowledge_primary
      WHERE source = 'calendar'
        AND source_date >= datetime('now')
        AND source_date <= datetime('now', '+2 hours')
      ORDER BY source_date ASC
    `).all() as any[];

    if (upcomingMeetings.length > 0) {
      const meetingPrep = upcomingMeetings.map((m: any) => {
        let attendees: string[] = [];
        try {
          const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata || {};
          attendees = (meta.attendee_details || []).map((a: any) => a.displayName || a.email || '').filter(Boolean);
          if (!attendees.length && meta.attendees) attendees = meta.attendees;
        } catch (_e) {}
        return {
          title: m.title,
          time: m.source_date,
          summary: m.summary,
          attendees,
        };
      });

      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('upcoming_meeting_prep', ?, datetime('now'))"
      ).run(JSON.stringify(meetingPrep));

      console.log(`  📅 MEETING PREP: ${upcomingMeetings.length} meeting(s) in next 2 hours`);
    }
  } catch (_e) {}

  // ── EVENT-DRIVEN TRIGGER LAYER ──
  // After sync, check if any new items from high-priority entities arrived.
  // If so, trigger immediate analysis instead of waiting for dream pipeline.
  try {
    const newGmailItems = results.find(r => r.source === 'gmail')?.items || 0;
    const newGmailSent = results.find(r => r.source === 'gmail-sent')?.items || 0;

    if (newGmailItems > 0 || newGmailSent > 0) {
      // Find new items from the last 15 min that involve key entities
      const recentHighPriority = db.prepare(`
        SELECT k.id, k.title, k.source, k.contacts, k.project, k.source_date,
          e.canonical_name as entity_name, e.user_label as entity_context
        FROM knowledge k
        JOIN entity_mentions em ON k.id = em.knowledge_item_id
        JOIN entities e ON em.entity_id = e.id
        WHERE k.created_at >= datetime('now', '-20 minutes')
          AND k.source IN ('gmail', 'gmail-sent')
          AND e.user_dismissed = 0
          AND (e.user_label IS NOT NULL OR e.relationship_type IN ('partner', 'key-contact', 'client'))
        ORDER BY k.source_date DESC
        LIMIT 5
      `).all() as any[];

      if (recentHighPriority.length > 0) {
        // Store as proactive alerts for the COS to pick up
        const alertData = recentHighPriority.map((item: any) => ({
          title: item.title,
          entity: item.entity_name,
          context: item.entity_context,
          project: item.project,
          source_date: item.source_date,
        }));

        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('proactive_alerts', ?, datetime('now'))"
        ).run(JSON.stringify(alertData));

        console.log(`  ⚡ PROACTIVE: ${recentHighPriority.length} new items from key entities`);

        // Ripple Engine: trace cascading implications of high-priority events
        try {
          const { traceRipple } = await import('../ripple.js');
          const eventDesc = recentHighPriority.map((i: any) =>
            `${i.entity_name} (${i.entity_context || 'key contact'}): "${i.title}"`
          ).join('; ');
          // Run async — don't block the sync loop
          traceRipple(db, `New communications from key entities: ${eventDesc}`).then((result) => {
            console.log(`  ⚡ Ripple complete: ${result.ripples?.length || 0} projects affected, ${result.cascading_actions?.length || 0} actions`);
          }).catch((err: any) => {
            console.log(`  ⚡ Ripple failed: ${err.message?.slice(0, 80)}`);
          });
        } catch (_e) {}

        // Event-driven intelligence: trigger intelligence cycle immediately
        // Don't wait for the next dream cron — analyze NOW while the signal is fresh
        const lastIntelRun = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_intel_cycle'").get() as any)?.value;
        const hoursSinceIntel = lastIntelRun ? (Date.now() - new Date(JSON.parse(lastIntelRun)).getTime()) / 3600000 : 999;

        if (hoursSinceIntel > 1) { // Don't re-trigger if ran in last hour
          console.log(`  ⚡ TRIGGERING real-time intelligence cycle (${recentHighPriority.map((i: any) => i.entity_name).join(', ')})`);
          try {
            const { runIntelligenceCycle } = await import('../intelligence-cycle.js');
            // Run async — don't block the sync loop
            runIntelligenceCycle(db).then((result) => {
              db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_intel_cycle', ?, datetime('now'))")
                .run(JSON.stringify(new Date().toISOString()));
              console.log(`  ⚡ Real-time intelligence complete: ${result.output?.headline?.slice(0, 80) || result.status}`);
            }).catch((err: any) => {
              console.log(`  ⚡ Real-time intelligence failed: ${err.message?.slice(0, 80)}`);
            });
          } catch (_e) {}
        }
      }
    }
  } catch (_e) {}

  return results;
}
