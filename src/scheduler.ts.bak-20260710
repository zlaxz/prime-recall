import { getDb, getConfig } from './db.js';
import { syncAll } from './connectors/index.js';
import { runEscalationCheck } from './escalation.js';

/**
 * Background scheduler — runs sync + escalation check on an interval.
 * Used by `prime serve --sync` to keep knowledge base fresh
 * and staged actions escalating on schedule.
 */
export async function startScheduler(intervalMinutes: number = 15) {
  console.log(`  ⏰ Background sync + escalation every ${intervalMinutes} minutes`);

  const run = async () => {
    const db = getDb();
    const timestamp = new Date().toISOString().slice(0, 19);

    // ── Sync all connected sources ──
    try {
      const results = await syncAll(db);
      const total = results.reduce((sum, r) => sum + r.items, 0);
      if (total > 0) {
        console.log(`  [${timestamp}] Synced: ${results.map(r => `${r.source}=${r.items}`).join(', ')}`);
      }
    } catch (err: any) {
      console.error(`  [${timestamp}] Sync error: ${err.message}`);
    }

    // ── Escalation check on pending staged actions ──
    try {
      const esc = await runEscalationCheck(db);
      if (esc.escalated > 0 || esc.autoExecuted > 0) {
        console.log(`  [${timestamp}] Escalation: ${esc.escalated} escalated, ${esc.autoExecuted} auto-executed`);
      }
      if (esc.errors.length > 0) {
        console.error(`  [${timestamp}] Escalation errors: ${esc.errors.join('; ')}`);
      }
    } catch (err: any) {
      console.error(`  [${timestamp}] Escalation error: ${err.message}`);
    }
  };

  // Run immediately
  await run();

  // Then on interval
  setInterval(run, intervalMinutes * 60 * 1000);
}
