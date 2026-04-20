import type Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { statSync } from 'fs';

/**
 * Source Health Monitor — checks ALL ingestion sources for staleness.
 * Called by the shift daemon every 4 hours.
 * Stores alerts in graph_state AND sends iMessage for critical issues.
 */

// Every source that Prime ingests, with expected freshness thresholds
const THRESHOLDS: Record<string, { warn: number; critical: number; label: string }> = {
  // Core sources — must be fresh
  'gmail':         { warn: 12,  critical: 24,  label: 'Gmail inbox' },
  'gmail-sent':    { warn: 24,  critical: 72,  label: 'Gmail sent' },
  'calendar':      { warn: 48,  critical: 168, label: 'Google Calendar' },
  'claude':        { warn: 24,  critical: 48,  label: 'Claude.ai conversations' },
  'cowork':        { warn: 48,  critical: 168, label: 'Cowork sessions' },

  // Secondary sources — less frequent but should still sync
  'fireflies':     { warn: 168, critical: 504, label: 'Fireflies transcripts' }, // weekly meetings
  'claude-code':   { warn: 72,  critical: 168, label: 'Claude Code sessions' },
  'drive':         { warn: 168, critical: 504, label: 'Google Drive' },
  'user-feedback': { warn: 48,  critical: 168, label: 'User feedback (Quinn chat)' },
};

// Infrastructure checks — not data sources but critical for system health
interface InfraCheck {
  name: string;
  check: (db: Database.Database) => string | null; // returns error message or null
}

const INFRA_CHECKS: InfraCheck[] = [
  {
    name: 'Service account',
    check: (db) => {
      const sa = db.prepare("SELECT value FROM config WHERE key = 'gmail_service_account'").get() as any;
      return sa?.value ? null : 'Service account missing — Gmail/Drive/Calendar sync broken';
    },
  },
  {
    name: 'Proxy',
    check: () => {
      try {
        const result = execSync('curl -s --max-time 3 http://localhost:3211/health', { encoding: 'utf-8', timeout: 5000 });
        return result.includes('ok') ? null : 'Proxy not responding';
      } catch {
        return 'Proxy down — Quinn and PM agents cannot run';
      }
    },
  },
  {
    name: 'FOCUS.md freshness',
    check: () => {
      try {
        const stat = statSync(process.env.HOME + '/.prime/FOCUS.md');
        const ageH = (Date.now() - stat.mtimeMs) / 3600000;
        return ageH > 8 ? `FOCUS.md is ${Math.round(ageH)}h stale — Quinn may not be running` : null;
      } catch {
        return 'FOCUS.md missing — Quinn has never run';
      }
    },
  },
  {
    name: 'Wiki pages',
    check: (db) => {
      const stale = (db.prepare(`SELECT COUNT(*) as c FROM compiled_pages WHERE stale = 1`).get() as any).c;
      return stale > 5 ? `${stale} wiki pages stale — compilation may be broken` : null;
    },
  },
];

export async function runHealthCheck(db: Database.Database): Promise<{ criticals: string[]; warnings: string[] }> {
  const now = Date.now();
  const criticals: string[] = [];
  const warnings: string[] = [];

  // Check data sources
  const sources = db.prepare(
    `SELECT source, MAX(source_date) as last_date, COUNT(*) as total
     FROM knowledge
     WHERE source IN (${Object.keys(THRESHOLDS).map(s => `'${s}'`).join(',')})
     GROUP BY source`
  ).all() as any[];

  for (const [source, threshold] of Object.entries(THRESHOLDS)) {
    const data = sources.find(s => s.source === source);
    const lastDate = data?.last_date || null;
    const ageHours = lastDate ? (now - new Date(lastDate).getTime()) / 3600000 : 9999;

    if (ageHours > threshold.critical || !data) {
      const age = ageHours > 9000 ? 'never synced' : ageHours < 24 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;
      criticals.push(`${threshold.label}: ${age} stale`);
    } else if (ageHours > threshold.warn) {
      const age = ageHours < 24 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;
      warnings.push(`${threshold.label}: ${age}`);
    }
  }

  // Check infrastructure
  for (const check of INFRA_CHECKS) {
    try {
      const error = check.check(db);
      if (error) criticals.push(error);
    } catch {}
  }

  // Check team member sync
  try {
    const teamMembers = db.prepare(
      "SELECT name, email FROM team_members WHERE active = 1 AND sync_gmail = 1 AND relationship_to_ceo != 'self'"
    ).all() as any[];
    for (const m of teamMembers) {
      const last = db.prepare(
        `SELECT MAX(source_date) as last FROM knowledge WHERE source = 'gmail' AND source_account = ?`
      ).get(m.email) as any;
      const ageH = last?.last ? (now - new Date(last.last).getTime()) / 3600000 : 9999;
      if (ageH > 24) {
        warnings.push(`${m.name} gmail: ${ageH > 9000 ? 'never synced' : Math.round(ageH / 24) + 'd stale'}`);
      }
    }
  } catch {}

  // Store alert for Quinn
  if (criticals.length > 0 || warnings.length > 0) {
    db.prepare(
      `INSERT OR REPLACE INTO graph_state (key, value, updated_at)
       VALUES ('source_health_alert', ?, datetime('now'))`
    ).run(JSON.stringify({
      timestamp: new Date().toISOString(),
      criticals,
      warnings,
      summary: `${criticals.length} critical, ${warnings.length} warning`,
    }));

    // Send iMessage alert for critical issues
    if (criticals.length > 0) {
      try {
        const msg = `⚠️ Prime Alert: ${criticals.join('; ')}`;
        execSync(
          `osascript -e 'tell application "Messages" to send "${msg.replace(/"/g, '\\"').replace(/'/g, "'\\''")}" to participant "zach.stock@recaptureinsurance.com"'`,
          { timeout: 10000 }
        );
      } catch {} // iMessage may not be available — non-fatal
    }
  } else {
    db.prepare("DELETE FROM graph_state WHERE key = 'source_health_alert'").run();
  }

  return { criticals, warnings };
}
