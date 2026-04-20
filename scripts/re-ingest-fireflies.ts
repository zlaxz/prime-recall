import { getDb } from "../src/db.js";
import { scanFireflies } from "../src/connectors/fireflies.js";

async function main() {
  const db = getDb();
  // Clear sync state to force re-scan
  db.prepare("DELETE FROM sync_state WHERE source = 'fireflies'").run();
  // Delete existing Fireflies items to force re-ingest
  db.prepare("DELETE FROM knowledge WHERE source = 'fireflies' AND source_date > '2026-04-08'").run();
  console.log("Cleared old Fireflies data. Re-ingesting...");
  const r = await scanFireflies(db);
  console.log(JSON.stringify(r, null, 2));
  const row = db.prepare("SELECT title, length(raw_content) as raw_len FROM knowledge WHERE source = 'fireflies' AND source_date > '2026-04-08'").all();
  console.log("Results:", row);
  db.close();
}
main().catch(console.error);
