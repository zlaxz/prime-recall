import { getDb, saveDb, getConfig } from './db.js';
import { syncAll } from './connectors/index.js';

/**
 * Background scheduler — runs sync on an interval.
 * Used by `prime serve --sync` to keep knowledge base fresh.
 */
export async function startScheduler(intervalMinutes: number = 15) {
  console.log(`  ⏰ Background sync every ${intervalMinutes} minutes`);

  const run = async () => {
    const db = await getDb();
    const timestamp = new Date().toISOString().slice(0, 19);

    try {
      const results = await syncAll(db);
      const total = results.reduce((sum, r) => sum + r.items, 0);
      if (total > 0) {
        console.log(`  [${timestamp}] Synced: ${results.map(r => `${r.source}=${r.items}`).join(', ')}`);
      }
    } catch (err: any) {
      console.error(`  [${timestamp}] Sync error: ${err.message}`);
    }
  };

  // Run immediately
  await run();

  // Then on interval
  setInterval(run, intervalMinutes * 60 * 1000);
}
