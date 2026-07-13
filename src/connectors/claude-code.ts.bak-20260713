import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbeddings } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

// ============================================================
// Claude Code Connector
//
// Scans ~/.claude/projects/ for:
// 1. Conversation JSONL files (same format as Cowork)
// 2. Memory files (curated project knowledge)
// ============================================================

const CLAUDE_CODE_BASE = join(homedir(), '.claude', 'projects');
const CLAUDE_CODE_LAPTOP_BASE = join(homedir(), 'laptop-sources', 'claude-code');

interface CodeMessage {
  type: string;
  userType?: string;
  timestamp?: string;
  message?: any;
  content?: any;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

interface CodeSession {
  path: string;
  projectSlug: string;
  sessionId: string;
  messages: CodeMessage[];
  firstTimestamp: string;
  lastTimestamp: string;
}

// Lightweight metadata — no file reads, no JSON.parse.
// We dedup against the DB on this BEFORE loading any JSONL contents,
// to avoid OOMing on the 30-day, 233K-file laptop-sources tree.
interface CodeSessionMeta {
  path: string;
  projectSlug: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
}

// ============================================================
// Discovery (cheap — stat only, no reads)
// ============================================================

function discoverSessionMetaFromPath(basePath: string, days: number): CodeSessionMeta[] {
  if (!existsSync(basePath)) return [];

  const out: CodeSessionMeta[] = [];
  const cutoff = Date.now() - days * 86400000;

  for (const projDir of safeReaddir(basePath)) {
    const projPath = join(basePath, projDir);
    if (!statSync(projPath).isDirectory()) continue;

    for (const file of safeReaddir(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      if (file.startsWith('agent-') || file.startsWith('task-')) continue;

      const filePath = join(projPath, file);
      const stat = statSync(filePath);

      if (stat.mtimeMs < cutoff) continue;
      if (stat.size < 500) continue;
      // Oversized files would OOM on full read. extractConversationText caps at 12KB
      // anyway, so giant files add no value.
      if (stat.size > 25 * 1024 * 1024) {
        console.log(`  Skipping oversized session ${file} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      out.push({
        path: filePath,
        projectSlug: projDir,
        sessionId: file.replace('.jsonl', ''),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  return out;
}

function discoverSessionMeta(days: number): CodeSessionMeta[] {
  const local = discoverSessionMetaFromPath(CLAUDE_CODE_BASE, days);

  if (!existsSync(CLAUDE_CODE_LAPTOP_BASE)) return local;

  console.log(`  Scanning laptop-sources: ${CLAUDE_CODE_LAPTOP_BASE}`);
  const laptop = discoverSessionMetaFromPath(CLAUDE_CODE_LAPTOP_BASE, days);

  const seenIds = new Set(local.map(s => s.sessionId));
  let added = 0;
  for (const ls of laptop) {
    if (!seenIds.has(ls.sessionId)) {
      local.push(ls);
      seenIds.add(ls.sessionId);
      added++;
    }
  }
  console.log(`  Laptop-sources: ${laptop.length} found, ${added} new after dedup`);
  return local;
}

// ============================================================
// Load (expensive — only call after DB dedup)
// ============================================================

function loadSession(meta: CodeSessionMeta): CodeSession | null {
  try {
    const content = readFileSync(meta.path, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 3) return null;

    const messages: CodeMessage[] = [];
    let firstTs = '';
    let lastTs = '';

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
        const ts = msg.timestamp || '';
        if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
        if (ts && ts > lastTs) lastTs = ts;
      } catch (_e) {}
    }

    const hasUser = messages.some(m => m.type === 'user' || m.message?.role === 'user');
    const hasAssistant = messages.some(m => m.type === 'assistant' || m.message?.role === 'assistant');
    if (!hasUser || !hasAssistant) return null;

    return {
      path: meta.path,
      projectSlug: meta.projectSlug,
      sessionId: meta.sessionId,
      messages,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Discover memory files from a single base path.
 */
function discoverMemoryFilesFromPath(basePath: string): { path: string; projectSlug: string; name: string }[] {
  if (!existsSync(basePath)) return [];

  const files: { path: string; projectSlug: string; name: string }[] = [];

  for (const projDir of safeReaddir(basePath)) {
    const memoryDir = join(basePath, projDir, 'memory');
    if (!existsSync(memoryDir) || !statSync(memoryDir).isDirectory()) continue;

    for (const file of safeReaddir(memoryDir)) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      files.push({
        path: join(memoryDir, file),
        projectSlug: projDir,
        name: file.replace('.md', ''),
      });
    }
  }

  return files;
}

/**
 * Discover memory files from local + laptop-sources paths, deduped by projectSlug:name.
 */
function discoverMemoryFiles(): { path: string; projectSlug: string; name: string }[] {
  const files = discoverMemoryFilesFromPath(CLAUDE_CODE_BASE);

  if (existsSync(CLAUDE_CODE_LAPTOP_BASE)) {
    console.log(`  Scanning laptop-sources memory: ${CLAUDE_CODE_LAPTOP_BASE}`);
    const laptopFiles = discoverMemoryFilesFromPath(CLAUDE_CODE_LAPTOP_BASE);
    const seenKeys = new Set(files.map(f => `${f.projectSlug}:${f.name}`));
    let added = 0;
    for (const lf of laptopFiles) {
      const key = `${lf.projectSlug}:${lf.name}`;
      if (!seenKeys.has(key)) {
        files.push(lf);
        seenKeys.add(key);
        added++;
      }
    }
    console.log(`  Laptop-sources memory: ${laptopFiles.length} found, ${added} new after dedup`);
  }

  return files;
}

// ============================================================
// Text Extraction
// ============================================================

function extractConversationText(session: CodeSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    const role = msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : msg.type || 'unknown';

    // Skip non-content messages
    if (['queue-operation', 'last-prompt', 'progress'].includes(role)) continue;

    const content = msg.message?.content || msg.content;
    if (!content) continue;

    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed && trimmed.length > 10) parts.push(`${role}: ${trimmed}`);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'object') {
          if (item.type === 'text' && item.text) {
            parts.push(`${role}: ${item.text}`);
          } else if (item.type === 'tool_use') {
            parts.push(`${role}: [tool: ${item.name}]`);
          } else if (item.type === 'tool_result' && item.content) {
            const resultText = typeof item.content === 'string'
              ? item.content
              : Array.isArray(item.content)
                ? item.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                : '';
            if (resultText && resultText.length > 30) {
              parts.push(`tool_result: ${resultText.slice(0, 3000)}`);
            }
          }
          // Skip thinking blocks
        }
      }
    }
  }

  return parts.join('\n\n').slice(0, 12000);
}

function projectSlugToName(slug: string): string {
  // "-Users-zstoc-GitHub-prime-production" → "prime-production"
  return slug
    .replace(/^-Users-[^-]+-/, '')
    .replace(/^GitHub-/, '')
    .replace(/^claudework-/, 'claudework/')
    .replace(/-/g, '-');
}

// ============================================================
// Connect & Scan
// ============================================================

export async function connectClaudeCode(db: Database.Database): Promise<boolean> {
  if (!existsSync(CLAUDE_CODE_BASE) && !existsSync(CLAUDE_CODE_LAPTOP_BASE)) {
    console.log('  ✗ No Claude Code projects found.');
    return false;
  }

  const sessions = discoverSessionMeta(30);
  const memoryFiles = discoverMemoryFiles();

  const projectSlugs = new Set(sessions.map(s => s.projectSlug));

  setConfig(db, 'claude_code_connected', true);
  setConfig(db, 'claude_code_base_path', CLAUDE_CODE_BASE);

  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('claude-code', 'connected', ?, datetime('now'))`
  ).run(JSON.stringify({ sessions: sessions.length, memory_files: memoryFiles.length, projects: projectSlugs.size }));

  console.log(`  ✓ Found ${sessions.length} Claude Code sessions (last 30 days)`);
  console.log(`    ${memoryFiles.length} memory files across ${projectSlugs.size} projects`);

  return true;
}

export async function scanClaudeCode(
  db: Database.Database,
  options: { days?: number; maxSessions?: number } = {}
): Promise<{ sessions: number; memory: number; items: number; skipped: number }> {
  const days = options.days || 30;
  const maxSessions = options.maxSessions || 200;

  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const stats = { sessions: 0, memory: 0, items: 0, skipped: 0 };

  // ── Phase 1: Memory files (curated, high value, small) ──
  console.log('  Phase 1: Scanning memory files...');
  const memoryFiles = discoverMemoryFiles();

  for (const mf of memoryFiles) {
    const sourceRef = `claude-code-memory:${mf.projectSlug}:${mf.name}`;
    const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(sourceRef);

    // Re-ingest if file changed since last scan
    if (existing) {
      const fileStat = statSync(mf.path);
      const existingItem = db.prepare('SELECT source_date FROM knowledge WHERE source_ref = ?').get(sourceRef) as any;
      if (existingItem && new Date(existingItem.source_date) >= new Date(fileStat.mtimeMs)) {
        stats.skipped++;
        continue;
      }
      // Delete old version to re-ingest
      db.prepare('DELETE FROM knowledge WHERE source_ref = ?').run(sourceRef);
    }

    try {
      const content = readFileSync(mf.path, 'utf-8');
      if (content.length < 50) continue;

      const projectName = projectSlugToName(mf.projectSlug);
      const title = `Claude Code Memory: ${mf.name} (${projectName})`;

      const item: KnowledgeItem = {
        id: uuid(),
        title,
        summary: content.slice(0, 1000),
        source: 'claude-code',
        source_ref: sourceRef,
        source_date: new Date(statSync(mf.path).mtimeMs).toISOString(),
        tags: ['claude-code', 'memory', `project:${projectName}`],
        project: projectName === 'prime-production' ? 'Prime' : projectName === 'prime' ? 'Prime' : projectName,
        importance: 'normal',
        metadata: {
          memory_type: 'curated',
          project_slug: mf.projectSlug,
          file_name: mf.name,
        },
      };

      insertKnowledge(db, item);
      stats.memory++;
      stats.items++;
    } catch (_e) {}
  }
  console.log(`  ${stats.memory} memory files ingested`);

  // ── Phase 2: Conversation sessions ──
  console.log('  Phase 2: Discovering conversation sessions...');
  const allMeta = discoverSessionMeta(days);
  // Sort by file mtime (newest first) — proxy for last activity, free vs JSON.parse.
  const candidates = allMeta
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessions);

  console.log(`  Found ${allMeta.length} total, processing top ${candidates.length}`);

  // DB dedup BEFORE loading any file contents. This is the OOM fix:
  // previously every candidate JSONL was readFileSync+JSON.parse'd into a
  // messages array held in memory, then dedup happened. Across a 30-day
  // laptop-sources tree that blew 8GB heap and crash-looped the daemon.
  const lookup = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?');
  const newMeta: CodeSessionMeta[] = [];
  for (const meta of candidates) {
    const sourceRef = `claude-code:${meta.sessionId}`;
    if (lookup.get(sourceRef)) {
      stats.skipped++;
    } else {
      newMeta.push(meta);
    }
  }

  console.log(`  ${newMeta.length} to process, ${stats.skipped} already indexed`);
  if (newMeta.length === 0) return stats;

  // Load ONLY new sessions.
  const toProcess: CodeSession[] = [];
  for (const meta of newMeta) {
    const session = loadSession(meta);
    if (session) toProcess.push(session);
  }

  // ── Phase 3: Extract conversation text ──
  // Free `session.messages` after text extraction — it's the dominant retainer
  // (a fully parsed JSONL can be 10s of MB) and downstream phases only need
  // the extracted text, sessionId, projectSlug, msgCount, and timestamps.
  console.log('  Phase 3: Extracting conversation text...');
  const sessionTexts = toProcess.map(session => {
    const text = extractConversationText(session);
    const msgCount = session.messages.length;
    session.messages = []; // release for GC
    return { session, text, msgCount };
  }).filter(s => s.text.length > 100);

  // ── Phase 4: AI extraction in parallel (5 concurrent) ──
  console.log(`  Phase 4: AI extraction on ${sessionTexts.length} sessions...`);
  const CONCURRENCY = 5;

  interface ProcessedSession {
    session: CodeSession;
    extracted: Awaited<ReturnType<typeof extractIntelligence>>;
    text: string;
    msgCount: number;
  }

  const processed: ProcessedSession[] = [];

  for (let i = 0; i < sessionTexts.length; i += CONCURRENCY) {
    const batch = sessionTexts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ session, text, msgCount }): Promise<ProcessedSession | null> => {
      try {
        const extracted = await extractIntelligence(text, apiKey);
        return { session, extracted, text, msgCount };
      } catch (err: any) {
        console.error(`\n    ✗ Extraction failed for ${session.projectSlug}: ${err.message?.slice(0, 100)}`);
        return null;
      }
    }));

    for (const r of results) {
      if (r) processed.push(r);
      else stats.skipped++;
    }
    process.stdout.write(`\r  Extracted: ${Math.min(i + CONCURRENCY, sessionTexts.length)}/${sessionTexts.length}`);
  }
  console.log('');

  // ── Phase 5: Batch embeddings ──
  console.log('  Phase 5: Generating embeddings...');
  const embTexts = processed.map(p => {
    const projectName = projectSlugToName(p.session.projectSlug);
    const title = p.extracted.title || `Claude Code: ${projectName}`;
    return `${title}\n${p.extracted.summary}`;
  });

  const embeddings = await generateEmbeddings(embTexts, apiKey);

  // ── Phase 6: Insert into DB ──
  console.log('  Phase 6: Saving to knowledge base...');

  for (let i = 0; i < processed.length; i++) {
    const { session, extracted, msgCount } = processed[i];
    const embedding = embeddings[i];
    const projectName = projectSlugToName(session.projectSlug);

    const title = extracted.title || `Claude Code: ${projectName} session`;

    const item: KnowledgeItem = {
      id: uuid(),
      title,
      summary: extracted.summary,
      source: 'claude-code',
      source_ref: `claude-code:${session.sessionId}`,
      source_date: session.lastTimestamp,
      contacts: extracted.contacts,
      organizations: extracted.organizations,
      decisions: extracted.decisions,
      commitments: extracted.commitments,
      action_items: extracted.action_items,
      tags: [
        ...(extracted.tags || []),
        'claude-code',
        `project:${projectName}`,
      ],
      project: projectName === 'prime-production' ? 'Prime' : projectName === 'prime' ? 'Prime' : extracted.project || projectName,
      importance: extracted.importance,
      embedding,
      metadata: {
        claude_code_session_id: session.sessionId,
        project_slug: session.projectSlug,
        project_name: projectName,
        message_count: msgCount,
        first_timestamp: session.firstTimestamp,
        last_timestamp: session.lastTimestamp,
        platform: 'claude-code',
      },
    };

    insertKnowledge(db, item);
    stats.items++;
    stats.sessions++;
  }

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('claude-code', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.items);

  return stats;
}

// ============================================================
// Helpers
// ============================================================

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path).filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}
