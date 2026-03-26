import type Database from 'better-sqlite3';
import {
  searchByText,
  searchByEmbedding,
  getConfig,
  getConnectionsForItem,
  getThemes,
  getSemantics,
  cosineSimilarity,
} from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { getDefaultProvider, type LLMProvider } from './providers.js';

// ============================================================
// Types
// ============================================================

export interface SearchOptions {
  limit?: number;           // default 15
  strategy?: 'auto' | 'semantic' | 'keyword' | 'graph' | 'temporal' | 'hierarchical';
  project?: string;
  source?: string;
  since?: string;           // ISO date — only items after this
  rerank?: boolean;         // default true — Claude reranks results
}

export interface SearchResult {
  items: any[];             // knowledge items with scores
  strategy_used: string;
  confidence: number;       // 0-1 overall confidence
  coverage: {
    sources_found: number;
    recency: 'fresh' | 'mixed' | 'stale';
    agreement: 'consistent' | 'mixed' | 'conflicting';
  };
}

// ============================================================
// BM25 scoring
// ============================================================

function bm25Score(query: string, document: string, avgDocLength: number, k1 = 1.5, b = 0.75): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const docTerms = document.toLowerCase().split(/\s+/);
  const docLength = docTerms.length;
  const termFreqs = new Map<string, number>();
  for (const t of docTerms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreqs.get(term) || 0;
    if (tf === 0) continue;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
    score += numerator / denominator;
  }
  return score;
}

// ============================================================
// Helpers
// ============================================================

function decodeEmbedding(blob: any): number[] | null {
  if (!blob) return null;
  if (Buffer.isBuffer(blob) || blob instanceof Uint8Array) {
    const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(floats);
  }
  return null;
}

function parseJsonField(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

function parseJsonFields(row: any): any {
  for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
    if (row[field] && typeof row[field] === 'string') {
      try { row[field] = JSON.parse(row[field]); } catch {}
    }
  }
  return row;
}

function deduplicateById(items: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

const TEMPORAL_WORDS = [
  'today', 'yesterday', 'this week', 'last week', 'this month', 'last month',
  'recently', 'recent', 'latest', 'new', 'changed', 'updated', 'what happened',
  'catch up', 'catch me up',
];

function hasTemporalIntent(query: string): boolean {
  const q = query.toLowerCase();
  return TEMPORAL_WORDS.some(w => q.includes(w));
}

function getTemporalRange(query: string): { since: string; label: string } {
  const q = query.toLowerCase();
  const now = new Date();

  if (q.includes('today')) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'today' };
  }
  if (q.includes('yesterday')) {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'yesterday' };
  }
  if (q.includes('this week')) {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'this week' };
  }
  if (q.includes('last week')) {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay() - 7); d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), label: 'last week' };
  }
  if (q.includes('this month')) {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { since: d.toISOString(), label: 'this month' };
  }
  if (q.includes('last month')) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { since: d.toISOString(), label: 'last month' };
  }
  // Default: last 7 days for "recently", "latest", etc.
  const d = new Date(now); d.setDate(d.getDate() - 7);
  return { since: d.toISOString(), label: 'last 7 days' };
}

function findContactInQuery(query: string, db: Database.Database): string | null {
  // Get all unique contacts from knowledge base
  const rows = db.prepare(
    "SELECT DISTINCT contacts FROM knowledge WHERE contacts IS NOT NULL AND contacts != '[]'"
  ).all() as any[];

  const allContacts = new Set<string>();
  for (const row of rows) {
    const contacts = parseJsonField(row.contacts);
    for (const c of contacts) allContacts.add(c);
  }

  const qLower = query.toLowerCase();
  for (const contact of allContacts) {
    if (qLower.includes(contact.toLowerCase())) return contact;
  }
  return null;
}

// ============================================================
// Strategy implementations
// ============================================================

async function semanticSearch(
  db: Database.Database,
  query: string,
  limit: number,
  apiKey: string,
): Promise<any[]> {
  const queryEmb = await generateEmbedding(query, apiKey);
  const results = searchByEmbedding(db, queryEmb, limit, 0.2);
  // Normalize: similarity is already 0-1
  return results.map(r => ({ ...r, _score: r.similarity || 0, _strategy: 'semantic' }));
}

function keywordSearch(
  db: Database.Database,
  query: string,
  limit: number,
): any[] {
  // Get all knowledge items for BM25 scoring
  const items = db.prepare('SELECT * FROM knowledge').all() as any[];
  if (items.length === 0) return [];

  // Compute average document length
  const avgDocLength = items.reduce((sum, item) => {
    const doc = `${item.title || ''} ${item.summary || ''} ${item.contacts || ''} ${item.tags || ''}`;
    return sum + doc.split(/\s+/).length;
  }, 0) / items.length;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = items.map(item => {
    parseJsonFields(item);

    const titleDoc = (item.title || '').toLowerCase();
    const summaryDoc = (item.summary || '').toLowerCase();
    const contactsDoc = (Array.isArray(item.contacts) ? item.contacts.join(' ') : '').toLowerCase();
    const tagsDoc = (Array.isArray(item.tags) ? item.tags.join(' ') : '').toLowerCase();

    // BM25 on full document
    const fullDoc = `${item.title || ''} ${item.summary || ''} ${contactsDoc} ${tagsDoc}`;
    let score = bm25Score(query, fullDoc, avgDocLength);

    // Boost title matches 3x
    const titleMatches = queryTerms.filter(t => titleDoc.includes(t)).length;
    score += titleMatches * 3.0;

    // Boost contact matches 2x
    const contactMatches = queryTerms.filter(t => contactsDoc.includes(t)).length;
    score += contactMatches * 2.0;

    // Boost tag matches 1.5x
    const tagMatches = queryTerms.filter(t => tagsDoc.includes(t)).length;
    score += tagMatches * 1.5;

    item.embedding = null; // Don't carry blob data
    return { ...item, _score: score, _strategy: 'keyword' };
  })
  .filter(item => item._score > 0)
  .sort((a, b) => b._score - a._score)
  .slice(0, limit);

  return scored;
}

async function graphSearch(
  db: Database.Database,
  query: string,
  limit: number,
  apiKey: string | null,
): Promise<any[]> {
  // Find seed items via semantic or keyword
  let seedItems: any[];
  if (apiKey) {
    try {
      seedItems = await semanticSearch(db, query, 5, apiKey);
    } catch {
      seedItems = keywordSearch(db, query, 5);
    }
  } else {
    seedItems = keywordSearch(db, query, 5);
  }

  const allItems: any[] = [...seedItems];
  const seenIds = new Set(seedItems.map(i => i.id));

  // For each seed, fetch connected items
  for (const seed of seedItems) {
    const connections = getConnectionsForItem(db, seed.id);
    for (const conn of connections) {
      const connectedId = conn.source_id === seed.id ? conn.target_id : conn.source_id;
      if (seenIds.has(connectedId)) continue;
      seenIds.add(connectedId);

      const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(connectedId) as any;
      if (row) {
        parseJsonFields(row);
        row.embedding = null;
        const derivedScore = (seed._score || 0.5) * conn.confidence * 0.5;
        allItems.push({
          ...row,
          _score: derivedScore,
          _strategy: 'graph',
          _via: `${conn.relationship} (from "${seed.title}")`,
        });
      }
    }
  }

  return allItems
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function temporalSearch(
  db: Database.Database,
  query: string,
  limit: number,
  sinceOverride?: string,
): any[] {
  const { since, label } = sinceOverride
    ? { since: sinceOverride, label: 'custom range' }
    : getTemporalRange(query);

  const rows = db.prepare(
    `SELECT * FROM knowledge
     WHERE source_date >= ?
     ORDER BY source_date DESC
     LIMIT ?`
  ).all(since, limit * 2) as any[];

  const now = new Date();
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return rows.map(row => {
    parseJsonFields(row);
    row.embedding = null;

    // Score: recent items rank higher
    let score = 0.5;
    if (row.source_date) {
      const itemDate = new Date(row.source_date);
      if (itemDate >= sevenDaysAgo) score = 0.9;
      else {
        const daysAgo = (now.getTime() - itemDate.getTime()) / 86400000;
        score = Math.max(0.1, 1.0 - (daysAgo / 90));
      }
    }

    // Importance boost
    if (row.importance === 'critical') score *= 1.5;
    else if (row.importance === 'high') score *= 1.2;

    return { ...row, _score: Math.min(score, 1.0), _strategy: 'temporal', _temporal_label: label };
  })
  .sort((a, b) => b._score - a._score)
  .slice(0, limit);
}

async function hierarchicalSearch(
  db: Database.Database,
  query: string,
  limit: number,
  apiKey: string,
): Promise<any[]> {
  const queryEmb = await generateEmbedding(query, apiKey);

  // 1. Search themes by centroid similarity → top 3
  const themes = getThemes(db);
  const scoredThemes = themes
    .map(theme => {
      let sim = 0;
      if (theme.centroid) {
        const centroid = decodeEmbedding(theme.centroid);
        if (centroid) sim = cosineSimilarity(queryEmb, centroid);
      }
      return { ...theme, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  if (scoredThemes.length === 0) {
    // Fallback to semantic search
    return semanticSearch(db, query, limit, apiKey);
  }

  // 2. Collect semantic_ids from top themes
  const semanticIds = new Set<string>();
  for (const theme of scoredThemes) {
    const ids = Array.isArray(theme.semantic_ids) ? theme.semantic_ids : parseJsonField(theme.semantic_ids);
    for (const id of ids) semanticIds.add(id);
  }

  // 3. Rank semantics by query similarity
  const allSemantics = getSemantics(db, { current: true });
  const relevantSemantics = allSemantics
    .filter(s => semanticIds.has(s.id))
    .map(s => {
      let sim = 0;
      if (s.embedding) {
        const emb = decodeEmbedding(s.embedding);
        if (emb) sim = cosineSimilarity(queryEmb, emb);
      }
      return { ...s, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity);

  const avgSim = relevantSemantics.length > 0
    ? relevantSemantics.reduce((sum, s) => sum + s.similarity, 0) / relevantSemantics.length
    : 0;

  // 4. Collect item IDs from top semantics
  const itemIds = new Set<string>();
  for (const sem of relevantSemantics.slice(0, 15)) {
    const ids = Array.isArray(sem.item_ids) ? sem.item_ids : parseJsonField(sem.item_ids);
    for (const id of ids) itemIds.add(id);
  }

  // 5. If low confidence, expand via episodes
  if (avgSim < 0.5) {
    const episodeIds = new Set<string>();
    for (const sem of relevantSemantics) {
      const eids = Array.isArray(sem.episode_ids) ? sem.episode_ids : parseJsonField(sem.episode_ids);
      for (const eid of eids) episodeIds.add(eid);
    }

    if (episodeIds.size > 0) {
      const placeholders = Array.from(episodeIds).map(() => '?').join(',');
      const episodes = db.prepare(`SELECT item_ids FROM episodes WHERE id IN (${placeholders})`).all(...Array.from(episodeIds)) as any[];
      for (const ep of episodes) {
        const ids = parseJsonField(ep.item_ids);
        for (const id of ids) itemIds.add(id);
      }
    }
  }

  // 6. Fetch and score knowledge items
  if (itemIds.size === 0) {
    return semanticSearch(db, query, limit, apiKey);
  }

  const placeholders = Array.from(itemIds).map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM knowledge WHERE id IN (${placeholders})`).all(...Array.from(itemIds)) as any[];

  return rows.map(row => {
    parseJsonFields(row);
    // Score by embedding similarity if available
    let score = 0.5;
    if (row.embedding) {
      const emb = decodeEmbedding(row.embedding);
      if (emb) score = cosineSimilarity(queryEmb, emb);
    }
    row.embedding = null;
    return { ...row, _score: score, _strategy: 'hierarchical' };
  })
  .sort((a, b) => b._score - a._score)
  .slice(0, limit);
}

// ============================================================
// Reranking with Claude
// ============================================================

async function rerankResults(
  query: string,
  candidates: any[],
  provider: LLMProvider,
): Promise<{ items: any[]; confidence: number; recency: string; agreement: string }> {
  if (candidates.length === 0) {
    return { items: [], confidence: 0, recency: 'stale', agreement: 'consistent' };
  }

  // Send top 20 candidates for reranking
  const toRerank = candidates.slice(0, 20);

  const candidateList = toRerank.map((item, idx) => {
    const date = item.source_date || 'unknown';
    const contacts = Array.isArray(item.contacts) ? item.contacts.join(', ') : '';
    return `[${idx}] "${item.title}" (${item.source}, ${date}, importance: ${item.importance || 'normal'})\n    ${(item.summary || '').slice(0, 200)}${contacts ? `\n    Contacts: ${contacts}` : ''}`;
  }).join('\n');

  try {
    const response = await provider.chat(
      [
        {
          role: 'system',
          content: `You rank search results by relevance to a query. Consider:
1. Direct relevance to the query
2. Recency (prefer recent unless query asks for history)
3. Importance level (critical > high > normal > low)
4. Completeness (does this fully answer vs partially)

Return JSON only: {"ranked": [index_numbers_in_order], "confidence": 0.0-1.0, "coverage": "fresh|mixed|stale", "agreement": "consistent|mixed|conflicting"}

"ranked" must contain index numbers from the candidate list, most relevant first.
"confidence" is how well the results answer the query (1.0 = perfect coverage, 0.0 = nothing relevant).
"coverage" reflects recency: fresh = mostly <7 days, stale = mostly >30 days.
"agreement" reflects consistency: do results point same direction or contradict?`,
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nCandidates:\n${candidateList}`,
        },
      ],
      { temperature: 0.1, max_tokens: 500, json: true }
    );

    const result = JSON.parse(response);
    const ranked = (result.ranked || []) as number[];

    // Reorder candidates by ranked indices
    const reranked: any[] = [];
    const seen = new Set<number>();
    for (const idx of ranked) {
      if (idx >= 0 && idx < toRerank.length && !seen.has(idx)) {
        seen.add(idx);
        reranked.push(toRerank[idx]);
      }
    }
    // Add any candidates that weren't in the ranking
    for (let i = 0; i < toRerank.length; i++) {
      if (!seen.has(i)) reranked.push(toRerank[i]);
    }
    // Add remaining candidates beyond top 20
    reranked.push(...candidates.slice(20));

    return {
      items: reranked,
      confidence: result.confidence ?? 0.5,
      recency: result.coverage || 'mixed',
      agreement: result.agreement || 'consistent',
    };
  } catch {
    // Reranking failed — return original order
    return {
      items: candidates,
      confidence: computeConfidence(candidates),
      recency: computeRecency(candidates),
      agreement: 'consistent',
    };
  }
}

// ============================================================
// Confidence scoring (fallback when reranking is off)
// ============================================================

function computeConfidence(items: any[]): number {
  if (items.length === 0) return 0;
  const count = Math.min(items.length / 10, 1.0) * 0.4; // 0-0.4 based on count
  const avgScore = items.reduce((sum, i) => sum + (i._score || i.similarity || 0), 0) / items.length;
  const scoreComponent = avgScore * 0.6; // 0-0.6 based on avg score
  return Math.min(count + scoreComponent, 1.0);
}

function computeRecency(items: any[]): 'fresh' | 'mixed' | 'stale' {
  if (items.length === 0) return 'stale';
  const now = Date.now();
  const sevenDays = 7 * 86400000;
  const thirtyDays = 30 * 86400000;

  let fresh = 0, stale = 0;
  for (const item of items) {
    if (item.source_date) {
      const age = now - new Date(item.source_date).getTime();
      if (age < sevenDays) fresh++;
      else if (age > thirtyDays) stale++;
    }
  }

  if (fresh > items.length * 0.5) return 'fresh';
  if (stale > items.length * 0.5) return 'stale';
  return 'mixed';
}

// ============================================================
// Main search function
// ============================================================

export async function search(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const {
    limit = 15,
    strategy = 'auto',
    project,
    source,
    since,
    rerank = true,
  } = options;

  const apiKey = getConfig(db, 'openai_api_key');
  let candidates: any[] = [];
  let strategyUsed: string = strategy;

  // ── Execute strategy ───────────────────────────────────────

  if (strategy === 'semantic') {
    if (!apiKey) throw new Error('Semantic search requires an OpenAI API key for embeddings.');
    candidates = await semanticSearch(db, query, limit * 2, apiKey);
    strategyUsed = 'semantic';

  } else if (strategy === 'keyword') {
    candidates = keywordSearch(db, query, limit * 2);
    strategyUsed = 'keyword';

  } else if (strategy === 'graph') {
    candidates = await graphSearch(db, query, limit * 2, apiKey);
    strategyUsed = 'graph';

  } else if (strategy === 'temporal') {
    candidates = temporalSearch(db, query, limit * 2, since);
    strategyUsed = 'temporal';

  } else if (strategy === 'hierarchical') {
    if (!apiKey) throw new Error('Hierarchical search requires an OpenAI API key for embeddings.');
    candidates = await hierarchicalSearch(db, query, limit * 2, apiKey);
    strategyUsed = 'hierarchical';

  } else {
    // ── Auto strategy: semantic + keyword in parallel, plus extras ──
    strategyUsed = 'auto';

    const promises: Promise<any[]>[] = [];

    // Always run keyword
    promises.push(Promise.resolve(keywordSearch(db, query, limit * 2)));

    // Run semantic if API key available
    if (apiKey) {
      promises.push(
        semanticSearch(db, query, limit * 2, apiKey).catch(() => [])
      );
    }

    const [keywordResults, semanticResults] = await Promise.all(promises);

    // Merge: normalize scores and combine
    // Find max scores for normalization
    const maxKeyword = keywordResults.length > 0 ? Math.max(...keywordResults.map((r: any) => r._score)) : 1;
    const maxSemantic = semanticResults?.length > 0 ? Math.max(...semanticResults.map((r: any) => r._score)) : 1;

    const scoreMap = new Map<string, { item: any; semanticScore: number; keywordScore: number }>();

    // Add semantic results
    if (semanticResults) {
      for (const item of semanticResults) {
        const normScore = maxSemantic > 0 ? item._score / maxSemantic : 0;
        scoreMap.set(item.id, { item, semanticScore: normScore, keywordScore: 0 });
      }
    }

    // Add/merge keyword results
    for (const item of keywordResults) {
      const normScore = maxKeyword > 0 ? item._score / maxKeyword : 0;
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.keywordScore = normScore;
      } else {
        scoreMap.set(item.id, { item, semanticScore: 0, keywordScore: normScore });
      }
    }

    // Combined score: 0.7 semantic + 0.3 keyword
    candidates = Array.from(scoreMap.values())
      .map(({ item, semanticScore, keywordScore }) => ({
        ...item,
        _score: 0.7 * semanticScore + 0.3 * keywordScore,
        _strategy: 'auto',
      }))
      .sort((a, b) => b._score - a._score);

    // If temporal words detected, also run temporal and merge
    if (hasTemporalIntent(query)) {
      const temporalResults = temporalSearch(db, query, limit, since);
      for (const tr of temporalResults) {
        if (!candidates.find(c => c.id === tr.id)) {
          candidates.push({ ...tr, _score: tr._score * 0.8 }); // Slightly lower to blend
        }
      }
      strategyUsed = 'auto+temporal';
    }

    // If query mentions a contact, run graph from that contact's items
    const contactMatch = findContactInQuery(query, db);
    if (contactMatch) {
      const graphResults = await graphSearch(db, query, limit, apiKey);
      for (const gr of graphResults) {
        if (!candidates.find(c => c.id === gr.id)) {
          candidates.push({ ...gr, _score: gr._score * 0.7 });
        }
      }
      strategyUsed = strategyUsed.includes('+') ? `${strategyUsed}+graph` : 'auto+graph';
    }
  }

  // ── Apply filters ──────────────────────────────────────────

  if (project) {
    candidates = candidates.filter(r =>
      r.project?.toLowerCase().includes(project.toLowerCase())
    );
  }
  if (source) {
    candidates = candidates.filter(r => r.source === source);
  }
  if (since) {
    candidates = candidates.filter(r => r.source_date && r.source_date >= since);
  }

  // Deduplicate
  candidates = deduplicateById(candidates);

  // ── Rerank with Claude ─────────────────────────────────────

  let confidence: number;
  let recency: 'fresh' | 'mixed' | 'stale';
  let agreement: 'consistent' | 'mixed' | 'conflicting';

  if (rerank && candidates.length > 2) {
    try {
      const provider = await getDefaultProvider(apiKey || undefined);
      const reranked = await rerankResults(query, candidates, provider);
      candidates = reranked.items;
      confidence = reranked.confidence;
      recency = reranked.recency as any;
      agreement = reranked.agreement as any;
    } catch {
      // Reranking failed — use computed values
      confidence = computeConfidence(candidates);
      recency = computeRecency(candidates);
      agreement = 'consistent';
    }
  } else {
    confidence = computeConfidence(candidates);
    recency = computeRecency(candidates);
    agreement = 'consistent';
  }

  // ── Trim to limit ──────────────────────────────────────────

  const items = candidates.slice(0, limit);

  return {
    items,
    strategy_used: strategyUsed,
    confidence,
    coverage: {
      sources_found: items.length,
      recency,
      agreement,
    },
  };
}
