import type { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import {
  searchByText,
  cosineSimilarity,
  getConfig,
  saveDb,
  insertConnection,
  clearConnections,
  getConnectionsForItem,
  getConnectionStats,
} from '../db.js';
import { getDefaultProvider } from './providers.js';

// ============================================================
// Types
// ============================================================

type RelationshipType = 'mentions' | 'follows_up' | 'related_to' | 'part_of' | 'contradicts' | 'supersedes';

interface ConnectionStats {
  total: number;
  byType: Record<RelationshipType, number>;
}

interface ConnectedItem {
  item: any;
  relationship: string;
  confidence: number;
  depth: number;
}

interface ContactGraph {
  contact: string;
  directItems: any[];
  connectedItems: any[];
  projects: string[];
  relationships: { type: string; count: number }[];
}

// ============================================================
// Helper: decode embedding BLOB to number[]
// ============================================================

function decodeEmbedding(blob: any): number[] | null {
  if (!blob) return null;
  if (blob instanceof Uint8Array) {
    const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(floats);
  }
  return null;
}

// ============================================================
// Helper: parse JSON field safely
// ============================================================

function parseJsonField(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

// ============================================================
// buildConnections
// ============================================================

export async function buildConnections(
  db: SqlJsDatabase,
  options?: { verbose?: boolean }
): Promise<ConnectionStats> {
  const log = options?.verbose ? console.log : () => {};
  const stats: ConnectionStats = {
    total: 0,
    byType: { mentions: 0, follows_up: 0, related_to: 0, part_of: 0, contradicts: 0, supersedes: 0 },
  };

  // Clear existing connections
  clearConnections(db);

  // Load all items
  const items = searchByText(db, '', 1000);
  if (items.length === 0) return stats;

  log(`    Analyzing ${items.length} items for connections...`);

  // Pre-parse contacts and embeddings
  const parsed = items.map(item => ({
    ...item,
    _contacts: parseJsonField(item.contacts).map((c: string) => c.toLowerCase().trim()),
    _contactsRaw: parseJsonField(item.contacts),
    _embedding: decodeEmbedding(item.embedding),
  }));

  // ----------------------------------------------------------
  // 1. mentions — shared contacts
  // ----------------------------------------------------------
  log('    Detecting mentions (shared contacts)...');
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      if (a._contacts.length === 0 || b._contacts.length === 0) continue;

      const shared = a._contacts.filter((c: string) => b._contacts.includes(c));
      if (shared.length > 0) {
        const maxContacts = Math.max(a._contacts.length, b._contacts.length);
        const confidence = shared.length / maxContacts;
        insertConnection(db, {
          id: uuid(),
          source_id: a.id,
          target_id: b.id,
          relationship: 'mentions',
          confidence: Math.round(confidence * 100) / 100,
        });
        stats.byType.mentions++;
        stats.total++;
      }
    }
  }
  log(`      ${stats.byType.mentions} mention connections`);

  // ----------------------------------------------------------
  // 2. part_of — same project
  // ----------------------------------------------------------
  log('    Detecting part_of (same project)...');
  const projectGroups = new Map<string, typeof parsed>();
  for (const item of parsed) {
    if (item.project) {
      const group = projectGroups.get(item.project) || [];
      group.push(item);
      projectGroups.set(item.project, group);
    }
  }

  for (const [_project, group] of projectGroups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        insertConnection(db, {
          id: uuid(),
          source_id: group[i].id,
          target_id: group[j].id,
          relationship: 'part_of',
          confidence: 1.0,
        });
        stats.byType.part_of++;
        stats.total++;
      }
    }
  }
  log(`      ${stats.byType.part_of} part_of connections`);

  // ----------------------------------------------------------
  // 3. follows_up — same source with related source_ref
  // ----------------------------------------------------------
  log('    Detecting follows_up (related source_ref)...');
  const refGroups = new Map<string, typeof parsed>();
  for (const item of parsed) {
    if (!item.source_ref) continue;
    // Extract thread prefix: "thread:ABC123" -> "thread:ABC123"
    // For Gmail threads, group by thread ID prefix
    const ref = String(item.source_ref);
    let prefix: string | null = null;

    if (ref.startsWith('thread:')) {
      prefix = ref; // Same thread ID = same thread
    } else if (ref.includes(':')) {
      // Group by source type prefix (e.g., "gmail:threadXYZ" -> "gmail:threadXYZ")
      prefix = ref;
    }

    if (prefix) {
      const group = refGroups.get(prefix) || [];
      group.push(item);
      refGroups.set(prefix, group);
    }
  }

  for (const [_ref, group] of refGroups) {
    if (group.length < 2) continue;
    // Sort by source_date to establish follow-up order
    group.sort((a, b) => {
      const da = a.source_date ? new Date(a.source_date).getTime() : 0;
      const db2 = b.source_date ? new Date(b.source_date).getTime() : 0;
      return da - db2;
    });
    for (let i = 0; i < group.length - 1; i++) {
      insertConnection(db, {
        id: uuid(),
        source_id: group[i].id,
        target_id: group[i + 1].id,
        relationship: 'follows_up',
        confidence: 1.0,
      });
      stats.byType.follows_up++;
      stats.total++;
    }
  }
  log(`      ${stats.byType.follows_up} follows_up connections`);

  // ----------------------------------------------------------
  // 4. related_to — embedding similarity > 0.7 (within same project)
  // ----------------------------------------------------------
  log('    Detecting related_to (embedding similarity)...');
  for (const [_project, group] of projectGroups) {
    const withEmb = group.filter(i => i._embedding !== null);
    for (let i = 0; i < withEmb.length; i++) {
      for (let j = i + 1; j < withEmb.length; j++) {
        const sim = cosineSimilarity(withEmb[i]._embedding!, withEmb[j]._embedding!);
        if (sim > 0.7) {
          insertConnection(db, {
            id: uuid(),
            source_id: withEmb[i].id,
            target_id: withEmb[j].id,
            relationship: 'related_to',
            confidence: Math.round(sim * 100) / 100,
          });
          stats.byType.related_to++;
          stats.total++;
        }
      }
    }
  }
  // Also check items without a project against each other
  const noProject = parsed.filter(i => !i.project && i._embedding !== null);
  for (let i = 0; i < noProject.length; i++) {
    for (let j = i + 1; j < noProject.length; j++) {
      const sim = cosineSimilarity(noProject[i]._embedding!, noProject[j]._embedding!);
      if (sim > 0.7) {
        insertConnection(db, {
          id: uuid(),
          source_id: noProject[i].id,
          target_id: noProject[j].id,
          relationship: 'related_to',
          confidence: Math.round(sim * 100) / 100,
        });
        stats.byType.related_to++;
        stats.total++;
      }
    }
  }
  log(`      ${stats.byType.related_to} related_to connections`);

  // ----------------------------------------------------------
  // 5. supersedes — same contacts + same project + newer date
  // ----------------------------------------------------------
  log('    Detecting supersedes (newer items on same topic)...');
  for (const [_project, group] of projectGroups) {
    // Sort by date descending
    const dated = group
      .filter(i => i.source_date)
      .sort((a, b) => new Date(b.source_date).getTime() - new Date(a.source_date).getTime());

    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const newer = dated[i];
        const older = dated[j];
        // Check for shared contacts
        const sharedContacts = newer._contacts.filter((c: string) => older._contacts.includes(c));
        if (sharedContacts.length > 0 && newer._embedding && older._embedding) {
          const sim = cosineSimilarity(newer._embedding, older._embedding);
          if (sim > 0.6) {
            insertConnection(db, {
              id: uuid(),
              source_id: newer.id,
              target_id: older.id,
              relationship: 'supersedes',
              confidence: 0.8,
            });
            stats.byType.supersedes++;
            stats.total++;
          }
        }
      }
    }
  }
  log(`      ${stats.byType.supersedes} supersedes connections`);

  // ----------------------------------------------------------
  // 6. contradicts — high-similarity + same project, ask Claude
  // ----------------------------------------------------------
  log('    Detecting contradicts (conflicting information)...');
  const candidatePairs: { a: any; b: any; sim: number }[] = [];
  for (const [_project, group] of projectGroups) {
    const withEmb = group.filter(i => i._embedding !== null);
    for (let i = 0; i < withEmb.length; i++) {
      for (let j = i + 1; j < withEmb.length; j++) {
        const sim = cosineSimilarity(withEmb[i]._embedding!, withEmb[j]._embedding!);
        if (sim > 0.6) {
          candidatePairs.push({ a: withEmb[i], b: withEmb[j], sim });
        }
      }
    }
  }

  if (candidatePairs.length > 0) {
    // Limit Claude calls — only check top 20 highest similarity pairs
    const topPairs = candidatePairs
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 20);

    try {
      const apiKey = getConfig(db, 'openai_api_key');
      const provider = await getDefaultProvider(apiKey || undefined);

      // Batch pairs into a single Claude call
      const pairText = topPairs.map((p, idx) =>
        `[${idx}]\nA: "${p.a.title}" — ${p.a.summary}\nB: "${p.b.title}" — ${p.b.summary}`
      ).join('\n\n');

      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `You detect contradictions between knowledge items. Two items contradict if they make conflicting claims about the same topic (e.g., different dates for the same event, conflicting decisions, disagreeing numbers).

Items that are merely different aspects of the same topic do NOT contradict.

Return JSON: {"contradictions": [{"index": 0, "confidence": 0.9, "reason": "..."}, ...]}
Only include pairs that genuinely contradict. Empty array if none.`,
          },
          { role: 'user', content: pairText },
        ],
        { temperature: 0.1, max_tokens: 1000, json: true }
      );

      const result = JSON.parse(response);
      const contradictions = result.contradictions || [];
      for (const c of contradictions) {
        const pair = topPairs[c.index];
        if (pair) {
          insertConnection(db, {
            id: uuid(),
            source_id: pair.a.id,
            target_id: pair.b.id,
            relationship: 'contradicts',
            confidence: c.confidence || 0.7,
          });
          stats.byType.contradicts++;
          stats.total++;
        }
      }
    } catch (err: any) {
      log(`      ⚠ Could not detect contradictions: ${err.message}`);
    }
  }
  log(`      ${stats.byType.contradicts} contradicts connections`);

  saveDb();
  log(`    Total: ${stats.total} connections created`);

  return stats;
}

// ============================================================
// getConnections — graph traversal up to N hops
// ============================================================

export function getConnections(
  db: SqlJsDatabase,
  itemId: string,
  depth: number = 1
): ConnectedItem[] {
  const visited = new Set<string>();
  visited.add(itemId);
  const results: ConnectedItem[] = [];

  let frontier = [itemId];

  for (let d = 1; d <= depth; d++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      const connections = getConnectionsForItem(db, currentId);

      for (const conn of connections) {
        const connectedId = conn.source_id === currentId ? conn.target_id : conn.source_id;
        if (visited.has(connectedId)) continue;
        visited.add(connectedId);

        // Fetch the connected item
        const stmt = db.prepare('SELECT * FROM knowledge WHERE id = ?');
        stmt.bind([connectedId]);
        let item: any = null;
        if (stmt.step()) {
          item = stmt.getAsObject();
          // Parse JSON fields
          for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
            if (item[field] && typeof item[field] === 'string') {
              try { item[field] = JSON.parse(item[field]); } catch {}
            }
          }
          item.embedding = null; // Don't return embeddings
        }
        stmt.free();

        if (item) {
          results.push({
            item,
            relationship: conn.relationship,
            confidence: conn.confidence,
            depth: d,
          });
          nextFrontier.push(connectedId);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ============================================================
// getContactGraph — find all items for a contact + their connections
// ============================================================

export function getContactGraph(
  db: SqlJsDatabase,
  contactName: string
): ContactGraph {
  const nameLower = contactName.toLowerCase().trim();

  // Find all items mentioning this contact
  const allItems = searchByText(db, contactName, 1000);
  const directItems = allItems.filter(item => {
    const contacts = parseJsonField(item.contacts);
    return contacts.some((c: string) => c.toLowerCase().trim().includes(nameLower));
  });

  // Get connections for each direct item
  const connectedItemMap = new Map<string, { item: any; via: string }>();
  const directIds = new Set(directItems.map(i => i.id));

  for (const item of directItems) {
    const connections = getConnectionsForItem(db, item.id);
    for (const conn of connections) {
      const connectedId = conn.source_id === item.id ? conn.target_id : conn.source_id;
      if (directIds.has(connectedId)) continue;
      if (connectedItemMap.has(connectedId)) continue;

      // Fetch the item
      const stmt = db.prepare('SELECT * FROM knowledge WHERE id = ?');
      stmt.bind([connectedId]);
      if (stmt.step()) {
        const connItem = stmt.getAsObject();
        for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
          if (connItem[field] && typeof connItem[field] === 'string') {
            try { connItem[field] = JSON.parse(connItem[field] as string); } catch {}
          }
        }
        connItem.embedding = null;

        // Determine shared contact for the "via" label
        const sharedContacts = parseJsonField(connItem.contacts).filter(
          (c: string) => !c.toLowerCase().trim().includes(nameLower)
        );
        const via = sharedContacts.length > 0
          ? `shares: ${sharedContacts[0]}`
          : conn.relationship;

        connectedItemMap.set(connectedId, { item: connItem, via });
      }
      stmt.free();
    }
  }

  // Collect projects
  const projectCounts = new Map<string, number>();
  for (const item of directItems) {
    if (item.project) {
      projectCounts.set(item.project, (projectCounts.get(item.project) || 0) + 1);
    }
  }
  const projects = Array.from(projectCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`);

  // Collect relationship type counts
  const relCounts = new Map<string, number>();
  for (const item of directItems) {
    const connections = getConnectionsForItem(db, item.id);
    for (const conn of connections) {
      relCounts.set(conn.relationship, (relCounts.get(conn.relationship) || 0) + 1);
    }
  }
  const relationships = Array.from(relCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  return {
    contact: contactName,
    directItems,
    connectedItems: Array.from(connectedItemMap.values()).map(v => ({ ...v.item, _via: v.via })),
    projects,
    relationships,
  };
}
