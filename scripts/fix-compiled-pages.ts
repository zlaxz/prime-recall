import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// 1. Find and remove duplicate/stub compiled pages
console.log('=== COMPILED PAGE CLEANUP ===\n');

const allPages = db.prepare(`
  SELECT page_type, subject_id, length(content) as content_len, compiled_at, rowid
  FROM compiled_pages ORDER BY page_type, subject_id
`).all() as any[];

console.log(`Total pages: ${allPages.length}\n`);

// Group by normalized subject_id (lowercase)
const groups = new Map<string, typeof allPages>();
for (const p of allPages) {
  const key = `${p.page_type}:${p.subject_id.toLowerCase().trim()}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(p);
}

let deleted = 0;
let stubs = 0;

for (const [key, pages] of groups) {
  if (pages.length > 1) {
    // Multiple pages for same entity — keep the longest, delete the rest
    pages.sort((a, b) => b.content_len - a.content_len);
    const keep = pages[0];
    console.log(`DUPLICATE: ${key}`);
    console.log(`  KEEP: "${keep.subject_id}" (${keep.content_len} chars, ${keep.compiled_at})`);
    for (const dup of pages.slice(1)) {
      console.log(`  DELETE: "${dup.subject_id}" (${dup.content_len} chars)`);
      db.prepare('DELETE FROM compiled_pages WHERE page_type = ? AND subject_id = ?').run(dup.page_type, dup.subject_id);
      deleted++;
    }
  }

  // Check for stubs (< 100 chars)
  for (const p of pages) {
    if (p.content_len < 100) {
      console.log(`STUB: ${p.page_type}:${p.subject_id} (${p.content_len} chars) — deleting`);
      db.prepare('DELETE FROM compiled_pages WHERE page_type = ? AND subject_id = ?').run(p.page_type, p.subject_id);
      stubs++;
    }
  }
}

console.log(`\nDeleted ${deleted} duplicates, ${stubs} stubs`);

// 2. Show what remains
console.log('\n=== REMAINING PAGES ===\n');
const remaining = db.prepare(`
  SELECT page_type, subject_id, length(content) as content_len, compiled_at
  FROM compiled_pages ORDER BY page_type, compiled_at DESC
`).all() as any[];

for (const p of remaining) {
  const age = Math.round((Date.now() - new Date(p.compiled_at).getTime()) / 3600000);
  const status = age < 24 ? '✓' : age < 72 ? '⚠' : '✗';
  console.log(`${status} ${p.page_type}:${p.subject_id}`.padEnd(45) + `${p.content_len} chars`.padStart(12) + `  ${age}h ago`);
}

db.close();
