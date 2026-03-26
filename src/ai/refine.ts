import type Database from 'better-sqlite3';
import { searchByText, getConfig, setConfig, insertKnowledge, type KnowledgeItem } from '../db.js';
import { learnBusinessContext } from './learn.js';
import { getDefaultProvider } from './providers.js';
import { buildHierarchy } from './hierarchy.js';
import { buildConnections } from './connections.js';
import { extractCommitments, updateCommitmentStates } from './commitments.js';

/**
 * Continuous refinement — makes the knowledge base smarter over time.
 *
 * Uses Claude Code CLI (free via Max subscription) for all reasoning.
 *
 * 1. Re-learn business context from all data
 * 2. Detect and merge duplicate entities (Charlie = Charlie Bernier)
 * 3. Identify misclassified items and re-assign projects
 * 4. Re-learn context after corrections
 * 5. Flag stale/outdated knowledge
 */
export async function refineKnowledgeBase(
  db: Database.Database,
  options: { verbose?: boolean } = {}
): Promise<{
  contextUpdated: boolean;
  duplicatesMerged: number;
  reclassified: number;
  connectionsCreated: number;
  staleItems: number;
  commitments: { extracted: number; skipped: number; newOverdue: number; newFulfilled: number; newDropped: number };
  hierarchy: { episodes: number; semantics: number; themes: number; merged: number; split: number };
}> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);
  const log = options.verbose ? console.log : () => {};

  const stats = { contextUpdated: false, duplicatesMerged: 0, reclassified: 0, connectionsCreated: 0, staleItems: 0, commitments: { extracted: 0, skipped: 0, newOverdue: 0, newFulfilled: 0, newDropped: 0 }, hierarchy: { episodes: 0, semantics: 0, themes: 0, merged: 0, split: 0 } };

  // ========================================================
  // 1. Re-learn business context
  // ========================================================
  log('  🧠 Re-learning business context...');
  const context = await learnBusinessContext(db);
  if (context) {
    stats.contextUpdated = true;
    log('  ✓ Business context updated');
  }

  // ========================================================
  // 2. Entity deduplication
  // ========================================================
  log('  🔗 Checking for duplicate entities...');
  const items = searchByText(db, '', 1000);

  // Collect all contact names and find near-duplicates
  const contactMap = new Map<string, string[]>(); // normalized → [variants]
  for (const item of items) {
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    for (const name of contacts) {
      const normalized = name.toLowerCase().trim().replace(/\s+/g, ' ');
      const existing = contactMap.get(normalized) || [];
      if (!existing.includes(name)) existing.push(name);
      contactMap.set(normalized, existing);
    }
  }

  // Find partial matches (e.g., "Forrest" and "Forrest Pullen")
  const names = Array.from(contactMap.keys());
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (names[i].includes(names[j]) || names[j].includes(names[i])) {
        // One is a substring of the other — likely same person
        const longer = names[i].length > names[j].length ? names[i] : names[j];
        const shorter = names[i].length <= names[j].length ? names[i] : names[j];

        // Update items that have the shorter name to use the longer (fuller) name
        for (const item of items) {
          const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
          const idx = contacts.findIndex((c: string) => c.toLowerCase().trim() === shorter);
          if (idx >= 0) {
            const fullName = contactMap.get(longer)?.[0] || longer;
            contacts[idx] = fullName;
            db.prepare('UPDATE knowledge SET contacts = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(contacts), item.id);
            stats.duplicatesMerged++;
          }
        }
      }
    }
  }
  if (stats.duplicatesMerged > 0) {
        log(`  ✓ Merged ${stats.duplicatesMerged} duplicate contact references`);
  }

  // ========================================================
  // 3. Re-classify unclassified items
  // ========================================================
  if (context) {
    log('  📁 Checking project classifications...');

    // Only classify items that have NO project — don't reclassify already-classified items
    // (prevents oscillation where model keeps moving things between projects)
    const toClassify = items.filter(i => !i.project);

    if (toClassify.length > 0) {
      // Batch classify in groups of 20
      for (let i = 0; i < Math.min(toClassify.length, 100); i += 20) {
        const batch = toClassify.slice(i, i + 20);
        const batchText = batch.map((item, idx) => {
          const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
          return `[${idx}] "${item.title}" | Contacts: ${contacts.join(', ') || 'none'} | ${item.summary}`;
        }).join('\n');

        try {
          const response = await provider.chat(
            [
              {
                role: 'system',
                content: `You are classifying knowledge items into the correct project based on business context.

Use the Contact → Project Mapping to determine the correct project. Pay close attention to which contacts belong to which projects.

Return JSON: {"assignments": {"0": "ProjectName", "2": "ProjectName"}}
- Only include items where you're confident about the project
- Omit items that don't clearly belong to any project
- Use EXACT project names from the business context

BUSINESS CONTEXT:
${context}`,
              },
              { role: 'user', content: batchText },
            ],
            { temperature: 0.1, max_tokens: 500, json: true }
          );

          const result = JSON.parse(response);
          const assignments = result.assignments || {};

          for (const [idx, project] of Object.entries(assignments)) {
            const item = batch[parseInt(idx)];
            if (item && project && typeof project === 'string') {
              db.prepare('UPDATE knowledge SET project = ?, updated_at = datetime(\'now\') WHERE id = ?').run(project as string, item.id);
              stats.reclassified++;
            }
          }
        } catch {}
      }

      if (stats.reclassified > 0) {
                log(`  ✓ Reclassified ${stats.reclassified} items to correct projects`);
      }
    }
  }

  // ========================================================
  // 4. Re-learn context AFTER reclassification (so context reflects corrections)
  // ========================================================
  if (stats.reclassified > 0) {
    log('  🧠 Re-learning business context after reclassification...');
    const updatedContext = await learnBusinessContext(db);
    if (updatedContext) {
      log('  ✓ Business context updated with corrected classifications');
    }
  }

  // ========================================================
  // 5. Flag stale knowledge
  // ========================================================
  log('  ⏰ Checking for stale knowledge...');
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const staleRows = db.prepare('SELECT id FROM knowledge WHERE source_date < ? AND importance != \'critical\' AND valid_until IS NULL').all(thirtyDaysAgo);
  stats.staleItems = staleRows.length;
  if (stats.staleItems > 0) {
    log(`  ⚠ ${stats.staleItems} items are 30+ days old (may need refresh)`);
  }

  // ========================================================
  // 6. Extract and update commitments
  // ========================================================
  log('  📋 Extracting commitments...');
  try {
    const commitExtract = await extractCommitments(db, { verbose: options.verbose });
    stats.commitments.extracted = commitExtract.extracted;
    stats.commitments.skipped = commitExtract.skipped;
    if (commitExtract.extracted > 0) {
      log(`  ✓ Extracted ${commitExtract.extracted} commitments (${commitExtract.skipped} duplicates skipped)`);
    }
  } catch (err: any) {
    log(`  ⚠ Commitment extraction failed: ${err.message}`);
  }

  log('  📋 Updating commitment states...');
  try {
    const stateUpdates = await updateCommitmentStates(db, { verbose: options.verbose });
    stats.commitments.newOverdue = stateUpdates.newOverdue;
    stats.commitments.newFulfilled = stateUpdates.newFulfilled;
    stats.commitments.newDropped = stateUpdates.newDropped;
    if (stateUpdates.newOverdue > 0 || stateUpdates.newFulfilled > 0 || stateUpdates.newDropped > 0) {
      log(`  ✓ State updates: ${stateUpdates.newOverdue} overdue, ${stateUpdates.newFulfilled} fulfilled, ${stateUpdates.newDropped} dropped`);
    }
  } catch (err: any) {
    log(`  ⚠ Commitment state update failed: ${err.message}`);
  }

  // ========================================================
  // 7. Build knowledge hierarchy (episodes → semantics → themes)
  // ========================================================
  log('  🏗️ Building knowledge hierarchy...');
  try {
    stats.hierarchy = await buildHierarchy(db, { verbose: options.verbose });
    log(`  ✓ Hierarchy: ${stats.hierarchy.themes} themes, ${stats.hierarchy.semantics} facts, ${stats.hierarchy.episodes} episodes`);
  } catch (err: any) {
    log(`  ⚠ Hierarchy build failed: ${err.message}`);
  }

  // ========================================================
  // 8. Dream Consolidation (from Anthropic AutoDream pattern)
  //    - Detect contradictions in semantics
  //    - Prune superseded facts
  //    - Archive stale low-importance items
  //    - Resolve duplicate semantics
  // ========================================================
  log('  💤 Dream consolidation...');
  try {
    let dreamed = 0;

    // 8a. Find and mark superseded semantics (same topic, different values, different dates)
    const currentSemantics = db.prepare(
      'SELECT * FROM semantics WHERE valid_until IS NULL ORDER BY created_at DESC'
    ).all() as any[];

    for (let i = 0; i < currentSemantics.length; i++) {
      for (let j = i + 1; j < currentSemantics.length; j++) {
        const a = currentSemantics[i];
        const b = currentSemantics[j];
        // Same project + same fact_type + different fact = potential supersede
        if (a.project && a.project === b.project && a.fact_type === b.fact_type) {
          // Simple word overlap check (>50% shared words = same topic)
          const wordsA = new Set(a.fact.toLowerCase().split(/\s+/));
          const wordsB = new Set(b.fact.toLowerCase().split(/\s+/));
          let overlap = 0;
          for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
          const overlapRatio = overlap / Math.max(wordsA.size, wordsB.size);

          if (overlapRatio > 0.5 && a.fact !== b.fact) {
            // Newer one (a, since sorted DESC) supersedes older (b)
            db.prepare(
              'UPDATE semantics SET valid_until = datetime(\'now\'), superseded_by = ? WHERE id = ?'
            ).run(a.id, b.id);
            dreamed++;
          }
        }
      }
    }

    // 8b. Archive stale knowledge items (>90 days, low importance, not critical)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const archivable = db.prepare(
      "SELECT id FROM knowledge WHERE source_date < ? AND importance = 'low' AND valid_until IS NULL"
    ).all(ninetyDaysAgo) as any[];

    for (const row of archivable) {
      db.prepare(
        "UPDATE knowledge SET valid_until = datetime('now'), importance = 'archived' WHERE id = ?"
      ).run(row.id);
      dreamed++;
    }

    // 8c. Prune duplicate themes (same name, merge semantic_ids)
    const allThemes = db.prepare('SELECT * FROM themes ORDER BY size DESC').all() as any[];
    const themesByName = new Map<string, any[]>();
    for (const t of allThemes) {
      const key = (t.name as string).toLowerCase().trim();
      const existing = themesByName.get(key) || [];
      existing.push(t);
      themesByName.set(key, existing);
    }
    for (const [_, dupes] of themesByName) {
      if (dupes.length > 1) {
        // Keep the largest, merge others into it
        const keeper = dupes[0]; // already sorted by size DESC
        const keeperIds = JSON.parse(keeper.semantic_ids || '[]');
        for (let d = 1; d < dupes.length; d++) {
          const mergeIds = JSON.parse(dupes[d].semantic_ids || '[]');
          for (const id of mergeIds) {
            if (!keeperIds.includes(id)) keeperIds.push(id);
          }
          db.prepare('DELETE FROM themes WHERE id = ?').run(dupes[d].id);
          dreamed++;
        }
        db.prepare('UPDATE themes SET semantic_ids = ?, size = ? WHERE id = ?')
          .run(JSON.stringify(keeperIds), keeperIds.length, keeper.id);
      }
    }

    if (dreamed > 0) {
      log(`  ✓ Dream: ${dreamed} consolidation actions (superseded facts, archived items, merged themes)`);
    } else {
      log('  ✓ Dream: knowledge base is clean');
    }
  } catch (err: any) {
    log(`  ⚠ Dream consolidation failed: ${err.message}`);
  }

  // ========================================================
  // 9. Build connections graph
  // ========================================================
  log('  🔗 Building connections graph...');
  try {
    const connStats = await buildConnections(db, { verbose: options.verbose });
    stats.connectionsCreated = connStats.total;
    log(`  ✓ Connections: ${connStats.total} total (mentions: ${connStats.byType.mentions}, part_of: ${connStats.byType.part_of}, related_to: ${connStats.byType.related_to})`);
  } catch (err: any) {
    log(`  ⚠ Connections build failed: ${err.message}`);
  }

  return stats;
}
