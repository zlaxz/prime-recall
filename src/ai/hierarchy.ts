import type { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import {
  getAllKnowledge,
  getConfig,
  saveDb,
  insertEpisode,
  insertSemantic,
  insertTheme,
  getSemantics,
  getThemes,
  cosineSimilarity,
  type Episode,
  type Semantic,
  type Theme,
} from '../db.js';
import { generateEmbedding, generateEmbeddings } from '../embedding.js';
import { getDefaultProvider } from './providers.js';

// ============================================================
// Episode Detection
// ============================================================

interface ItemGroup {
  key: string;
  items: any[];
  source?: string;
  project?: string;
}

function groupItemsIntoEpisodes(items: any[]): ItemGroup[] {
  const groups = new Map<string, any[]>();

  for (const item of items) {
    let groupKey: string | null = null;

    // Same email thread (source_ref prefix before the last segment)
    if (item.source === 'gmail' && item.source_ref) {
      // Gmail source_refs like "gmail:threadId" — group by thread
      const parts = (item.source_ref as string).split(':');
      if (parts.length >= 2) {
        groupKey = `gmail:${parts[1]}`;
      }
    }

    // Calendar events on the same date
    if (item.source === 'calendar' && item.source_date) {
      const dateOnly = (item.source_date as string).split('T')[0];
      groupKey = `calendar:${dateOnly}`;
    }

    // Same project + within 7 days of each other (fallback grouping)
    if (!groupKey && item.project) {
      // Use project + week bucket
      const date = item.source_date ? new Date(item.source_date) : new Date(item.created_at || Date.now());
      const weekStart = new Date(date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      groupKey = `project:${item.project}:${weekKey}`;
    }

    // Ungrouped items get their own episode
    if (!groupKey) {
      groupKey = `single:${item.id}`;
    }

    const existing = groups.get(groupKey) || [];
    existing.push(item);
    groups.set(groupKey, existing);
  }

  // Convert to ItemGroup array
  const result: ItemGroup[] = [];
  for (const [key, groupItems] of groups) {
    // Determine primary source and project
    const sourceCounts = new Map<string, number>();
    const projectCounts = new Map<string, number>();
    for (const item of groupItems) {
      if (item.source) sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
      if (item.project) projectCounts.set(item.project, (projectCounts.get(item.project) || 0) + 1);
    }

    let primarySource: string | undefined;
    let maxSourceCount = 0;
    for (const [src, count] of sourceCounts) {
      if (count > maxSourceCount) { primarySource = src; maxSourceCount = count; }
    }

    let primaryProject: string | undefined;
    let maxProjectCount = 0;
    for (const [proj, count] of projectCounts) {
      if (count > maxProjectCount) { primaryProject = proj; maxProjectCount = count; }
    }

    result.push({ key, items: groupItems, source: primarySource, project: primaryProject });
  }

  return result;
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
  }
  return avg;
}

function decodeEmbedding(blob: any): number[] | null {
  if (!blob) return null;
  if (blob instanceof Uint8Array) {
    const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(floats);
  }
  return null;
}

// ============================================================
// K-means clustering (simple implementation)
// ============================================================

function kMeans(vectors: number[][], k: number, maxIter = 20): number[][] {
  if (vectors.length <= k) {
    // Each vector is its own cluster
    return vectors.map((_, i) => [i]);
  }

  const dim = vectors[0].length;

  // Initialize centroids using k random vectors
  const indices = [...Array(vectors.length).keys()];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const centroids = indices.slice(0, k).map(i => [...vectors[i]]);

  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each vector to nearest centroid
    const newAssignments = vectors.map(vec => {
      let bestCluster = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = cosineSimilarity(vec, centroids[c]);
        if (sim > bestSim) { bestSim = sim; bestCluster = c; }
      }
      return bestCluster;
    });

    // Check convergence
    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed) break;

    // Update centroids
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length > 0) {
        centroids[c] = averageEmbeddings(members);
      }
    }
  }

  // Convert assignments to clusters (array of index arrays)
  const clusters: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < assignments.length; i++) {
    clusters[assignments[i]].push(i);
  }

  return clusters.filter(c => c.length > 0);
}

// ============================================================
// Main build function
// ============================================================

export async function buildHierarchy(
  db: SqlJsDatabase,
  options: { verbose?: boolean } = {}
): Promise<{ episodes: number; semantics: number; themes: number; merged: number; split: number }> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const log = options.verbose ? console.log : () => {};

  const stats = { episodes: 0, semantics: 0, themes: 0, merged: 0, split: 0 };

  // Clear existing hierarchy tables for a clean rebuild
  db.run('DELETE FROM themes');
  db.run('DELETE FROM semantics');
  db.run('DELETE FROM episodes');
  saveDb();

  // ========================================================
  // 1. Episode Detection
  // ========================================================
  log('  Grouping items into episodes...');
  const allItems = getAllKnowledge(db);
  if (allItems.length === 0) {
    log('  No knowledge items to process.');
    return stats;
  }

  const groups = groupItemsIntoEpisodes(allItems);
  log(`  Found ${groups.length} episode groups from ${allItems.length} items`);

  // Process episodes in parallel batches — get title+summary from Claude
  // 10 groups per call, 5 concurrent calls
  const EP_BATCH_SIZE = 10;
  const EP_CONCURRENCY = 5;

  const epBatches: { groups: typeof groups }[] = [];
  for (let i = 0; i < groups.length; i += EP_BATCH_SIZE) {
    epBatches.push({ groups: groups.slice(i, i + EP_BATCH_SIZE) });
  }

  let epCompleted = 0;

  async function processEpisodeBatch(b: { groups: typeof groups }) {
    const batchPrompt = b.groups.map((group, idx) => {
      const itemSummaries = group.items.map((item: any) =>
        `- "${item.title}": ${item.summary}`
      ).join('\n');
      return `[${idx}] (${group.items.length} items, source: ${group.source || 'mixed'}, project: ${group.project || 'none'})\n${itemSummaries}`;
    }).join('\n\n');

    try {
      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `You are summarizing groups of related knowledge items into episodes. For each group, provide a title and 1-sentence summary.

Return JSON: {"episodes": [{"index": 0, "title": "Episode title", "summary": "One sentence summary"}]}`,
          },
          { role: 'user', content: batchPrompt },
        ],
        { temperature: 0.1, max_tokens: 1500, json: true }
      );

      const result = JSON.parse(response);
      const episodeData = result.episodes || [];
      const created: Episode[] = [];

      for (const ep of episodeData) {
        const group = b.groups[ep.index];
        if (!group) continue;

        const itemEmbeddings: number[][] = [];
        for (const item of group.items) {
          const emb = decodeEmbedding(item.embedding);
          if (emb) itemEmbeddings.push(emb);
        }

        const dates = group.items.map((item: any) => item.source_date).filter(Boolean).sort();

        created.push({
          id: uuid(),
          title: ep.title || group.items[0]?.title || 'Untitled Episode',
          summary: ep.summary,
          item_ids: group.items.map((item: any) => item.id),
          source: group.source,
          project: group.project,
          date_start: dates[0] || undefined,
          date_end: dates[dates.length - 1] || undefined,
          embedding: itemEmbeddings.length > 0 ? averageEmbeddings(itemEmbeddings) : undefined,
        });
      }

      epCompleted++;
      log(`    Episode batch ${epCompleted}/${epBatches.length}: ${created.length} episodes`);
      return created;
    } catch {
      // Fallback: create episodes without AI titles
      const created: Episode[] = [];
      for (const group of b.groups) {
        const dates = group.items.map((item: any) => item.source_date).filter(Boolean).sort();
        const itemEmbeddings: number[][] = [];
        for (const item of group.items) {
          const emb = decodeEmbedding(item.embedding);
          if (emb) itemEmbeddings.push(emb);
        }
        created.push({
          id: uuid(),
          title: group.items[0]?.title || 'Untitled Episode',
          summary: group.items.map((item: any) => item.title).join('; '),
          item_ids: group.items.map((item: any) => item.id),
          source: group.source,
          project: group.project,
          date_start: dates[0] || undefined,
          date_end: dates[dates.length - 1] || undefined,
          embedding: itemEmbeddings.length > 0 ? averageEmbeddings(itemEmbeddings) : undefined,
        });
      }
      epCompleted++;
      log(`    Episode batch ${epCompleted}/${epBatches.length}: ${created.length} episodes (fallback)`);
      return created;
    }
  }

  // Run episode batches with concurrency
  for (let i = 0; i < epBatches.length; i += EP_CONCURRENCY) {
    const chunk = epBatches.slice(i, i + EP_CONCURRENCY);
    const results = await Promise.all(chunk.map(processEpisodeBatch));
    for (const episodes of results) {
      for (const ep of episodes) {
        insertEpisode(db, ep);
        stats.episodes++;
      }
    }
  }

  log(`  Created ${stats.episodes} episodes`);

  // ========================================================
  // 2. Semantic Extraction
  // ========================================================
  log('  Extracting semantic facts from episodes...');

  // Get all episodes we just created
  const stmt = db.prepare('SELECT * FROM episodes ORDER BY date_start DESC');
  const episodes: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.item_ids && typeof row.item_ids === 'string') {
      try { row.item_ids = JSON.parse(row.item_ids); } catch {}
    }
    episodes.push(row);
  }
  stmt.free();

  // Process episodes in parallel batches for semantic extraction
  // Batch size: 10 episodes per Claude call, 5 concurrent calls
  const allNewSemantics: Semantic[] = [];
  const BATCH_SIZE = 10;
  const CONCURRENCY = 5;

  const systemPrompt = `Extract discrete, atomic facts from these episodes. Each fact should be one clear statement.

Fact types: decision, commitment, deadline, relationship, preference, status

Return JSON: {"facts": [{"episode_index": 0, "fact": "Statement of fact", "type": "decision|commitment|deadline|relationship|preference|status", "contacts": ["Name"], "project": "ProjectName or null"}]}

Rules:
- Each fact = ONE atomic statement
- Be specific: include names, dates, numbers
- "decision" = a choice that was made
- "commitment" = a promise or obligation
- "deadline" = a time-sensitive event
- "relationship" = connection between people/orgs
- "preference" = a stated preference or priority
- "status" = current state of something`;

  // Build all batch prompts upfront
  const batches: { episodes: any[]; prompt: string }[] = [];
  for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
    const batch = episodes.slice(i, i + BATCH_SIZE);
    const prompt = batch.map((ep, idx) => {
      const itemIds = Array.isArray(ep.item_ids) ? ep.item_ids : [];
      const memberItems = allItems.filter(item => itemIds.includes(item.id));
      const content = memberItems.map((item: any) =>
        `Title: ${item.title}\nSummary: ${item.summary}${item.project ? `\nProject: ${item.project}` : ''}`
      ).join('\n---\n');
      return `[Episode ${idx}] "${ep.title}" (${ep.project || 'no project'})\n${content}`;
    }).join('\n\n===\n\n');
    batches.push({ episodes: batch, prompt });
  }

  // Process with concurrency limiter
  let completed = 0;
  async function processBatch(b: { episodes: any[]; prompt: string }) {
    try {
      const response = await provider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: b.prompt },
        ],
        { temperature: 0.1, max_tokens: 3000, json: true }
      );

      const result = JSON.parse(response);
      const facts = result.facts || [];

      const semantics: Semantic[] = [];
      for (const fact of facts) {
        const ep = b.episodes[fact.episode_index];
        if (!ep) continue;
        semantics.push({
          id: uuid(),
          fact: fact.fact,
          fact_type: fact.type || 'status',
          episode_ids: [ep.id],
          item_ids: Array.isArray(ep.item_ids) ? ep.item_ids : [],
          project: fact.project || ep.project || undefined,
          contacts: fact.contacts || [],
          valid_from: ep.date_start || undefined,
          confidence: 1.0,
        });
      }
      completed++;
      log(`    Batch ${completed}/${batches.length}: ${facts.length} facts extracted`);
      return semantics;
    } catch (err: any) {
      completed++;
      log(`    Batch ${completed}/${batches.length}: error — ${err.message?.slice(0, 80)}`);
      return [];
    }
  }

  // Run with concurrency limit
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(processBatch));
    for (const semantics of results) {
      allNewSemantics.push(...semantics);
    }
  }

  // Generate embeddings for all semantics (batch)
  if (allNewSemantics.length > 0 && apiKey) {
    log(`  Generating embeddings for ${allNewSemantics.length} facts...`);
    try {
      const texts = allNewSemantics.map(s => s.fact);
      const embeddings = await generateEmbeddings(texts, apiKey);
      for (let i = 0; i < allNewSemantics.length; i++) {
        allNewSemantics[i].embedding = embeddings[i];
      }
    } catch {
      log('  Could not generate semantic embeddings');
    }
  }

  // Deduplicate: merge semantics >0.9 similarity
  const deduped: Semantic[] = [];
  for (const semantic of allNewSemantics) {
    let merged = false;
    if (semantic.embedding) {
      for (const existing of deduped) {
        if (existing.embedding) {
          const sim = cosineSimilarity(semantic.embedding, existing.embedding);
          if (sim > 0.9) {
            // Merge: add episode/item references to existing
            existing.episode_ids = [...new Set([...(existing.episode_ids || []), ...(semantic.episode_ids || [])])];
            existing.item_ids = [...new Set([...(existing.item_ids || []), ...(semantic.item_ids || [])])];
            existing.contacts = [...new Set([...(existing.contacts || []), ...(semantic.contacts || [])])];
            stats.merged++;
            merged = true;
            break;
          }
        }
      }
    }
    if (!merged) {
      deduped.push(semantic);
    }
  }

  // Insert deduplicated semantics
  for (const semantic of deduped) {
    insertSemantic(db, semantic);
    stats.semantics++;
  }

  log(`  Created ${stats.semantics} semantic facts (merged ${stats.merged} duplicates)`);

  // ========================================================
  // 3. Theme Organization
  // ========================================================
  log('  Organizing facts into themes...');

  // Start with project-based grouping
  const projectGroups = new Map<string, Semantic[]>();
  const ungrouped: Semantic[] = [];

  for (const semantic of deduped) {
    const project = semantic.project || '__ungrouped__';
    if (project === '__ungrouped__') {
      ungrouped.push(semantic);
    } else {
      const group = projectGroups.get(project) || [];
      group.push(semantic);
      projectGroups.set(project, group);
    }
  }

  // If there are ungrouped semantics, try to cluster them
  if (ungrouped.length > 0) {
    const withEmbeddings = ungrouped.filter(s => s.embedding);
    if (withEmbeddings.length >= 3) {
      const k = Math.max(1, Math.min(Math.ceil(withEmbeddings.length / 5), 5));
      const vectors = withEmbeddings.map(s => s.embedding!);
      const clusters = kMeans(vectors, k);

      for (let c = 0; c < clusters.length; c++) {
        const clusterSemantics = clusters[c].map(idx => withEmbeddings[idx]);
        projectGroups.set(`__cluster_${c}__`, clusterSemantics);
      }

      // Add any without embeddings to first cluster
      const noEmb = ungrouped.filter(s => !s.embedding);
      if (noEmb.length > 0 && clusters.length > 0) {
        const firstClusterKey = `__cluster_0__`;
        const existing = projectGroups.get(firstClusterKey) || [];
        existing.push(...noEmb);
        projectGroups.set(firstClusterKey, existing);
      }
    } else {
      // Too few to cluster, put them all in one theme
      projectGroups.set('__misc__', ungrouped);
    }
  }

  // Split themes with >20 semantics
  const finalGroups = new Map<string, Semantic[]>();
  for (const [key, semantics] of projectGroups) {
    if (semantics.length > 20) {
      const withEmb = semantics.filter(s => s.embedding);
      if (withEmb.length >= 4) {
        const k = Math.ceil(semantics.length / 10);
        const vectors = withEmb.map(s => s.embedding!);
        const clusters = kMeans(vectors, k);
        for (let c = 0; c < clusters.length; c++) {
          finalGroups.set(`${key}:sub${c}`, clusters[c].map(idx => withEmb[idx]));
        }
        stats.split++;
      } else {
        finalGroups.set(key, semantics);
      }
    } else if (semantics.length < 3 && semantics.length > 0) {
      // Try to merge small themes into nearest neighbor
      let mergedInto: string | null = null;
      let bestSim = -Infinity;

      if (semantics[0]?.embedding) {
        for (const [otherKey, otherSemantics] of finalGroups) {
          if (otherSemantics.length >= 3) {
            const otherEmbeddings = otherSemantics.filter(s => s.embedding).map(s => s.embedding!);
            if (otherEmbeddings.length > 0) {
              const otherCentroid = averageEmbeddings(otherEmbeddings);
              const sim = cosineSimilarity(semantics[0].embedding!, otherCentroid);
              if (sim > bestSim) { bestSim = sim; mergedInto = otherKey; }
            }
          }
        }
      }

      if (mergedInto && bestSim > 0.5) {
        const existing = finalGroups.get(mergedInto) || [];
        existing.push(...semantics);
        finalGroups.set(mergedInto, existing);
      } else {
        finalGroups.set(key, semantics);
      }
    } else {
      finalGroups.set(key, semantics);
    }
  }

  // Generate theme names via Claude and insert
  const themeEntries = Array.from(finalGroups.entries()).filter(([_, s]) => s.length > 0);

  for (let i = 0; i < themeEntries.length; i += 5) {
    const batch = themeEntries.slice(i, i + 5);

    const batchPrompt = batch.map(([key, semantics], idx) => {
      const factList = semantics.map(s => `- ${s.fact}`).join('\n');
      const isProjectBased = !key.startsWith('__');
      const projectHint = isProjectBased ? key.split(':')[0] : '';
      return `[${idx}] ${projectHint ? `Project: ${projectHint}\n` : ''}Facts:\n${factList}`;
    }).join('\n\n===\n\n');

    let themeNames: { index: number; name: string; description: string }[] = [];

    try {
      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `Name and describe each theme group based on its member facts.

Return JSON: {"themes": [{"index": 0, "name": "Theme Name (2-4 words)", "description": "One sentence describing what this theme covers"}]}`,
          },
          { role: 'user', content: batchPrompt },
        ],
        { temperature: 0.1, max_tokens: 500, json: true }
      );

      const result = JSON.parse(response);
      themeNames = result.themes || [];
    } catch {
      // Fallback names
      themeNames = batch.map(([key], idx) => ({
        index: idx,
        name: key.startsWith('__') ? 'General' : key.split(':')[0],
        description: `Theme with ${batch[idx]?.[1]?.length || 0} facts`,
      }));
    }

    for (const tn of themeNames) {
      const entry = batch[tn.index];
      if (!entry) continue;
      const [, semantics] = entry;

      // Compute centroid
      const embeddings = semantics.filter(s => s.embedding).map(s => s.embedding!);
      const centroid = embeddings.length > 0 ? averageEmbeddings(embeddings) : undefined;

      // Count episodes
      const episodeSet = new Set<string>();
      for (const s of semantics) {
        for (const eid of (s.episode_ids || [])) episodeSet.add(eid);
      }

      const theme: Theme = {
        id: uuid(),
        name: tn.name || 'Unnamed Theme',
        description: tn.description,
        semantic_ids: semantics.map(s => s.id),
        size: semantics.length,
        centroid,
      };

      insertTheme(db, theme);
      stats.themes++;
    }
  }

  log(`  Created ${stats.themes} themes`);

  return stats;
}

// ============================================================
// Hierarchical Context Retrieval
// ============================================================

export async function getHierarchicalContext(
  db: SqlJsDatabase,
  query: string,
  queryEmbedding: number[]
): Promise<string> {
  // 1. Search themes by embedding similarity → top 3
  const themes = getThemes(db);
  const scoredThemes = themes
    .map(theme => {
      let sim = 0;
      if (theme.centroid) {
        const centroid = decodeEmbedding(theme.centroid);
        if (centroid) sim = cosineSimilarity(queryEmbedding, centroid);
      }
      return { ...theme, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  if (scoredThemes.length === 0) return '';

  // 2. From those themes, get all semantics → rank by query similarity → top 10
  const semanticIds = new Set<string>();
  for (const theme of scoredThemes) {
    const ids = Array.isArray(theme.semantic_ids) ? theme.semantic_ids : JSON.parse(theme.semantic_ids || '[]');
    for (const id of ids) semanticIds.add(id);
  }

  const allSemantics = getSemantics(db, { current: true });
  const relevantSemantics = allSemantics
    .filter(s => semanticIds.has(s.id))
    .map(s => {
      let sim = 0;
      if (s.embedding) {
        const emb = decodeEmbedding(s.embedding);
        if (emb) sim = cosineSimilarity(queryEmbedding, emb);
      }
      return { ...s, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);

  // 3. Build structured context string
  const parts: string[] = [];
  parts.push('HIERARCHICAL CONTEXT:');
  parts.push('');

  parts.push('Relevant Themes:');
  for (const theme of scoredThemes) {
    parts.push(`  - ${theme.name}: ${theme.description || ''} (${theme.size} facts, ${(theme.similarity * 100).toFixed(0)}% match)`);
  }
  parts.push('');

  parts.push('Key Facts:');
  for (const sem of relevantSemantics) {
    const contacts = Array.isArray(sem.contacts) ? sem.contacts : [];
    const contactStr = contacts.length > 0 ? ` [${contacts.join(', ')}]` : '';
    const projectStr = sem.project ? ` (${sem.project})` : '';
    parts.push(`  - [${sem.fact_type}] ${sem.fact}${contactStr}${projectStr}`);
  }

  // 4. If low confidence (top semantic similarity < 0.5), expand to episodes
  const topSemSim = relevantSemantics[0]?.similarity || 0;
  if (topSemSim < 0.5) {
    // Get episode IDs from relevant semantics
    const episodeIds = new Set<string>();
    for (const sem of relevantSemantics) {
      const eids = Array.isArray(sem.episode_ids) ? sem.episode_ids : [];
      for (const eid of eids) episodeIds.add(eid);
    }

    if (episodeIds.size > 0) {
      const placeholders = Array.from(episodeIds).map(() => '?').join(',');
      const epStmt = db.prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`);
      epStmt.bind(Array.from(episodeIds));

      parts.push('');
      parts.push('Expanded Episode Context:');
      while (epStmt.step()) {
        const ep = epStmt.getAsObject();
        parts.push(`  - ${ep.title}: ${ep.summary || ''}`);
      }
      epStmt.free();
    }
  }

  return parts.join('\n');
}
