import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig, setConfig } from './db.js';

// ============================================================
// Entity Graph Builder — Phase 2 of v1.0 Brain Architecture
// ============================================================

// ── Name normalization ────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|esq|phd|md|dds)\b\.?/gi, '')
    .replace(/\b[a-z]\.\s*/g, '') // remove middle initials like "S."
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEmailFromHeader(header: string): { name: string; email: string } | null {
  // "Forrest Pullen <forrest@recaptureinsurance.com>"
  const match = header.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].toLowerCase() };

  // "forrest@recaptureinsurance.com"
  if (header.includes('@') && !header.includes(' ')) {
    return { name: '', email: header.toLowerCase() };
  }

  return null;
}

function extractDomain(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  // Skip generic domains
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'me.com', 'live.com'];
  if (generic.includes(domain)) return null;
  return domain;
}

// ── Entity CRUD ──────────────────────────────────────────────

export function getEntity(db: Database.Database, nameOrEmail: string): any {
  // Try email match first
  const byEmail = db.prepare('SELECT * FROM entities WHERE email = ?').get(nameOrEmail.toLowerCase());
  if (byEmail) return byEmail;

  // Try canonical name
  const byName = db.prepare('SELECT * FROM entities WHERE canonical_name = ?').get(nameOrEmail);
  if (byName) return byName;

  // Try alias lookup
  const normalized = normalizeName(nameOrEmail);
  const alias = db.prepare(
    'SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?'
  ).get(normalized) as any;
  if (alias) {
    return db.prepare('SELECT * FROM entities WHERE id = ?').get(alias.entity_id);
  }

  return null;
}

export function listEntities(db: Database.Database, options: {
  type?: string;
  dismissed?: boolean;
  limit?: number;
} = {}): any[] {
  const limit = options.limit || 100;
  let sql = 'SELECT e.*, ';
  sql += '(SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) as mention_count ';
  sql += 'FROM entities e WHERE 1=1 ';

  const params: any[] = [];
  if (options.type) { sql += 'AND e.type = ? '; params.push(options.type); }
  if (options.dismissed === false) { sql += 'AND e.user_dismissed = 0 '; }
  if (options.dismissed === true) { sql += 'AND e.user_dismissed = 1 '; }

  sql += 'ORDER BY mention_count DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as any[];
}

export function labelEntity(db: Database.Database, nameOrEmail: string, label: string): boolean {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return false;

  db.prepare('UPDATE entities SET user_label = ?, relationship_type = ?, relationship_confidence = 1.0, updated_at = datetime(\'now\') WHERE id = ?')
    .run(label, label, entity.id);
  return true;
}

export function dismissEntity(db: Database.Database, nameOrEmail: string, reason?: string): boolean {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return false;

  db.prepare('UPDATE entities SET user_dismissed = 1, updated_at = datetime(\'now\') WHERE id = ?')
    .run(entity.id);

  db.prepare('INSERT OR IGNORE INTO dismissals (id, entity_id, reason, dismissed_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(uuid(), entity.id, reason || 'user dismissed');
  return true;
}

export function dismissDomain(db: Database.Database, domain: string, reason?: string): number {
  // Dismiss all entities with this domain
  const result = db.prepare('UPDATE entities SET user_dismissed = 1, updated_at = datetime(\'now\') WHERE domain = ?')
    .run(domain);

  db.prepare('INSERT OR IGNORE INTO dismissals (id, domain, reason, dismissed_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(uuid(), domain, reason || `domain dismissed: ${domain}`);

  return result.changes;
}

export function mergeEntities(db: Database.Database, fromName: string, toName: string): boolean {
  const fromEntity = getEntity(db, fromName);
  const toEntity = getEntity(db, toName);
  if (!fromEntity || !toEntity) return false;
  if (fromEntity.id === toEntity.id) return true; // already same

  // Move all mentions from source to target
  const mentions = db.prepare('SELECT * FROM entity_mentions WHERE entity_id = ?').all(fromEntity.id) as any[];
  for (const m of mentions) {
    try {
      db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uuid(), toEntity.id, m.knowledge_item_id, m.role, m.direction, m.mention_date);
    } catch {}
  }

  // Move aliases
  db.prepare('UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?').run(toEntity.id, fromEntity.id);

  // Add source name as alias on target
  try {
    db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), toEntity.id, fromEntity.canonical_name, normalizeName(fromEntity.canonical_name), 'merge');
  } catch {}

  // Copy email if target doesn't have one
  if (!toEntity.email && fromEntity.email) {
    db.prepare('UPDATE entities SET email = ?, domain = ? WHERE id = ?')
      .run(fromEntity.email, fromEntity.domain, toEntity.id);
  }

  // Delete source entity
  db.prepare('DELETE FROM entities WHERE id = ?').run(fromEntity.id);

  return true;
}

// ── Seeding from user input ──────────────────────────────────

export function seedEntitiesFromUserInput(
  db: Database.Database,
  seeds: { employees?: string[]; partners?: string[]; projects?: string[] }
): { created: number } {
  let created = 0;

  const createOrLabel = (name: string, type: string, label: string) => {
    const existing = getEntity(db, name);
    if (existing) {
      db.prepare('UPDATE entities SET user_label = ?, relationship_type = ?, relationship_confidence = 1.0 WHERE id = ?')
        .run(label, label, existing.id);
    } else {
      const id = uuid();
      db.prepare(`INSERT INTO entities (id, type, canonical_name, relationship_type, relationship_confidence, user_label, created_at) VALUES (?, ?, ?, ?, 1.0, ?, datetime('now'))`)
        .run(id, type, name, label, label);
      db.prepare('INSERT INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), id, name, normalizeName(name), 'user_seed');
      created++;
    }
  };

  for (const emp of seeds.employees || []) createOrLabel(emp, 'person', 'employee');
  for (const partner of seeds.partners || []) createOrLabel(partner, 'person', 'partner');
  for (const proj of seeds.projects || []) createOrLabel(proj, 'project', 'project');

  return { created };
}

// ── Entity Graph Builder ─────────────────────────────────────

export function buildEntityGraph(
  db: Database.Database,
  options: { incremental?: boolean } = {}
): { entities: number; mentions: number; edges: number; merged: number } {
  const stats = { entities: 0, mentions: 0, edges: 0, merged: 0 };

  // Get all knowledge items (or incremental since last build)
  let items: any[];
  if (options.incremental) {
    const lastBuild = db.prepare("SELECT value FROM graph_state WHERE key = 'last_entity_build'").get() as any;
    const since = lastBuild?.value || '2000-01-01';
    items = db.prepare('SELECT * FROM knowledge WHERE source_date > ? ORDER BY source_date ASC').all(since) as any[];
  } else {
    items = db.prepare('SELECT * FROM knowledge ORDER BY source_date ASC').all() as any[];
  }

  console.log(`  Processing ${items.length} items for entities...`);

  // Build email→entity lookup from existing entities
  const emailMap = new Map<string, string>(); // email → entity_id
  const aliasMap = new Map<string, string>(); // normalized_name → entity_id
  const existingEntities = db.prepare('SELECT id, email, canonical_name FROM entities').all() as any[];
  for (const e of existingEntities) {
    if (e.email) emailMap.set(e.email.toLowerCase(), e.id);
    aliasMap.set(normalizeName(e.canonical_name), e.id);
  }

  // Also load all aliases
  const existingAliases = db.prepare('SELECT entity_id, alias_normalized FROM entity_aliases').all() as any[];
  for (const a of existingAliases) {
    aliasMap.set(a.alias_normalized, a.entity_id);
  }

  // Process each item
  const itemEntities = new Map<string, Set<string>>(); // item_id → set of entity_ids

  for (const item of items) {
    const contacts = parseJsonArray(item.contacts);
    const orgs = parseJsonArray(item.organizations);
    const meta = parseJsonObj(item.metadata);
    const entityIds = new Set<string>();

    // Extract email from metadata.last_from (Gmail items)
    let fromEmail: string | null = null;
    let fromName: string | null = null;
    if (meta.last_from) {
      const parsed = parseEmailFromHeader(meta.last_from);
      if (parsed) {
        fromEmail = parsed.email;
        fromName = parsed.name || null;
      }
    }

    // Process each contact name
    for (const contactName of contacts) {
      if (!contactName || contactName.length < 2) continue;

      const normalized = normalizeName(contactName);
      if (!normalized) continue;

      // Try to match to existing entity
      let entityId: string | null = null;

      // 1. Email match (if this contact matches the from email)
      if (fromEmail && fromName && normalizeName(fromName) === normalized) {
        entityId = emailMap.get(fromEmail) || null;
      }

      // 2. Alias/name match
      if (!entityId) {
        entityId = aliasMap.get(normalized) || null;
      }

      // 3. Create new entity
      if (!entityId) {
        entityId = uuid();
        const email = (fromName && normalizeName(fromName) === normalized) ? fromEmail : null;
        const domain = email ? extractDomain(email) : null;

        db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical_name, email, domain, first_seen_date, last_seen_date, created_at) VALUES (?, 'person', ?, ?, ?, ?, ?, datetime('now'))`)
          .run(entityId, contactName, email, domain, item.source_date, item.source_date);

        db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), entityId, contactName, normalized, 'extraction');

        if (email) emailMap.set(email, entityId);
        aliasMap.set(normalized, entityId);
        stats.entities++;
      }

      // Create mention
      const direction = meta.waiting_on_user === false ? 'outbound' : (meta.waiting_on_user === true ? 'inbound' : null);
      try {
        db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuid(), entityId, item.id, 'mentioned', direction, item.source_date);
        stats.mentions++;
      } catch {}

      // Update last_seen_date
      db.prepare('UPDATE entities SET last_seen_date = MAX(COALESCE(last_seen_date, ?), ?) WHERE id = ?')
        .run(item.source_date, item.source_date, entityId);

      entityIds.add(entityId);
    }

    // Process organizations
    for (const orgName of orgs) {
      if (!orgName || orgName.length < 2) continue;
      const normalized = normalizeName(orgName);
      if (!normalized) continue;

      let entityId = aliasMap.get(normalized) || null;
      if (!entityId) {
        entityId = uuid();
        db.prepare(`INSERT OR IGNORE INTO entities (id, type, canonical_name, first_seen_date, last_seen_date, created_at) VALUES (?, 'organization', ?, ?, ?, datetime('now'))`)
          .run(entityId, orgName, item.source_date, item.source_date);
        db.prepare('INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), entityId, orgName, normalized, 'extraction');
        aliasMap.set(normalized, entityId);
        stats.entities++;
      }

      try {
        db.prepare('INSERT OR IGNORE INTO entity_mentions (id, entity_id, knowledge_item_id, role, direction, mention_date) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuid(), entityId, item.id, 'mentioned', null, item.source_date);
        stats.mentions++;
      } catch {}

      entityIds.add(entityId);
    }

    // Store for co-occurrence edge building
    if (entityIds.size > 0) {
      itemEntities.set(item.id, entityIds);
    }

    // Progress
    if (items.indexOf(item) % 100 === 0) {
      process.stdout.write(`\r  Processed: ${items.indexOf(item)}/${items.length}`);
    }
  }
  console.log(`\r  Processed: ${items.length}/${items.length}`);

  // Build co-occurrence edges
  console.log('  Building co-occurrence edges...');
  for (const [itemId, entityIds] of itemEntities) {
    const ids = Array.from(entityIds);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]].sort(); // canonical order
        try {
          const existing = db.prepare(
            'SELECT id, co_occurrence_count FROM entity_edges WHERE source_entity_id = ? AND target_entity_id = ? AND edge_type = ?'
          ).get(a, b, 'co_occurs') as any;

          if (existing) {
            db.prepare('UPDATE entity_edges SET co_occurrence_count = co_occurrence_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
              .run(existing.id);
          } else {
            const edgeId = uuid();
            db.prepare('INSERT INTO entity_edges (id, source_entity_id, target_entity_id, edge_type, co_occurrence_count, confidence, created_at) VALUES (?, ?, ?, ?, 1, 0.5, datetime(\'now\'))')
              .run(edgeId, a, b, 'co_occurs');
            stats.edges++;
          }

          // Add evidence
          db.prepare('INSERT OR IGNORE INTO edge_evidence (id, edge_id, knowledge_item_id, evidence_date) VALUES (?, (SELECT id FROM entity_edges WHERE source_entity_id = ? AND target_entity_id = ? AND edge_type = ?), ?, ?)')
            .run(uuid(), a, b, 'co_occurs', itemId, null);
        } catch {}
      }
    }
  }

  // Auto-merge entities with same email
  console.log('  Checking for email-based merges...');
  const emailGroups = db.prepare(
    'SELECT email, GROUP_CONCAT(id) as ids, COUNT(*) as cnt FROM entities WHERE email IS NOT NULL GROUP BY email HAVING cnt > 1'
  ).all() as any[];

  for (const group of emailGroups) {
    const ids = group.ids.split(',');
    const primary = ids[0];
    for (let i = 1; i < ids.length; i++) {
      const fromEntity = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(ids[i]) as any;
      const toEntity = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(primary) as any;
      if (fromEntity && toEntity) {
        mergeEntities(db, fromEntity.canonical_name, toEntity.canonical_name);
        stats.merged++;
      }
    }
  }

  // Update graph state
  const latestDate = items.length > 0 ? items[items.length - 1].source_date : new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_entity_build', ?, datetime('now'))")
    .run(latestDate);

  return stats;
}

// ── Entity Profile ───────────────────────────────────────────

export function getEntityProfile(db: Database.Database, nameOrEmail: string): any {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return null;

  // Get mention count and stats
  const mentionStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
      MIN(mention_date) as first_seen,
      MAX(mention_date) as last_seen
    FROM entity_mentions WHERE entity_id = ?
  `).get(entity.id) as any;

  // Get projects (from knowledge items this entity appears in)
  const projects = db.prepare(`
    SELECT DISTINCT k.project FROM knowledge k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ? AND k.project IS NOT NULL
  `).all(entity.id) as any[];

  // Get aliases
  const aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(entity.id) as any[];

  // Get recent items
  const recentItems = db.prepare(`
    SELECT k.id, k.title, k.source, k.source_date
    FROM knowledge k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
    ORDER BY k.source_date DESC LIMIT 5
  `).all(entity.id) as any[];

  // Get connected entities (co-occurrence)
  const connected = db.prepare(`
    SELECT e.canonical_name, e.relationship_type, ee.co_occurrence_count
    FROM entity_edges ee
    JOIN entities e ON (
      CASE WHEN ee.source_entity_id = ? THEN ee.target_entity_id
           ELSE ee.source_entity_id END = e.id
    )
    WHERE (ee.source_entity_id = ? OR ee.target_entity_id = ?)
      AND e.user_dismissed = 0
    ORDER BY ee.co_occurrence_count DESC LIMIT 10
  `).all(entity.id, entity.id, entity.id) as any[];

  // Get open commitments
  const commitments = db.prepare(`
    SELECT text, state, due_date FROM commitments
    WHERE (owner LIKE ? OR assigned_to LIKE ?)
      AND state IN ('active', 'overdue', 'detected')
  `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

  const daysSince = mentionStats.last_seen
    ? Math.floor((Date.now() - new Date(mentionStats.last_seen).getTime()) / 86400000)
    : null;

  return {
    ...entity,
    mention_count: mentionStats.total,
    inbound: mentionStats.inbound,
    outbound: mentionStats.outbound,
    days_since: daysSince,
    status: daysSince === null ? 'unknown' :
            daysSince <= 3 ? 'active' :
            daysSince <= 7 ? 'warm' :
            daysSince <= 14 ? 'cooling' :
            daysSince <= 30 ? 'cold' : 'dormant',
    projects: projects.map(p => p.project),
    aliases: aliases.map(a => a.alias),
    recent_items: recentItems,
    connected: connected,
    commitments: commitments,
  };
}

// ── Implicit Learning ────────────────────────────────────────

export function recordSignal(db: Database.Database, entityName: string, signalType: string): void {
  const entity = getEntity(db, entityName);
  if (!entity) return;

  const existing = db.prepare(
    'SELECT id, count FROM entity_signals WHERE entity_id = ? AND signal_type = ?'
  ).get(entity.id, signalType) as any;

  if (existing) {
    db.prepare('UPDATE entity_signals SET count = count + 1, last_seen = datetime(\'now\') WHERE id = ?')
      .run(existing.id);
  } else {
    db.prepare('INSERT INTO entity_signals (id, entity_id, signal_type, count, last_seen) VALUES (?, ?, ?, 1, datetime(\'now\'))')
      .run(uuid(), entity.id, signalType);
  }

  // Auto-actions based on signal accumulation
  if (signalType === 'alert_ignored' && (existing?.count || 0) + 1 >= 3) {
    // Auto-demote after 3 ignores
    db.prepare('UPDATE entities SET relationship_type = \'noise\', relationship_confidence = 0.6, updated_at = datetime(\'now\') WHERE id = ? AND user_label IS NULL')
      .run(entity.id);
  }

  if (signalType === 'alert_acted' && (existing?.count || 0) + 1 >= 5) {
    // Auto-elevate after 5 actions
    if (!entity.relationship_type || entity.relationship_type === 'unknown') {
      db.prepare('UPDATE entities SET relationship_type = \'partner\', relationship_confidence = 0.7, updated_at = datetime(\'now\') WHERE id = ? AND user_label IS NULL')
        .run(entity.id);
    }
  }
}

export function getSignals(db: Database.Database, entityName: string): any[] {
  const entity = getEntity(db, entityName);
  if (!entity) return [];
  return db.prepare('SELECT signal_type, count, last_seen FROM entity_signals WHERE entity_id = ?').all(entity.id) as any[];
}

// ── Communication Pattern Analysis ───────────────────────────

export interface CommunicationPattern {
  entity_name: string;
  total_interactions: number;
  inbound: number;
  outbound: number;
  avg_gap_days: number;        // average days between interactions
  last_interaction: string;
  days_since: number;
  interaction_frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'rare';
  trend: 'increasing' | 'stable' | 'decreasing' | 'stalled';
  sources: string[];
  projects: string[];
  peak_day?: string;           // day of week with most interactions
}

export function analyzeEntityPattern(db: Database.Database, nameOrEmail: string): CommunicationPattern | null {
  const entity = getEntity(db, nameOrEmail);
  if (!entity) return null;

  // Get all mentions with dates
  const mentions = db.prepare(`
    SELECT em.direction, em.mention_date, k.source, k.project
    FROM entity_mentions em
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE em.entity_id = ? AND em.mention_date IS NOT NULL
    ORDER BY em.mention_date ASC
  `).all(entity.id) as any[];

  if (mentions.length < 2) return null;

  const inbound = mentions.filter((m: any) => m.direction === 'inbound').length;
  const outbound = mentions.filter((m: any) => m.direction === 'outbound').length;
  const sources = [...new Set(mentions.map((m: any) => m.source))];
  const projects = [...new Set(mentions.filter((m: any) => m.project).map((m: any) => m.project))];

  // Calculate average gap between interactions
  const dates = mentions.map((m: any) => new Date(m.mention_date).getTime()).sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / 86400000);
  }
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  // Frequency classification
  let frequency: CommunicationPattern['interaction_frequency'];
  if (avgGap <= 1.5) frequency = 'daily';
  else if (avgGap <= 7) frequency = 'weekly';
  else if (avgGap <= 14) frequency = 'biweekly';
  else if (avgGap <= 30) frequency = 'monthly';
  else if (avgGap <= 90) frequency = 'quarterly';
  else frequency = 'rare';

  // Trend: compare recent 14d activity to previous 14d
  const now = Date.now();
  const recent = mentions.filter((m: any) => now - new Date(m.mention_date).getTime() < 14 * 86400000).length;
  const previous = mentions.filter((m: any) => {
    const t = now - new Date(m.mention_date).getTime();
    return t >= 14 * 86400000 && t < 28 * 86400000;
  }).length;

  let trend: CommunicationPattern['trend'];
  if (recent === 0) trend = 'stalled';
  else if (recent > previous * 1.5) trend = 'increasing';
  else if (recent < previous * 0.5) trend = 'decreasing';
  else trend = 'stable';

  // Peak day of week
  const dayCount: Record<string, number> = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const m of mentions) {
    const day = dayNames[new Date(m.mention_date).getDay()];
    dayCount[day] = (dayCount[day] || 0) + 1;
  }
  const peakDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0];

  const lastMention = mentions[mentions.length - 1];
  const daysSince = Math.floor((now - new Date(lastMention.mention_date).getTime()) / 86400000);

  return {
    entity_name: entity.canonical_name,
    total_interactions: mentions.length,
    inbound,
    outbound,
    avg_gap_days: Math.round(avgGap * 10) / 10,
    last_interaction: lastMention.mention_date,
    days_since: daysSince,
    interaction_frequency: frequency,
    trend,
    sources,
    projects,
    peak_day: peakDay,
  };
}

/**
 * Get communication patterns for all active, non-dismissed entities.
 */
export function getTopPatterns(db: Database.Database, limit: number = 20): CommunicationPattern[] {
  const entities = db.prepare(`
    SELECT e.canonical_name FROM entities e
    LEFT JOIN entity_mentions em ON e.id = em.entity_id
    WHERE e.type = 'person' AND e.user_dismissed = 0 AND e.canonical_name != 'Zach Stock'
    GROUP BY e.id HAVING COUNT(em.id) >= 5
    ORDER BY COUNT(em.id) DESC LIMIT ?
  `).all(limit) as any[];

  return entities
    .map((e: any) => analyzeEntityPattern(db, e.canonical_name))
    .filter(Boolean) as CommunicationPattern[];
}

// ── Helpers ──────────────────────────────────────────────────

function parseJsonArray(val: any): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch {}
  }
  return [];
}

function parseJsonObj(val: any): any {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch {}
  }
  return {};
}
