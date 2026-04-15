import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.prime/prime.db');

// 1. Raw content coverage by source
console.log('=== RAW CONTENT COVERAGE BY SOURCE ===\n');
const sources = db.prepare(`
  SELECT source,
    COUNT(*) as total,
    SUM(CASE WHEN raw_content IS NOT NULL AND length(raw_content) > 100 THEN 1 ELSE 0 END) as has_raw,
    ROUND(AVG(length(COALESCE(raw_content, '')))) as avg_raw_len,
    ROUND(AVG(length(summary))) as avg_summary_len
  FROM knowledge GROUP BY source ORDER BY total DESC
`).all() as any[];

console.log('Source'.padEnd(20) + 'Total'.padStart(6) + 'HasRaw'.padStart(8) + '  %'.padStart(5) + ' AvgRaw'.padStart(8) + ' AvgSum'.padStart(8));
for (const s of sources) {
  const pct = s.total > 0 ? Math.round(s.has_raw / s.total * 100) : 0;
  console.log(
    (s.source || 'null').padEnd(20) +
    String(s.total).padStart(6) +
    String(s.has_raw).padStart(8) +
    (pct + '%').padStart(5) +
    String(Math.round(s.avg_raw_len || 0)).padStart(8) +
    String(Math.round(s.avg_summary_len || 0)).padStart(8)
  );
}

// 2. Extraction quality — empty/short summaries
console.log('\n=== EXTRACTION QUALITY ===\n');
const emptySummary = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE length(summary) < 50`).get() as any;
const shortSummary = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE length(summary) BETWEEN 50 AND 100`).get() as any;
const goodSummary = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE length(summary) > 100`).get() as any;
const totalK = db.prepare(`SELECT COUNT(*) as c FROM knowledge`).get() as any;
console.log(`Empty/tiny summary (<50 chars): ${emptySummary.c} (${Math.round(emptySummary.c/totalK.c*100)}%)`);
console.log(`Short summary (50-100 chars):   ${shortSummary.c} (${Math.round(shortSummary.c/totalK.c*100)}%)`);
console.log(`Good summary (>100 chars):      ${goodSummary.c} (${Math.round(goodSummary.c/totalK.c*100)}%)`);

// 3. Compiled pages quality
console.log('\n=== COMPILED WIKI PAGES ===\n');
const pages = db.prepare(`
  SELECT page_type, subject_id, length(content) as content_len, compiled_at
  FROM compiled_pages ORDER BY compiled_at DESC LIMIT 15
`).all() as any[];
for (const p of pages) {
  const age = Math.round((Date.now() - new Date(p.compiled_at).getTime()) / 3600000);
  const status = age < 24 ? '✓' : age < 72 ? '⚠' : '✗';
  console.log(`${status} ${p.page_type}:${p.subject_id}`.padEnd(40) + `${p.content_len} chars`.padStart(12) + `  ${age}h ago`);
}

const emptyPages = db.prepare(`SELECT COUNT(*) as c FROM compiled_pages WHERE length(content) < 100`).get() as any;
const totalPages = db.prepare(`SELECT COUNT(*) as c FROM compiled_pages`).get() as any;
console.log(`\nEmpty/stub pages: ${emptyPages.c}/${totalPages.c}`);

// 4. Extraction version distribution
console.log('\n=== EXTRACTION VERSION ===\n');
const versions = db.prepare(`
  SELECT extraction_version, COUNT(*) as c FROM knowledge
  WHERE source = 'gmail'
  GROUP BY extraction_version ORDER BY extraction_version
`).all() as any[];
for (const v of versions) {
  console.log(`v${v.extraction_version || 'null'}: ${v.c} items`);
}

// 5. Embedding coverage
console.log('\n=== EMBEDDING COVERAGE ===\n');
const hasEmbed = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE embedding IS NOT NULL`).get() as any;
const noEmbed = db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE embedding IS NULL`).get() as any;
console.log(`With embeddings: ${hasEmbed.c}`);
console.log(`Without embeddings: ${noEmbed.c} (${Math.round(noEmbed.c/totalK.c*100)}% missing)`);

// 6. Sample of bad quality items
console.log('\n=== WORST QUALITY ITEMS (short summary + no raw_content) ===\n');
const worst = db.prepare(`
  SELECT source, title, length(summary) as sum_len, source_date
  FROM knowledge
  WHERE length(summary) < 30 AND source IN ('gmail', 'gmail-sent', 'cowork', 'claude')
  ORDER BY source_date DESC LIMIT 10
`).all() as any[];
for (const w of worst) {
  console.log(`[${w.source}] ${w.source_date?.slice(0,10)} "${(w.title || '').slice(0, 60)}" (${w.sum_len} char summary)`);
}

// 7. Check what prime_retrieve actually returns for a recent forrest email
console.log('\n=== FORREST RAW CONTENT SPOT CHECK ===\n');
const forrestRecent = db.prepare(`
  SELECT title, length(raw_content) as raw_len, length(summary) as sum_len, source_date
  FROM knowledge
  WHERE source_account = 'forrest@recaptureinsurance.com'
  AND source_date >= '2026-04-10'
  ORDER BY source_date DESC LIMIT 5
`).all() as any[];
for (const f of forrestRecent) {
  const rawStatus = f.raw_len > 100 ? `✓ ${f.raw_len} chars` : '✗ EMPTY';
  console.log(`${f.source_date?.slice(0,10)} "${(f.title || '').slice(0, 50)}"  raw: ${rawStatus}  summary: ${f.sum_len} chars`);
}

db.close();
