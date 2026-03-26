import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir, platform } from 'os';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding, generateEmbeddings } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

// ============================================================
// Cowork Session Scanner
// ============================================================

const COWORK_BASE = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'local-agent-mode-sessions'
);

interface CoworkMessage {
  type: string;
  userType?: string;
  timestamp?: string;
  message?: any;
  content?: any;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

interface CoworkSession {
  path: string;
  deviceId: string;
  orgId: string;
  sessionId: string;
  sessionName: string;
  messages: CoworkMessage[];
  firstTimestamp: string;
  lastTimestamp: string;
}

/**
 * Discover all Cowork sessions on disk.
 */
function discoverSessions(): CoworkSession[] {
  if (!existsSync(COWORK_BASE)) return [];

  const sessions: CoworkSession[] = [];

  // Structure: COWORK_BASE/{device-id}/{org-id}/local_{session-id}/.claude/projects/{session-name}/{uuid}.jsonl
  for (const deviceDir of safeReaddir(COWORK_BASE)) {
    const devicePath = join(COWORK_BASE, deviceDir);
    if (!statSync(devicePath).isDirectory()) continue;

    for (const orgDir of safeReaddir(devicePath)) {
      const orgPath = join(devicePath, orgDir);
      if (!statSync(orgPath).isDirectory()) continue;

      for (const sessionDir of safeReaddir(orgPath)) {
        if (!sessionDir.startsWith('local_')) continue;
        const sessionPath = join(orgPath, sessionDir);

        // Find JSONL files (not in subagents, not audit.jsonl)
        const projectsDir = join(sessionPath, '.claude', 'projects');
        if (!existsSync(projectsDir)) continue;

        for (const projDir of safeReaddir(projectsDir)) {
          const projPath = join(projectsDir, projDir);
          if (!statSync(projPath).isDirectory()) continue;

          for (const file of safeReaddir(projPath)) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = join(projPath, file);

            try {
              const content = readFileSync(filePath, 'utf-8');
              const lines = content.split('\n').filter(l => l.trim());
              if (lines.length < 2) continue;

              const messages: CoworkMessage[] = [];
              let firstTs = '';
              let lastTs = '';

              for (const line of lines) {
                try {
                  const msg = JSON.parse(line);
                  messages.push(msg);
                  const ts = msg.timestamp || '';
                  if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
                  if (ts && ts > lastTs) lastTs = ts;
                } catch {}
              }

              if (messages.length < 2) continue;

              sessions.push({
                path: filePath,
                deviceId: deviceDir,
                orgId: orgDir,
                sessionId: sessionDir.replace('local_', ''),
                sessionName: projDir.replace('-sessions-', ''),
                messages,
                firstTimestamp: firstTs,
                lastTimestamp: lastTs,
              });
            } catch {}
          }
        }
      }
    }
  }

  return sessions;
}

/**
 * Extract readable conversation text from a Cowork session.
 */
function extractConversationText(session: CoworkSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    const role = msg.userType || msg.type || 'unknown';

    // Skip queue operations and non-content messages
    if (role === 'queue-operation' || role === 'last-prompt') continue;

    const content = msg.message || msg.content;
    if (!content) continue;

    if (typeof content === 'string') {
      // Strip scheduled-task XML wrapper, keep the content
      const cleaned = content
        .replace(/<scheduled-task[^>]*>/g, '[scheduled-task] ')
        .replace(/<\/scheduled-task>/g, '')
        .trim();
      if (cleaned) parts.push(`${role}: ${cleaned}`);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'object') {
          if (item.type === 'text' && item.text) {
            parts.push(`${role}: ${item.text}`);
          } else if (item.type === 'thinking' && item.thinking) {
            // Skip thinking blocks — too verbose, low signal
          } else if (item.type === 'tool_use') {
            parts.push(`${role}: [used tool: ${item.name}]`);
          } else if (item.type === 'tool_result' && item.content) {
            const resultText = typeof item.content === 'string'
              ? item.content
              : Array.isArray(item.content)
                ? item.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                : '';
            if (resultText && resultText.length > 20) {
              parts.push(`tool_result: ${resultText.slice(0, 500)}`);
            }
          }
        }
      }
    } else if (typeof content === 'object') {
      // Nested message format
      const innerContent = content.content;
      if (typeof innerContent === 'string') {
        parts.push(`${content.role || role}: ${innerContent}`);
      } else if (Array.isArray(innerContent)) {
        for (const item of innerContent) {
          if (item.type === 'text' && item.text) {
            parts.push(`${content.role || role}: ${item.text}`);
          }
        }
      }
    }
  }

  return parts.join('\n\n').slice(0, 10000);
}

/**
 * Extract the task name from scheduled task messages.
 */
function extractTaskName(session: CoworkSession): string | null {
  for (const msg of session.messages) {
    const content = typeof msg.message === 'object' ? msg.message?.content : msg.content;
    const text = typeof content === 'string' ? content : '';
    const match = text.match(/<scheduled-task\s+name="([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

// ============================================================
// Connect & Scan
// ============================================================

/**
 * Connect Cowork — verify sessions exist on disk.
 */
export async function connectCowork(db: Database.Database): Promise<boolean> {
  if (!existsSync(COWORK_BASE)) {
    console.log('  ✗ No Cowork sessions found. Is Claude Desktop installed?');
    if (platform() !== 'darwin') {
      console.log('    Note: Cowork connector currently supports macOS only.');
    }
    return false;
  }

  const sessions = discoverSessions();
  if (sessions.length === 0) {
    console.log('  ✗ No Cowork sessions found in Claude Desktop data.');
    return false;
  }

  // Group by org
  const byOrg = new Map<string, number>();
  for (const s of sessions) {
    byOrg.set(s.orgId, (byOrg.get(s.orgId) || 0) + 1);
  }

  setConfig(db, 'cowork_connected', true);
  setConfig(db, 'cowork_base_path', COWORK_BASE);

  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('cowork', 'connected', ?, datetime('now'))`
  ).run(JSON.stringify({ sessions: sessions.length, orgs: byOrg.size }));

  console.log(`  ✓ Found ${sessions.length} Cowork sessions`);
  for (const [orgId, count] of byOrg) {
    console.log(`    Org ${orgId.slice(0, 8)}...: ${count} sessions`);
  }

  return true;
}

/**
 * Scan Cowork sessions and ingest into knowledge base.
 */
export async function scanCowork(
  db: Database.Database,
  options: { days?: number; maxSessions?: number } = {}
): Promise<{ sessions: number; items: number; skipped: number }> {
  const days = options.days || 90;
  const maxSessions = options.maxSessions || 200;

  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const stats = { sessions: 0, items: 0, skipped: 0 };

  const allSessions = discoverSessions();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Filter by date and sort by most recent
  const sessions = allSessions
    .filter(s => s.lastTimestamp >= cutoff)
    .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
    .slice(0, maxSessions);

  console.log(`  Found ${allSessions.length} total, ${sessions.length} in last ${days} days`);

  // Filter out already-indexed
  const toProcess: CoworkSession[] = [];
  for (const session of sessions) {
    const sourceRef = `cowork:${session.sessionId}`;
    const existing = db.prepare('SELECT id FROM knowledge WHERE source_ref = ?').get(sourceRef);
    if (existing) {
      stats.skipped++;
    } else {
      toProcess.push(session);
    }
  }

  console.log(`  ${toProcess.length} to process, ${stats.skipped} already indexed`);
  if (toProcess.length === 0) return stats;

  // ── Phase 1: Extract conversation text (local, fast) ──
  console.log('  Phase 1: Extracting conversation text...');
  const sessionTexts = toProcess.map(session => {
    const text = extractConversationText(session);
    const taskName = extractTaskName(session);
    return { session, text, taskName };
  }).filter(s => s.text.length > 50); // Skip near-empty sessions

  // ── Phase 2: AI extraction in parallel (5 concurrent) ──
  console.log(`  Phase 2: AI extraction on ${sessionTexts.length} sessions...`);
  const CONCURRENCY = 5;

  interface ProcessedSession {
    session: CoworkSession;
    extracted: Awaited<ReturnType<typeof extractIntelligence>>;
    taskName: string | null;
    text: string;
  }

  const processed: ProcessedSession[] = [];

  for (let i = 0; i < sessionTexts.length; i += CONCURRENCY) {
    const batch = sessionTexts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ session, text, taskName }): Promise<ProcessedSession | null> => {
      try {
        const extracted = await extractIntelligence(text, apiKey);
        return { session, extracted, taskName, text };
      } catch {
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

  // ── Phase 3: Batch embeddings ──
  console.log('  Phase 3: Generating embeddings...');
  const embTexts = processed.map(p => {
    const title = p.taskName
      ? `Cowork: ${p.taskName}`
      : p.extracted.title || `Cowork session: ${p.session.sessionName}`;
    return `${title}\n${p.extracted.summary}`;
  });

  const embeddings = await generateEmbeddings(embTexts, apiKey);
  console.log(`  ${embeddings.length} embeddings generated`);

  // ── Phase 4: Insert into DB ──
  console.log('  Phase 4: Saving to knowledge base...');

  for (let i = 0; i < processed.length; i++) {
    const { session, extracted, taskName } = processed[i];
    const embedding = embeddings[i];

    const title = taskName
      ? `Cowork: ${taskName}`
      : extracted.title || `Cowork session: ${session.sessionName}`;

    const isScheduled = !!taskName;
    const msgCount = session.messages.length;

    const item: KnowledgeItem = {
      id: uuid(),
      title,
      summary: extracted.summary,
      source: 'cowork',
      source_ref: `cowork:${session.sessionId}`,
      source_date: session.lastTimestamp,
      contacts: extracted.contacts,
      organizations: extracted.organizations,
      decisions: extracted.decisions,
      commitments: extracted.commitments,
      action_items: extracted.action_items,
      tags: [
        ...extracted.tags,
        'cowork',
        ...(isScheduled ? ['scheduled-task', `task:${taskName}`] : []),
      ],
      project: extracted.project,
      importance: extracted.importance,
      embedding,
      metadata: {
        cowork_session_id: session.sessionId,
        cowork_session_name: session.sessionName,
        cowork_org_id: session.orgId,
        cowork_device_id: session.deviceId,
        message_count: msgCount,
        is_scheduled_task: isScheduled,
        task_name: taskName,
        first_timestamp: session.firstTimestamp,
        last_timestamp: session.lastTimestamp,
        platform: 'cowork',
      },
    };

    insertKnowledge(db, item);
    stats.items++;
    stats.sessions++;
  }

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('cowork', datetime('now'), ?, 'idle', datetime('now'))`
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
