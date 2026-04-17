import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const sources = db.prepare(`
  SELECT source, COUNT(*) as c FROM knowledge
  WHERE title LIKE '%Luke Porter%' OR summary LIKE '%Luke Porter%' OR contacts LIKE '%Luke Porter%'
  GROUP BY source ORDER BY c DESC
`).all() as any[];
console.log('Luke Porter by source:', sources);

// Also check entity_mentions
const mentions = db.prepare(`
  SELECT k.source, COUNT(*) as c
  FROM entity_mentions em
  JOIN entities e ON em.entity_id = e.id
  JOIN knowledge k ON em.knowledge_item_id = k.id
  WHERE e.canonical_name = 'Luke Porter'
  GROUP BY k.source ORDER BY c DESC
`).all() as any[];
console.log('Luke Porter mentions by source:', mentions);

// Sample non-gmail items
const nonGmail = db.prepare(`
  SELECT k.source, k.title, k.source_date
  FROM entity_mentions em
  JOIN entities e ON em.entity_id = e.id
  JOIN knowledge k ON em.knowledge_item_id = k.id
  WHERE e.canonical_name = 'Luke Porter' AND k.source != 'gmail'
  ORDER BY k.source_date DESC LIMIT 5
`).all() as any[];
console.log('\nLuke Porter non-gmail items:');
for (const n of nonGmail) console.log(`  [${n.source}] ${n.source_date?.slice(0,10)} ${n.title?.slice(0,60)}`);

db.close();
