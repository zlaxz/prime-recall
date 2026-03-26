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

export { PRIME_DIR, DB_PATH };
