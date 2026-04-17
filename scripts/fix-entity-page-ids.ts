import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// Find entity pages with UUID subject_ids and convert to slugified names
const entityPages = db.prepare(`
  SELECT subject_id, subject_name, content, version FROM compiled_pages
  WHERE page_type = 'entity' AND subject_id LIKE '%-%-%-%-%'
`).all() as any[];

console.log(`Found ${entityPages.length} entity pages with UUID subject_ids\n`);

for (const p of entityPages) {
  const slug = (p.subject_name || p.subject_id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  console.log(`  ${p.subject_id.slice(0, 8)}... → ${slug} (${p.subject_name})`);

  // Check if slug already exists
  const existing = db.prepare(`SELECT subject_id FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?`).get(slug);
  if (existing) {
    // Delete the UUID version, keep the slug version
    db.prepare(`DELETE FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?`).run(p.subject_id);
  } else {
    // Rename UUID to slug
    db.prepare(`UPDATE compiled_pages SET subject_id = ? WHERE page_type = 'entity' AND subject_id = ?`).run(slug, p.subject_id);
  }
}

// Verify
const after = db.prepare(`SELECT page_type, subject_id, subject_name FROM compiled_pages WHERE page_type = 'entity'`).all() as any[];
console.log(`\nEntity pages after fix:`);
for (const p of after) console.log(`  ${p.subject_id} — ${p.subject_name}`);

db.close();
