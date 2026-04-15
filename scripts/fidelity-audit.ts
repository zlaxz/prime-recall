/**
 * Information Fidelity Audit — checks every stage of Prime's pipeline
 * for data loss, distortion, staleness, and quality issues.
 *
 * Research shows LLMs hallucinate 15-52% in structured extraction tasks.
 * If Prime's extraction has even 15% error rate, that's ~1000 bad items
 * feeding Quinn's intelligence.
 */

import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

console.log('╔══════════════════════════════════════════╗');
console.log('║   PRIME INFORMATION FIDELITY AUDIT       ║');
console.log('╚══════════════════════════════════════════╝\n');

// ═══════════════════════════════════════════
// 1. EXTRACTION QUALITY — Are index cards accurate?
// ═══════════════════════════════════════════
console.log('═══ 1. EXTRACTION QUALITY ═══\n');

// Check for generic/templated titles (sign of failed extraction)
const genericTitles = db.prepare(`
  SELECT COUNT(*) as c FROM knowledge
  WHERE title LIKE 'Email thread:%' OR title LIKE 'Email:%' OR title = '[NOISE]'
`).get() as any;
const totalItems = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any).c;
console.log(`Generic/template titles: ${genericTitles.c}/${totalItems} (${Math.round(genericTitles.c/totalItems*100)}%)`);
console.log('  (These items have extraction that only got the raw thread format, not a real title)\n');

// Check for duplicate titles (extraction producing same output for different emails)
const dupTitles = db.prepare(`
  SELECT title, COUNT(*) as c FROM knowledge
  WHERE source IN ('gmail', 'gmail-sent')
  GROUP BY title HAVING c > 1
  ORDER BY c DESC LIMIT 10
`).all() as any[];
console.log(`Top duplicate titles (same extraction for different emails):`);
for (const d of dupTitles) {
  console.log(`  ${d.c}x: "${d.title.slice(0, 70)}"`);
}

// Check for empty/missing fields
const missingContacts = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND (contacts IS NULL OR contacts = '[]')`).get() as any).c;
const missingProject = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail' AND project IS NULL`).get() as any).c;
const gmailTotal = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE source = 'gmail'`).get() as any).c;
console.log(`\nGmail items missing contacts: ${missingContacts}/${gmailTotal} (${Math.round(missingContacts/gmailTotal*100)}%)`);
console.log(`Gmail items missing project:  ${missingProject}/${gmailTotal} (${Math.round(missingProject/gmailTotal*100)}%)`);

// Check extraction version distribution
const versions = db.prepare(`
  SELECT extraction_version as v, COUNT(*) as c,
    ROUND(AVG(length(summary))) as avg_sum,
    ROUND(AVG(length(COALESCE(contacts, '[]')))) as avg_contacts
  FROM knowledge WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY v
`).all() as any[];
console.log('\nExtraction version quality:');
for (const v of versions) {
  console.log(`  v${v.v || 'null'}: ${v.c} items, avg summary: ${v.avg_sum} chars, avg contacts field: ${v.avg_contacts} chars`);
}

// ═══════════════════════════════════════════
// 2. ENTITY RESOLUTION — Are people correctly identified?
// ═══════════════════════════════════════════
console.log('\n═══ 2. ENTITY RESOLUTION ═══\n');

// Check for entities with very few aliases (might be missing)
const lowAlias = db.prepare(`
  SELECT e.canonical_name, COUNT(ea.id) as alias_count
  FROM entities e LEFT JOIN entity_aliases ea ON e.id = ea.entity_id
  GROUP BY e.id
  HAVING alias_count <= 1
  LIMIT 10
`).all() as any[];
console.log('Entities with ≤1 alias (likely missing aliases):');
for (const e of lowAlias) {
  console.log(`  "${e.canonical_name}" — ${e.alias_count} alias(es)`);
}

// Check for potential duplicates (similar canonical names)
const allEntities = db.prepare(`
  SELECT canonical_name FROM entities ORDER BY canonical_name
`).all() as any[];
console.log('\nPotential duplicate entities (check manually):');
const seen = new Map<string, string>();
for (const e of allEntities) {
  const key = (e.canonical_name as string).toLowerCase().split(' ')[0]; // first name
  if (seen.has(key) && seen.get(key) !== e.canonical_name) {
    console.log(`  "${seen.get(key)}" vs "${e.canonical_name}"`);
  }
  seen.set(key, e.canonical_name);
}

// ═══════════════════════════════════════════
// 3. COMPILED PAGES — Is the wiki accurate?
// ═══════════════════════════════════════════
console.log('\n═══ 3. COMPILED WIKI PAGES ═══\n');

const pages = db.prepare(`
  SELECT page_type, subject_id, length(content) as len, compiled_at, stale,
    source_item_count, version
  FROM compiled_pages ORDER BY compiled_at DESC
`).all() as any[];

for (const p of pages) {
  const ageH = Math.round((Date.now() - new Date(p.compiled_at).getTime()) / 3600000);
  const status = p.stale ? '🔴 STALE' : ageH > 72 ? '🟡 OLD' : '🟢 FRESH';
  console.log(`${status} ${p.page_type}:${p.subject_id}`.padEnd(50) +
    `${p.len} chars  v${p.version}  ${p.source_item_count || '?'} sources  ${ageH}h ago`);
}

// ═══════════════════════════════════════════
// 4. COMMITMENT TRACKING — Are commitments real?
// ═══════════════════════════════════════════
console.log('\n═══ 4. COMMITMENT TRACKING ═══\n');

const commitStates = db.prepare(`
  SELECT state, COUNT(*) as c FROM commitments GROUP BY state ORDER BY c DESC
`).all() as any[];
console.log('Commitment states:');
for (const s of commitStates) console.log(`  ${s.state}: ${s.c}`);

const overdueCount = (db.prepare(`
  SELECT COUNT(*) as c FROM commitments
  WHERE state = 'overdue' OR (state = 'active' AND due_date < datetime('now'))
`).get() as any).c;
console.log(`\nOverdue/past-due: ${overdueCount}`);

// Check for ancient commitments that should have been resolved
const ancientCommitments = db.prepare(`
  SELECT text, owner, due_date, state FROM commitments
  WHERE state IN ('active', 'overdue') AND created_at < datetime('now', '-30 days')
  ORDER BY created_at ASC LIMIT 5
`).all() as any[];
if (ancientCommitments.length > 0) {
  console.log('\nAncient unresolved commitments (>30 days):');
  for (const c of ancientCommitments) {
    console.log(`  [${c.state}] "${(c.text || '').slice(0, 60)}" — ${c.owner || 'no owner'} (due: ${c.due_date || 'no date'})`);
  }
}

// ═══════════════════════════════════════════
// 5. SOURCE FRESHNESS — What's stale?
// ═══════════════════════════════════════════
console.log('\n═══ 5. SOURCE FRESHNESS ═══\n');

const freshness = db.prepare(`
  SELECT source,
    COUNT(*) as total,
    SUM(CASE WHEN source_date >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
    SUM(CASE WHEN source_date >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as last_24h,
    MAX(source_date) as newest
  FROM knowledge
  WHERE source IN ('gmail', 'gmail-sent', 'calendar', 'claude', 'cowork', 'fireflies')
  GROUP BY source ORDER BY newest DESC
`).all() as any[];

console.log('Source'.padEnd(15) + 'Total'.padStart(7) + 'Last7d'.padStart(8) + 'Last24h'.padStart(9) + '  Newest');
for (const f of freshness) {
  console.log(
    (f.source || '').padEnd(15) +
    String(f.total).padStart(7) +
    String(f.last_7d).padStart(8) +
    String(f.last_24h).padStart(9) +
    `  ${(f.newest || 'never').slice(0, 16)}`
  );
}

// ═══════════════════════════════════════════
// 6. INTELLIGENCE OUTPUT — Is Quinn's brief grounded?
// ═══════════════════════════════════════════
console.log('\n═══ 6. INTELLIGENCE OUTPUT ═══\n');

const brief = (db.prepare("SELECT value, updated_at FROM graph_state WHERE key = 'intelligence_brief'").get() as any);
if (brief) {
  const b = JSON.parse(brief.value);
  const ageH = Math.round((Date.now() - new Date(brief.updated_at).getTime()) / 3600000);
  console.log(`Brief age: ${ageH}h`);
  console.log(`Headline: ${b.headline || 'NONE'}`);
  console.log(`The One Thing: ${b.the_one_thing || 'NONE'}`);
  console.log(`Hypotheses: ${(b.hypotheses || []).length}`);
  console.log(`Actions: ${(b.actions || []).length}`);
  console.log(`Weak signals: ${(b.weak_signals || []).length}`);
  console.log(`Contradictions: ${(b.contradictions || []).length}`);

  // Check if actions reference real entities
  console.log('\nAction groundedness:');
  for (const a of (b.actions || [])) {
    const person = a.target_person || 'no person';
    // Check if this person exists in entities
    const entityExists = db.prepare(
      `SELECT COUNT(*) as c FROM entity_aliases WHERE alias_normalized LIKE ?`
    ).get(`%${person.split(' ')[0].toLowerCase()}%`) as any;
    const grounded = entityExists.c > 0 ? '✓' : '?';
    console.log(`  ${grounded} [${a.lens}] ${a.title?.slice(0, 50)} — ${person}`);
  }
}

// ═══════════════════════════════════════════
// 7. GAPS — What should be ingested but isn't?
// ═══════════════════════════════════════════
console.log('\n═══ 7. COVERAGE GAPS ═══\n');

// Check for team members whose email isn't being synced
const teamGaps = db.prepare(`
  SELECT tm.name, tm.email, tm.sync_gmail,
    (SELECT COUNT(*) FROM knowledge WHERE source_account = tm.email AND source = 'gmail') as gmail_count,
    (SELECT MAX(source_date) FROM knowledge WHERE source_account = tm.email AND source = 'gmail') as last_gmail
  FROM team_members tm WHERE tm.active = 1
`).all() as any[];
console.log('Team member email coverage:');
for (const t of teamGaps) {
  const age = t.last_gmail ? Math.round((Date.now() - new Date(t.last_gmail).getTime()) / 86400000) : 999;
  const status = age < 2 ? '✓' : age < 7 ? '⚠' : '✗';
  console.log(`  ${status} ${t.name} (${t.email}): ${t.gmail_count} items, last: ${t.last_gmail?.slice(0, 10) || 'never'} (${age}d ago)`);
}

// Check calendar coverage
const calendarGap = db.prepare(`
  SELECT COUNT(*) as c FROM knowledge
  WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+7 days')
`).get() as any;
console.log(`\nUpcoming calendar events (next 7 days): ${calendarGap.c}`);

// ═══════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║   AUDIT SUMMARY                          ║');
console.log('╚══════════════════════════════════════════╝\n');

const issues: string[] = [];
if (genericTitles.c > totalItems * 0.1) issues.push(`${Math.round(genericTitles.c/totalItems*100)}% of items have generic titles (bad extraction)`);
if (missingContacts > gmailTotal * 0.3) issues.push(`${Math.round(missingContacts/gmailTotal*100)}% of gmail items missing contacts`);
if (missingProject > gmailTotal * 0.5) issues.push(`${Math.round(missingProject/gmailTotal*100)}% of gmail items missing project assignment`);
if (dupTitles.length > 5) issues.push(`${dupTitles.length} duplicate title patterns (extraction producing identical output)`);

for (const p of pages) {
  const ageH = Math.round((Date.now() - new Date(p.compiled_at).getTime()) / 3600000);
  if (ageH > 72) issues.push(`Wiki page ${p.page_type}:${p.subject_id} is ${Math.round(ageH/24)}d stale`);
}

if (overdueCount > 10) issues.push(`${overdueCount} overdue commitments — many may be resolved but not tracked`);

if (issues.length === 0) {
  console.log('✓ No critical issues found');
} else {
  console.log(`🚨 ${issues.length} issues found:\n`);
  for (const i of issues) console.log(`  • ${i}`);
}

db.close();
