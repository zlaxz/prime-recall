import Database from "better-sqlite3";
const db = new Database(process.env.HOME + "/.prime/prime.db");

const recent = db.prepare("SELECT title, source_date FROM knowledge WHERE source = 'gmail' ORDER BY source_date DESC LIMIT 5").all() as any[];
console.log("Most recent gmail items:");
for (const r of recent) console.log(" ", r.source_date, (r.title || "").slice(0,80));

const counts = db.prepare("SELECT date(source_date) as d, count(*) as c FROM knowledge WHERE source = 'gmail' AND source_date >= datetime('now', '-14 days') GROUP BY d ORDER BY d DESC").all() as any[];
console.log("\nGmail items by day (last 14d):");
for (const c of counts) console.log(" ", c.d, c.c);

const forrest = db.prepare("SELECT count(*) as c FROM knowledge WHERE source = 'gmail' AND source_date >= datetime('now', '-7 days') AND (title LIKE '%forrest%' OR summary LIKE '%forrest%')").get() as any;
console.log("\nForrest mentions (gmail, last 7d):", forrest.c);

db.close();
