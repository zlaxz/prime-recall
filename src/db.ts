import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PRIME_DIR = join(homedir(), '.prime');
const DB_PATH = join(PRIME_DIR, 'prime.db');

let _db: SqlJsDatabase | null = null;

export function ensurePrimeDir(): string {
  if (!existsSync(PRIME_DIR)) {
    mkdirSync(PRIME_DIR, { recursive: true });
  }
  for (const sub of ['artifacts', 'conversations', 'cache', 'logs']) {
    const dir = join(PRIME_DIR, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return PRIME_DIR;
}

export async function getDb(): Promise<SqlJsDatabase> {
  if (_db) return _db;

  ensurePrimeDir();
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }

  initSchema(_db);
  return _db;
}

export function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

function initSchema(db: SqlJsDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_date TEXT,
      contacts TEXT DEFAULT '[]',
      organizations TEXT DEFAULT '[]',
      decisions TEXT DEFAULT '[]',
      commitments TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      project TEXT,
      importance TEXT DEFAULT 'normal',
      valid_from TEXT DEFAULT (datetime('now')),
      valid_until TEXT,
      superseded_by TEXT,
      embedding BLOB,
      artifact_path TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      source_id TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relationship)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      last_sync_at TEXT,
      last_cursor TEXT,
      items_synced INTEGER DEFAULT 0,
      status TEXT DEFAULT 'idle',
      error TEXT,
      config TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_importance ON knowledge(importance);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source_date ON knowledge(source_date);

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      item_ids TEXT NOT NULL,
      source TEXT,
      project TEXT,
      date_start TEXT,
      date_end TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS semantics (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      episode_ids TEXT,
      item_ids TEXT,
      project TEXT,
      contacts TEXT,
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT,
      confidence REAL DEFAULT 1.0,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      semantic_ids TEXT NOT NULL,
      parent_theme_id TEXT,
      size INTEGER DEFAULT 0,
      centroid BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
    CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project);
    CREATE INDEX IF NOT EXISTS idx_episodes_date_start ON episodes(date_start);
    CREATE INDEX IF NOT EXISTS idx_semantics_fact_type ON semantics(fact_type);
    CREATE INDEX IF NOT EXISTS idx_semantics_project ON semantics(project);
    CREATE INDEX IF NOT EXISTS idx_semantics_valid_until ON semantics(valid_until);
    CREATE INDEX IF NOT EXISTS idx_themes_parent ON themes(parent_theme_id);

    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      owner TEXT,
      assigned_to TEXT,
      due_date TEXT,
      detected_from TEXT,
      detected_at TEXT DEFAULT (datetime('now')),
      state TEXT DEFAULT 'detected',
      state_changed_at TEXT,
      fulfilled_evidence TEXT,
      context TEXT,
      project TEXT,
      importance TEXT DEFAULT 'normal',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_state ON commitments(state);
    CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(due_date);
    CREATE INDEX IF NOT EXISTS idx_commitments_owner ON commitments(owner);
  `);

  saveDb();
}

export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  source_ref: string;
  source_date?: string;
  contacts?: string[];
  organizations?: string[];
  decisions?: string[];
  commitments?: string[];
  action_items?: string[];
  tags?: string[];
  project?: string;
  importance?: string;
  embedding?: number[];
  artifact_path?: string;
  metadata?: Record<string, any>;
}

export function insertKnowledge(db: SqlJsDatabase, item: KnowledgeItem) {
  const embeddingBlob = item.embedding
    ? Buffer.from(new Float32Array(item.embedding).buffer)
    : null;

  db.run(
    `INSERT OR REPLACE INTO knowledge
    (id, title, summary, source, source_ref, source_date, contacts, organizations,
     decisions, commitments, action_items, tags, project, importance, embedding,
     artifact_path, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      item.id,
      item.title,
      item.summary,
      item.source,
      item.source_ref,
      item.source_date || null,
      JSON.stringify(item.contacts || []),
      JSON.stringify(item.organizations || []),
      JSON.stringify(item.decisions || []),
      JSON.stringify(item.commitments || []),
      JSON.stringify(item.action_items || []),
      JSON.stringify(item.tags || []),
      item.project || null,
      item.importance || 'normal',
      embeddingBlob,
      item.artifact_path || null,
      JSON.stringify(item.metadata || {}),
    ]
  );

  saveDb();
}

export function searchByText(db: SqlJsDatabase, query: string, limit = 20): any[] {
  const pattern = `%${query}%`;
  const stmt = db.prepare(
    `SELECT * FROM knowledge
    WHERE title LIKE $pattern OR summary LIKE $pattern OR contacts LIKE $pattern OR organizations LIKE $pattern OR tags LIKE $pattern
    ORDER BY
      CASE importance
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 3
      END,
      source_date DESC
    LIMIT $limit`
  );

  stmt.bind({ $pattern: pattern, $limit: limit });

  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    // Parse JSON fields
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchByEmbedding(db: SqlJsDatabase, queryEmbedding: number[], limit = 10, threshold = 0.7): any[] {
  // Get all items with embeddings using prepared statement
  const stmt = db.prepare('SELECT * FROM knowledge WHERE embedding IS NOT NULL');
  const items: any[] = [];
  while (stmt.step()) {
    items.push(stmt.getAsObject());
  }
  stmt.free();
  if (!items.length) return [];

  const scored = items
    .map(obj => {
      // Decode embedding from Uint8Array
      if (obj.embedding && obj.embedding instanceof Uint8Array) {
        const floats = new Float32Array(obj.embedding.buffer, obj.embedding.byteOffset, obj.embedding.byteLength / 4);
        const similarity = cosineSimilarity(queryEmbedding, Array.from(floats));
        obj.similarity = similarity;
        obj.embedding = null;
      } else {
        obj.similarity = 0;
      }

      // Parse JSON fields
      for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
        if (obj[field] && typeof obj[field] === 'string') {
          try { obj[field] = JSON.parse(obj[field]); } catch {}
        }
      }

      return obj;
    })
    .filter(obj => obj.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

export function getStats(db: SqlJsDatabase) {
  const total = db.exec('SELECT COUNT(*) as count FROM knowledge');
  const bySrc = db.exec('SELECT source, COUNT(*) as count FROM knowledge GROUP BY source');
  const byImportance = db.exec('SELECT importance, COUNT(*) as count FROM knowledge GROUP BY importance');
  const connections = db.exec('SELECT COUNT(*) as count FROM connections');
  const lastSync = db.exec('SELECT source, last_sync_at, items_synced FROM sync_state ORDER BY last_sync_at DESC');

  return {
    total_items: total[0]?.values[0]?.[0] || 0,
    by_source: bySrc[0]?.values.map(r => ({ source: r[0], count: r[1] })) || [],
    by_importance: byImportance[0]?.values.map(r => ({ importance: r[0], count: r[1] })) || [],
    total_connections: connections[0]?.values[0]?.[0] || 0,
    sync_state: lastSync[0]?.values.map(r => ({ source: r[0], last_sync_at: r[1], items_synced: r[2] })) || [],
  };
}

export function getConfig(db: SqlJsDatabase, key: string): any {
  const result = db.exec('SELECT value FROM config WHERE key = ?', [key]);
  if (!result.length || !result[0].values.length) return null;
  try { return JSON.parse(result[0].values[0][0] as string); } catch { return result[0].values[0][0]; }
}

export function setConfig(db: SqlJsDatabase, key: string, value: any) {
  db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  saveDb();
}

export function getAllKnowledge(db: SqlJsDatabase, limit?: number): any[] {
  const sql = limit
    ? 'SELECT * FROM knowledge ORDER BY source_date DESC LIMIT ?'
    : 'SELECT * FROM knowledge ORDER BY source_date DESC';
  const stmt = limit ? db.prepare(sql).bind([limit]) : db.prepare(sql);

  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    for (const field of ['contacts', 'organizations', 'decisions', 'commitments', 'action_items', 'tags', 'metadata']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

export function updateKnowledgeExtraction(db: SqlJsDatabase, id: string, fields: {
  contacts?: string[];
  organizations?: string[];
  decisions?: string[];
  commitments?: string[];
  action_items?: string[];
  tags?: string[];
  project?: string | null;
  importance?: string;
}) {
  db.run(
    `UPDATE knowledge SET
      contacts = ?, organizations = ?, decisions = ?, commitments = ?,
      action_items = ?, tags = ?, project = ?, importance = ?,
      updated_at = datetime('now')
    WHERE id = ?`,
    [
      JSON.stringify(fields.contacts || []),
      JSON.stringify(fields.organizations || []),
      JSON.stringify(fields.decisions || []),
      JSON.stringify(fields.commitments || []),
      JSON.stringify(fields.action_items || []),
      JSON.stringify(fields.tags || []),
      fields.project || null,
      fields.importance || 'normal',
      id,
    ]
  );
  saveDb();
}

// ============================================================
// Episode types and functions
// ============================================================

export interface Episode {
  id: string;
  title: string;
  summary?: string;
  item_ids: string[];
  source?: string;
  project?: string;
  date_start?: string;
  date_end?: string;
  embedding?: number[];
}

export function insertEpisode(db: SqlJsDatabase, episode: Episode) {
  const embeddingBlob = episode.embedding
    ? Buffer.from(new Float32Array(episode.embedding).buffer)
    : null;

  db.run(
    `INSERT OR REPLACE INTO episodes
    (id, title, summary, item_ids, source, project, date_start, date_end, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      episode.id,
      episode.title,
      episode.summary || null,
      JSON.stringify(episode.item_ids),
      episode.source || null,
      episode.project || null,
      episode.date_start || null,
      episode.date_end || null,
      embeddingBlob,
    ]
  );

  saveDb();
}

export function getEpisodes(db: SqlJsDatabase, limit?: number): any[] {
  const sql = limit
    ? 'SELECT * FROM episodes ORDER BY date_start DESC LIMIT ?'
    : 'SELECT * FROM episodes ORDER BY date_start DESC';
  const stmt = limit ? db.prepare(sql).bind([limit]) : db.prepare(sql);

  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.item_ids && typeof row.item_ids === 'string') {
      try { row.item_ids = JSON.parse(row.item_ids); } catch {}
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

// ============================================================
// Semantic types and functions
// ============================================================

export interface Semantic {
  id: string;
  fact: string;
  fact_type: string;
  episode_ids?: string[];
  item_ids?: string[];
  project?: string;
  contacts?: string[];
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  confidence?: number;
  embedding?: number[];
}

export function insertSemantic(db: SqlJsDatabase, semantic: Semantic) {
  const embeddingBlob = semantic.embedding
    ? Buffer.from(new Float32Array(semantic.embedding).buffer)
    : null;

  db.run(
    `INSERT OR REPLACE INTO semantics
    (id, fact, fact_type, episode_ids, item_ids, project, contacts, valid_from, valid_until, superseded_by, confidence, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      semantic.id,
      semantic.fact,
      semantic.fact_type,
      JSON.stringify(semantic.episode_ids || []),
      JSON.stringify(semantic.item_ids || []),
      semantic.project || null,
      JSON.stringify(semantic.contacts || []),
      semantic.valid_from || null,
      semantic.valid_until || null,
      semantic.superseded_by || null,
      semantic.confidence ?? 1.0,
      embeddingBlob,
    ]
  );

  saveDb();
}

export function getSemantics(db: SqlJsDatabase, options?: { project?: string; factType?: string; current?: boolean }): any[] {
  let sql = 'SELECT * FROM semantics WHERE 1=1';
  const params: any[] = [];

  if (options?.project) {
    sql += ' AND project = ?';
    params.push(options.project);
  }
  if (options?.factType) {
    sql += ' AND fact_type = ?';
    params.push(options.factType);
  }
  if (options?.current) {
    sql += ' AND valid_until IS NULL';
  }

  sql += ' ORDER BY created_at DESC';

  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    for (const field of ['episode_ids', 'item_ids', 'contacts']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field] as string); } catch {}
      }
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

// ============================================================
// Theme types and functions
// ============================================================

export interface Theme {
  id: string;
  name: string;
  description?: string;
  semantic_ids: string[];
  parent_theme_id?: string;
  size?: number;
  centroid?: number[];
}

export function insertTheme(db: SqlJsDatabase, theme: Theme) {
  const centroidBlob = theme.centroid
    ? Buffer.from(new Float32Array(theme.centroid).buffer)
    : null;

  db.run(
    `INSERT OR REPLACE INTO themes
    (id, name, description, semantic_ids, parent_theme_id, size, centroid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      theme.id,
      theme.name,
      theme.description || null,
      JSON.stringify(theme.semantic_ids),
      theme.parent_theme_id || null,
      theme.size ?? theme.semantic_ids.length,
      centroidBlob,
    ]
  );

  saveDb();
}

export function getThemes(db: SqlJsDatabase): any[] {
  const stmt = db.prepare('SELECT * FROM themes ORDER BY size DESC');

  const results: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.semantic_ids && typeof row.semantic_ids === 'string') {
      try { row.semantic_ids = JSON.parse(row.semantic_ids); } catch {}
    }
    results.push(row);
  }
  stmt.free();
  return results;
}

// ============================================================
// Hierarchy stats
// ============================================================

export function getHierarchyStats(db: SqlJsDatabase): { themes: number; semantics: number; episodes: number; items: number } {
  const themes = db.exec('SELECT COUNT(*) FROM themes');
  const semantics = db.exec('SELECT COUNT(*) FROM semantics');
  const episodes = db.exec('SELECT COUNT(*) FROM episodes');
  const items = db.exec('SELECT COUNT(*) FROM knowledge');

  return {
    themes: (themes[0]?.values[0]?.[0] as number) || 0,
    semantics: (semantics[0]?.values[0]?.[0] as number) || 0,
    episodes: (episodes[0]?.values[0]?.[0] as number) || 0,
    items: (items[0]?.values[0]?.[0] as number) || 0,
  };
}

// ============================================================
// Connection functions
// ============================================================

export interface Connection {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  confidence: number;
}

export function insertConnection(db: SqlJsDatabase, conn: { id: string; source_id: string; target_id: string; relationship: string; confidence: number }) {
  db.run(
    `INSERT OR IGNORE INTO connections (id, source_id, target_id, relationship, confidence) VALUES (?, ?, ?, ?, ?)`,
    [conn.id, conn.source_id, conn.target_id, conn.relationship, conn.confidence]
  );
}

export function getConnectionsForItem(db: SqlJsDatabase, itemId: string): Connection[] {
  const stmt = db.prepare(
    `SELECT * FROM connections WHERE source_id = $id OR target_id = $id`
  );
  stmt.bind({ $id: itemId });

  const results: Connection[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      id: row.id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      relationship: row.relationship as string,
      confidence: row.confidence as number,
    });
  }
  stmt.free();
  return results;
}

export function clearConnections(db: SqlJsDatabase) {
  db.run('DELETE FROM connections');
}

export function getConnectionStats(db: SqlJsDatabase): Record<string, number> {
  const result = db.exec('SELECT relationship, COUNT(*) as count FROM connections GROUP BY relationship');
  const stats: Record<string, number> = {};
  if (result.length > 0) {
    for (const row of result[0].values) {
      stats[row[0] as string] = row[1] as number;
    }
  }
  return stats;
}

// ============================================================
// Commitment types and functions
// ============================================================

export interface Commitment {
  id: string;
  text: string;
  owner?: string;
  assigned_to?: string;
  due_date?: string;
  detected_from?: string;
  detected_at?: string;
  state?: string;
  state_changed_at?: string;
  fulfilled_evidence?: string;
  context?: string;
  project?: string;
  importance?: string;
}

export function insertCommitment(db: SqlJsDatabase, commitment: Commitment) {
  db.run(
    `INSERT OR REPLACE INTO commitments
    (id, text, owner, assigned_to, due_date, detected_from, detected_at, state, state_changed_at, fulfilled_evidence, context, project, importance, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      commitment.id,
      commitment.text,
      commitment.owner || null,
      commitment.assigned_to || null,
      commitment.due_date || null,
      commitment.detected_from || null,
      commitment.detected_at || null,
      commitment.state || 'detected',
      commitment.state_changed_at || null,
      commitment.fulfilled_evidence || null,
      commitment.context || null,
      commitment.project || null,
      commitment.importance || 'normal',
    ]
  );

  saveDb();
}

export function getCommitments(db: SqlJsDatabase, options?: { state?: string; owner?: string; project?: string; overdue?: boolean }): any[] {
  let sql = 'SELECT * FROM commitments WHERE 1=1';
  const params: any[] = [];

  if (options?.state) {
    sql += ' AND state = ?';
    params.push(options.state);
  }
  if (options?.owner) {
    sql += ' AND (owner = ? OR assigned_to = ?)';
    params.push(options.owner, options.owner);
  }
  if (options?.project) {
    sql += ' AND project = ?';
    params.push(options.project);
  }
  if (options?.overdue) {
    sql += " AND state = 'active' AND due_date < datetime('now')";
  }

  sql += ' ORDER BY due_date ASC, importance DESC';

  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

export function updateCommitmentState(db: SqlJsDatabase, id: string, newState: string, evidence?: string) {
  db.run(
    `UPDATE commitments SET state = ?, state_changed_at = datetime('now'), fulfilled_evidence = COALESCE(?, fulfilled_evidence), updated_at = datetime('now') WHERE id = ?`,
    [newState, evidence || null, id]
  );
  saveDb();
}

export function getCommitmentStats(db: SqlJsDatabase): { total: number; byState: Record<string, number>; overdueCount: number } {
  const total = db.exec('SELECT COUNT(*) FROM commitments');
  const byState = db.exec('SELECT state, COUNT(*) FROM commitments GROUP BY state');
  const overdue = db.exec("SELECT COUNT(*) FROM commitments WHERE state = 'active' AND due_date < datetime('now')");

  const stateMap: Record<string, number> = {};
  if (byState.length > 0) {
    for (const row of byState[0].values) {
      stateMap[row[0] as string] = row[1] as number;
    }
  }

  return {
    total: (total[0]?.values[0]?.[0] as number) || 0,
    byState: stateMap,
    overdueCount: (overdue[0]?.values[0]?.[0] as number) || 0,
  };
}

export { PRIME_DIR, DB_PATH };
