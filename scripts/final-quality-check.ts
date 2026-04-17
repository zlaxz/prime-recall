import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('=== FINAL QUALITY CHECK ===\n');

// Extraction versions
const versions = db.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    ROUND(AVG(length(summary))) as avg_sum,
    SUM(CASE WHEN contacts IS NULL OR contacts = '[]' OR length(contacts) < 5 THEN 1 ELSE 0 END) as missing_contacts,
    SUM(CASE WHEN title LIKE 'Email thread:%' THEN 1 ELSE 0 END) as generic_titles
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];

console.log('Version  Count  AvgSummary  MissingContacts  GenericTitles');
for (const s of versions) {
  console.log(
    `v${s.v || 'null'}`.padEnd(9) +
    String(s.c).padStart(5) +
    String(s.avg_sum).padStart(12) +
    `  ${s.missing_contacts} (${Math.round(s.missing_contacts/s.c*100)}%)`.padStart(18) +
    `  ${s.generic_titles} (${Math.round(s.generic_titles/s.c*100)}%)`.padStart(16)
  );
}

// Overall
const total = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail'`).get() as any;
const totalMissing = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND (contacts IS NULL OR contacts = '[]' OR length(contacts) < 5)`).get() as any;
const totalGeneric = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND title LIKE 'Email thread:%'`).get() as any;
console.log(`\nOverall: ${totalMissing.c}/${total.c} missing contacts (${Math.round(totalMissing.c/total.c*100)}%), ${totalGeneric.c} generic titles (${Math.round(totalGeneric.c/total.c*100)}%)`);

// Wiki pages
const pages = db.prepare(`SELECT COUNT(*) as c FROM compiled_pages`).get() as any;
const stale = db.prepare(`SELECT COUNT(*) as c FROM compiled_pages WHERE stale = 1`).get() as any;
console.log(`\nWiki pages: ${pages.c} total, ${stale.c} stale`);

// Entities
const entities = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE user_dismissed = 0`).get() as any;
console.log(`Entities: ${entities.c}`);

// Source health
const sources = db.prepare(`
  SELECT source, MAX(source_date) as last, COUNT(*) as c
  FROM knowledge
  WHERE source IN ('gmail', 'gmail-sent', 'calendar', 'claude', 'cowork', 'fireflies')
  GROUP BY source ORDER BY last DESC
`).all() as any[];
console.log('\nSource freshness:');
for (const s of sources) {
  const ageH = Math.round((Date.now() - new Date(s.last).getTime()) / 3600000);
  console.log(`  ${(s.source || '').padEnd(12)} ${ageH}h ago  (${s.c} items)`);
}

// DB size
const { statSync } = await import('fs');
const size = statSync(process.env.HOME + '/.prime/prime.db').size;
console.log(`\nDB size: ${Math.round(size / 1024 / 1024)}MB`);

db.close();
