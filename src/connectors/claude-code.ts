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

// ============================================================
// Discovery
// ============================================================

function discoverSessionsFromPath(basePath: string, days: number): CodeSession[] {
  if (!existsSync(basePath)) return [];

  const sessions: CodeSession[] = [];
  const cutoff = Date.now() - days * 86400000;

  for (const projDir of safeReaddir(basePath)) {
    const projPath = join(basePath, projDir);
    if (!statSync(projPath).isDirectory()) continue;

    // Skip subagents and tasks directories
    for (const file of safeReaddir(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      // Skip subagent/task files
      if (file.startsWith('agent-') || file.startsWith('task-')) continue;

      const filePath = join(projPath, file);
      const stat = statSync(filePath);

      // Date filter
      if (stat.mtimeMs < cutoff) continue;
      // Skip tiny files
      if (stat.size < 500) continue;
      // Skip oversized files — readFileSync+JSON.parse on 100MB+ JSONLs blows the heap.
      // extractConversationText caps output at 12KB anyway, so giant files add no value.
      if (stat.size > 25 * 1024 * 1024) {
        console.log(`  Skipping oversized session ${file} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length < 3) continue;

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

        // Need at least one user and one assistant message
        const hasUser = messages.some(m => m.type === 'user' || m.message?.role === 'user');
        const hasAssistant = messages.some(m => m.type === 'assistant' || m.message?.role === 'assistant');
        if (!hasUser || !hasAssistant) continue;

        sessions.push({
          path: filePath,
          projectSlug: projDir,
          sessionId: file.replace('.jsonl', ''),
          messages,
          firstTimestamp: firstTs,
          lastTimestamp: lastTs,
        });
      } catch (_e) {}
    }
  }

  return sessions;
}

function discoverSessions(days: number): CodeSession[] {
  const sessions = discoverSessionsFromPath(CLAUDE_CODE_BASE, days);

  if (existsSync(CLAUDE_CODE_LAPTOP_BASE)) {
    console.log(`  Scanning laptop-sources: ${CLAUDE_CODE_LAPTOP_BASE}`);
    const laptopSessions = discoverSessionsFromPath(CLAUDE_CODE_LAPTOP_BASE, days);
    // Dedup: local sessions take priority over laptop-sourced ones
    const seenIds = new Set(sessions.map(s => s.sessionId));
    let added = 0;
    for (const ls of laptopSessions) {
      if (!seenIds.has(ls.sessionId)) {
        sessions.push(ls);
        seenIds.add(ls.sessionId);
        added++;
      }
    }
    console.log(`  Laptop-sources: ${laptopSessions.length} found, ${added} new after dedup`);
  }

  return sessions;
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

  const sessions = discoverSessions(30);
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
  const allSessions = discoverSessions(days);
  const sessions = allSessions
    .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
    .slice(0, maxSessions);

  console.log(`  Found ${allSessions.length} total, processing ${sessions.length}`);

  // Filter already indexed
  const toProcess: CodeSession[] = [];
  for (const session of sessions) {
    const sourceRef = `claude-code:${session.sessionId}`;
    const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(sourceRef);
    if (existing) {
      stats.skipped++;
    } else {
      toProcess.push(session);
    }
  }

  console.log(`  ${toProcess.length} to process, ${stats.skipped} already indexed`);
  if (toProcess.length === 0) return stats;

  // ── Phase 3: Extract conversation text ──
  console.log('  Phase 3: Extracting conversation text...');
  const sessionTexts = toProcess.map(session => {
    const text = extractConversationText(session);
    return { session, text };
  }).filter(s => s.text.length > 100);

  // ── Phase 4: AI extraction in parallel (5 concurrent) ──
  console.log(`  Phase 4: AI extraction on ${sessionTexts.length} sessions...`);
  const CONCURRENCY = 5;

  interface ProcessedSession {
    session: CodeSession;
    extracted: Awaited<ReturnType<typeof extractIntelligence>>;
    text: string;
  }

  const processed: ProcessedSession[] = [];

  for (let i = 0; i < sessionTexts.length; i += CONCURRENCY) {
    const batch = sessionTexts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ session, text }): Promise<ProcessedSession | null> => {
      try {
        const extracted = await extractIntelligence(text, apiKey);
        return { session, extracted, text };
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
    const { session, extracted } = processed[i];
    const embedding = embeddings[i];
    const projectName = projectSlugToName(session.projectSlug);
    const msgCount = session.messages.length;

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
