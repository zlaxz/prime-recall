import type Database from 'better-sqlite3';

/**
 * Source Health Monitor — checks all ingestion sources for staleness.
 * Called by the shift daemon every 4 hours. Stores alerts in graph_state
 * so Quinn sees them in the next intelligence cycle.
 */

const THRESHOLDS: Record<string, { warn: number; critical: number; label: string }> = {
  'gmail':         { warn: 12,  critical: 24,  label: 'Gmail inbox (Zach)' },
  'gmail-sent':    { warn: 24,  critical: 72,  label: 'Gmail sent' },
  'calendar':      { warn: 24,  critical: 48,  label: 'Google Calendar' },
  'claude':        { warn: 12,  critical: 24,  label: 'Claude.ai conversations' },
  'cowork':        { warn: 24,  critical: 72,  label: 'Cowork sessions' },
  'fireflies':     { warn: 168, critical: 336, label: 'Fireflies transcripts' },
  'user-feedback': { warn: 48,  critical: 168, label: 'User feedback (Quinn chat)' },
};

export async function runHealthCheck(db: Database.Database): Promise<{ criticals: string[]; warnings: string[] }> {
  const now = Date.now();
  const criticals: string[] = [];
  const warnings: string[] = [];

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
      const age = ageHours < 24 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;
      criticals.push(`${threshold.label}: ${age} stale`);
    } else if (ageHours > threshold.warn) {
      const age = ageHours < 24 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;
      warnings.push(`${threshold.label}: ${age} stale`);
    }
  }

  // Check service account (team member sync depends on it)
  const saConfig = db.prepare("SELECT value FROM config WHERE key = 'gmail_service_account'").get() as any;
  if (!saConfig?.value) {
    criticals.push('Service account missing — team member email sync disabled');
  }

  // Store alert for Quinn to see
  if (criticals.length > 0) {
    db.prepare(
      `INSERT OR REPLACE INTO graph_state (key, value, updated_at)
       VALUES ('source_health_alert', ?, datetime('now'))`
    ).run(JSON.stringify({
      timestamp: new Date().toISOString(),
      criticals,
      warnings,
      summary: `${criticals.length} critical, ${warnings.length} warning`,
    }));
  } else {
    // Clear previous alerts
    db.prepare("DELETE FROM graph_state WHERE key = 'source_health_alert'").run();
  }

  return { criticals, warnings };
}
