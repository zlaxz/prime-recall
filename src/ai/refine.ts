import type { Database as SqlJsDatabase } from 'sql.js';
import { searchByText, getConfig, setConfig, saveDb, insertKnowledge, type KnowledgeItem } from '../db.js';
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
  db: SqlJsDatabase,
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
            db.run('UPDATE knowledge SET contacts = ?, updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(contacts), item.id]);
            stats.duplicatesMerged++;
          }
        }
      }
    }
  }
  if (stats.duplicatesMerged > 0) {
    saveDb();
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
              db.run('UPDATE knowledge SET project = ?, updated_at = datetime(\'now\') WHERE id = ?', [project, item.id]);
              stats.reclassified++;
            }
          }
        } catch {}
      }

      if (stats.reclassified > 0) {
        saveDb();
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
  const stmt = db.prepare('SELECT id FROM knowledge WHERE source_date < $date AND importance != \'critical\' AND valid_until IS NULL');
  stmt.bind({ $date: thirtyDaysAgo });
  while (stmt.step()) {
    stats.staleItems++;
  }
  stmt.free();
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
  // 8. Build connections graph
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
