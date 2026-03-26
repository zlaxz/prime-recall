import type { Database as SqlJsDatabase } from 'sql.js';
import { scanGmail } from './gmail.js';
import { scanCalendar } from './calendar.js';
import { scanClaude } from './claude.js';
import { getConfig } from '../db.js';

export interface SyncResult {
  source: string;
  items: number;
  error?: string;
}

export async function syncAll(db: SqlJsDatabase): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Gmail
  const gmailTokens = getConfig(db, 'gmail_tokens');
  if (gmailTokens) {
    try {
      const { items } = await scanGmail(db, { days: 7, maxThreads: 50 });
      results.push({ source: 'gmail', items });
    } catch (err: any) {
      results.push({ source: 'gmail', items: 0, error: err.message });
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

  return results;
}
