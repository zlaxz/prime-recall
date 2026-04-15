#!/usr/bin/env npx tsx
/**
 * Source Health Monitor — keepalive check for all Prime ingestion sources.
 *
 * Run manually: npx tsx scripts/source-health-monitor.ts
 * Run via cron:  Add to launchd or shift daemon
 *
 * Checks each source against its expected freshness window.
 * Sends iMessage alert if any critical source goes stale.
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';

const db = new Database(process.env.HOME + '/.prime/prime.db');

// Expected freshness per source (hours)
// If a source hasn't had new data in this many hours, it's considered stale
const FRESHNESS_THRESHOLDS: Record<string, { warn: number; critical: number; label: string }> = {
  'gmail':           { warn: 12,  critical: 24,  label: 'Gmail inbox (Zach)' },
  'gmail-sent':      { warn: 24,  critical: 72,  label: 'Gmail sent' },
  'calendar':        { warn: 24,  critical: 48,  label: 'Google Calendar' },
  'claude':          { warn: 12,  critical: 24,  label: 'Claude.ai conversations' },
  'cowork':          { warn: 24,  critical: 72,  label: 'Cowork sessions' },
  'fireflies':       { warn: 168, critical: 336, label: 'Fireflies transcripts' },
  'user-feedback':   { warn: 48,  critical: 168, label: 'User feedback (Quinn chat)' },
};

interface SourceHealth {
  source: string;
  label: string;
  lastDate: string | null;
  ageHours: number;
  itemCount: number;
  status: 'ok' | 'warn' | 'critical' | 'dead';
}

// Check each source
const sources = db.prepare(
  `SELECT source, MAX(source_date) as last_date, COUNT(*) as total
   FROM knowledge
   WHERE source IN (${Object.keys(FRESHNESS_THRESHOLDS).map(s => `'${s}'`).join(',')})
   GROUP BY source`
).all() as any[];

const now = Date.now();
const results: SourceHealth[] = [];

// Check configured sources
for (const [source, threshold] of Object.entries(FRESHNESS_THRESHOLDS)) {
  const data = sources.find(s => s.source === source);
  const lastDate = data?.last_date || null;
  const ageHours = lastDate ? (now - new Date(lastDate).getTime()) / 3600000 : 9999;
  const itemCount = data?.total || 0;

  let status: SourceHealth['status'] = 'ok';
  if (ageHours > threshold.critical) status = 'critical';
  else if (ageHours > threshold.warn) status = 'warn';
  if (itemCount === 0) status = 'dead';

  results.push({ source, label: threshold.label, lastDate, ageHours: Math.round(ageHours), itemCount, status });
}

// Also check dream pipeline and shift daemon
const lastDream = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_run'").get() as any)?.value;
const dreamAge = lastDream ? Math.round((now - new Date(lastDream).getTime()) / 3600000) : 9999;

// Also check service account for team member sync
const saConfig = db.prepare("SELECT value FROM config WHERE key = 'gmail_service_account'").get() as any;
const hasSA = !!saConfig?.value;

// Report
const icons: Record<string, string> = { ok: '✓', warn: '⚠', critical: '✗', dead: '💀' };

console.log('=== PRIME SOURCE HEALTH MONITOR ===');
console.log(`Run: ${new Date().toISOString()}\n`);

let criticals: string[] = [];

for (const r of results.sort((a, b) => b.ageHours - a.ageHours)) {
  const icon = icons[r.status];
  const age = r.ageHours < 24 ? `${r.ageHours}h` : `${Math.round(r.ageHours / 24)}d`;
  console.log(`${icon} ${r.label.padEnd(30)} Last: ${(r.lastDate || 'never').slice(0, 16).padEnd(18)} Age: ${age.padEnd(6)} Items: ${r.itemCount}`);

  if (r.status === 'critical' || r.status === 'dead') {
    criticals.push(`${r.label}: ${age} stale (${r.itemCount} items)`);
  }
}

console.log(`\n${icons[dreamAge > 8 ? 'critical' : dreamAge > 4 ? 'warn' : 'ok']} Dream pipeline              Last: ${(lastDream || 'never').slice(0, 16).padEnd(18)} Age: ${dreamAge}h`);
console.log(`${hasSA ? '✓' : '✗'} Service account (team sync)  ${hasSA ? 'Configured' : 'NOT CONFIGURED — Forrest sync broken'}`);

if (dreamAge > 8) criticals.push(`Dream pipeline: ${dreamAge}h since last run`);
if (!hasSA) criticals.push('Service account missing — team member sync disabled');

// Alert if criticals found
if (criticals.length > 0) {
  console.log(`\n🚨 ${criticals.length} CRITICAL ISSUES:\n`);
  for (const c of criticals) console.log(`  - ${c}`);

  // Store alert in graph_state for Quinn to see
  db.prepare(
    `INSERT OR REPLACE INTO graph_state (key, value, updated_at)
     VALUES ('source_health_alert', ?, datetime('now'))`
  ).run(JSON.stringify({
    timestamp: new Date().toISOString(),
    criticals,
    summary: `${criticals.length} ingestion sources are stale or broken`,
  }));

  // Optionally send iMessage
  if (process.argv.includes('--notify')) {
    try {
      const msg = `⚠️ Prime Source Alert: ${criticals.join('; ')}`;
      execSync(`osascript -e 'tell application "Messages" to send "${msg.replace(/"/g, '\\"')}" to participant "zach.stock@recaptureinsurance.com"'`, { timeout: 10000 });
      console.log('\n📱 iMessage alert sent');
    } catch {
      console.log('\n⚠ iMessage alert failed (not on Mac Mini GUI session?)');
    }
  }
} else {
  console.log('\n✓ All sources healthy');
  // Clear any previous alert
  db.prepare("DELETE FROM graph_state WHERE key = 'source_health_alert'").run();
}

db.close();
