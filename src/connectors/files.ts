import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { insertKnowledge, getConfig, saveDb, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.html', '.xml',
  '.ts', '.js', '.py', '.sql', '.sh', '.yaml', '.yml',
  '.pdf', // TODO: PDF extraction
]);

export async function indexDirectory(
  db: SqlJsDatabase,
  dirPath: string,
  options: { project?: string; recursive?: boolean } = {}
): Promise<{ files: number; items: number; skipped: number }> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const recursive = options.recursive !== false;
  const stats = { files: 0, items: 0, skipped: 0 };

  const files = getFiles(dirPath, recursive);

  for (const filePath of files) {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      stats.skipped++;
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.length < 10) {
        stats.skipped++;
        continue;
      }

      stats.files++;

      // Check for YAML frontmatter (markdown files)
      let metadata: Record<string, any> = {};
      let bodyContent = content;

      if (ext === '.md' && content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx > 0) {
          const frontmatter = content.slice(3, endIdx).trim();
          bodyContent = content.slice(endIdx + 3).trim();

          // Simple YAML parsing (key: value)
          for (const line of frontmatter.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const key = line.slice(0, colonIdx).trim();
              const val = line.slice(colonIdx + 1).trim();
              metadata[key] = val;
            }
          }
        }
      }

      // Extract intelligence
      const extracted = await extractIntelligence(
        bodyContent.slice(0, 6000),
        apiKey
      );

      // Generate embedding
      const embText = `${extracted.title}\n${extracted.summary}\n${basename(filePath)}`;
      const embedding = await generateEmbedding(embText, apiKey);

      const fileStat = statSync(filePath);

      const item: KnowledgeItem = {
        id: uuid(),
        title: metadata.title || extracted.title || basename(filePath),
        summary: metadata.summary || extracted.summary,
        source: 'file',
        source_ref: filePath,
        source_date: fileStat.mtime.toISOString(),
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: [...extracted.tags, ext.slice(1)],
        project: options.project || metadata.project || extracted.project,
        importance: extracted.importance,
        embedding,
        metadata: { ...metadata, file_size: fileStat.size, extension: ext },
      };

      insertKnowledge(db, item);
      stats.items++;

      await new Promise(r => setTimeout(r, 100));
    } catch {
      stats.skipped++;
    }
  }

  db.run(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('files', datetime('now'), ?, 'idle', datetime('now'))`,
    [stats.items]
  );
  saveDb();

  return stats;
}

function getFiles(dir: string, recursive: boolean): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isDirectory() && recursive) {
        files.push(...getFiles(fullPath, true));
      }
    }
  } catch {}
  return files;
}
