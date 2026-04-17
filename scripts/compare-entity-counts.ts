import Database from 'better-sqlite3';

const backup = new Database(process.env.HOME + '/.prime/prime.db.bak-dedup-20260415130646');
const current = new Database(process.env.HOME + '/.prime/prime.db');

console.log('=== BACKUP (pre-session) ===');
const bEntities = (backup.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c;
const bAliases = (backup.prepare('SELECT COUNT(*) as c FROM entity_aliases').get() as any).c;
const bMentions = (backup.prepare('SELECT COUNT(*) as c FROM entity_mentions').get() as any).c;
const bKnowledge = (backup.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any).c;
console.log(`  Entities: ${bEntities}`);
console.log(`  Aliases: ${bAliases}`);
console.log(`  Mentions: ${bMentions}`);
console.log(`  Knowledge: ${bKnowledge}`);

const bVersions = backup.prepare(`
  SELECT extraction_version as v, COUNT(*) as c FROM knowledge WHERE source = 'gmail' GROUP BY v ORDER BY v
`).all() as any[];
console.log('  Gmail by version:', bVersions.map(v => `v${v.v||'null'}:${v.c}`).join(', '));

console.log('\n=== CURRENT ===');
const cEntities = (current.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c;
const cAliases = (current.prepare('SELECT COUNT(*) as c FROM entity_aliases').get() as any).c;
const cMentions = (current.prepare('SELECT COUNT(*) as c FROM entity_mentions').get() as any).c;
const cKnowledge = (current.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any).c;
console.log(`  Entities: ${cEntities}`);
console.log(`  Aliases: ${cAliases}`);
console.log(`  Mentions: ${cMentions}`);
console.log(`  Knowledge: ${cKnowledge}`);

const cVersions = current.prepare(`
  SELECT extraction_version as v, COUNT(*) as c FROM knowledge WHERE source = 'gmail' GROUP BY v ORDER BY v
`).all() as any[];
console.log('  Gmail by version:', cVersions.map(v => `v${v.v||'null'}:${v.c}`).join(', '));

console.log('\n=== DIFF ===');
console.log(`  Entities: ${cEntities - bEntities} (${cEntities < bEntities ? 'LOST' : 'gained'})`);
console.log(`  Aliases: ${cAliases - bAliases}`);
console.log(`  Mentions: ${cMentions - bMentions}`);
console.log(`  Knowledge: ${cKnowledge - bKnowledge}`);

backup.close();
current.close();
