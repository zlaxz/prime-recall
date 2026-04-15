import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

const forrest = db.prepare(
  `SELECT alias, source FROM entity_aliases WHERE alias_normalized LIKE '%forrest%' OR alias_normalized LIKE '%fsp%' OR alias LIKE '%forrest@%'`
).all();
console.log('Forrest aliases:', forrest);

const sources = db.prepare(
  `SELECT source, COUNT(*) as c FROM entity_aliases GROUP BY source`
).all();
console.log('\nAlias sources:', sources);

// Check if email addresses are in aliases
const emailAliases = db.prepare(
  `SELECT COUNT(*) as c FROM entity_aliases WHERE alias LIKE '%@%'`
).get() as any;
console.log('\nEmail aliases:', emailAliases.c);

db.close();
