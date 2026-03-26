import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

// ============================================================
// Claude.ai Internal API Client
// ============================================================

const CLAUDE_API_BASE = 'https://claude.ai/api';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';

interface ClaudeConversation {
  uuid: string;
  name: string;
  summary?: string;
  model?: string;
  created_at: string;
  updated_at: string;
  is_starred?: boolean;
  project_uuid?: string;
  chat_messages?: ClaudeMessage[];
}

interface ClaudeMessage {
  uuid: string;
  text: string;
  sender: 'human' | 'assistant';
  index: number;
  created_at: string;
  attachments?: any[];
  files_v2?: any[];
}

interface ClaudeProject {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ClaudeOrganization {
  uuid: string;
  name: string;
  capabilities?: string[];
}

async function claudeApiGetRaw<T>(path: string, sessionKey: string): Promise<T> {
  const url = `${CLAUDE_API_BASE}${path}`;
  const { request: httpsRequest } = await import('https');

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const req = httpsRequest({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'Cookie': `sessionKey=${sessionKey}`,
      },
    }, async (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        let data = Buffer.concat(chunks);

        if (res.headers['content-encoding'] === 'gzip') {
          const { gunzipSync } = await import('zlib');
          data = gunzipSync(data);
        }

        if (res.statusCode === 403 || res.statusCode === 401) {
          const body = data.toString();
          const isCloudflare = body.includes('Just a moment');
          reject(Object.assign(
            new Error(isCloudflare
              ? `Session expired or Cloudflare blocked: ${path}`
              : `Claude API ${res.statusCode}: ${body.slice(0, 200)}`),
            { statusCode: res.statusCode, isSessionExpired: true }
          ));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Claude API error ${res.statusCode}: ${data.toString().slice(0, 200)}`));
          return;
        }

        try {
          resolve(JSON.parse(data.toString()));
        } catch (e) {
          reject(new Error(`Failed to parse response from ${path}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Wrapper around claudeApiGetRaw that detects expired sessions and
 * attempts one auto-refresh from Claude Desktop's cookie store.
 */
let _sessionRefreshAttempted = false;

async function claudeApiGet<T>(path: string, sessionKey: string, db?: import('better-sqlite3').Database): Promise<T> {
  try {
    return await claudeApiGetRaw<T>(path, sessionKey);
  } catch (err: any) {
    if (err.isSessionExpired && !_sessionRefreshAttempted && db) {
      _sessionRefreshAttempted = true;
      console.log('\n  ⚠ Session key may be expired. Attempting auto-refresh...');

      const newKey = await extractSessionKey();
      if (newKey && newKey !== sessionKey) {
        setConfig(db, 'claude_session_key', newKey);
        console.log('  ✓ Session key refreshed from Claude Desktop');
        try {
          const result = await claudeApiGetRaw<T>(path, newKey);
          _sessionRefreshAttempted = false;
          return result;
        } catch {
          // Refresh didn't help
        }
      }

      console.log('  ✗ Auto-refresh failed. Re-run: recall connect claude');
      _sessionRefreshAttempted = false;
    }
    throw err;
  }
}

// ============================================================
// Session Key Extraction from Claude Desktop
// ============================================================

/**
 * Auto-extract sessionKey from Claude Desktop's encrypted cookie store.
 * Works on macOS only. Requires Claude Desktop to be installed.
 */
export async function extractSessionKey(): Promise<string | null> {
  const cookieDb = join(
    homedir(),
    'Library',
    'Application Support',
    'Claude',
    'Cookies'
  );

  if (!existsSync(cookieDb)) {
    return null;
  }

  try {
    // Step 1: Get the encryption key from macOS Keychain
    const encryptionKey = execSync(
      'security find-generic-password -w -s "Claude Safe Storage"',
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    // Step 2: Read the encrypted cookie from SQLite
    // We shell out to Python because Node's sqlite bindings are async
    // and the cookie decryption requires PBKDF2 + AES which Python handles cleanly
    const { writeFileSync, unlinkSync } = await import('fs');
    const { tmpdir } = await import('os');
    const scriptPath = join(tmpdir(), `prime-decrypt-${Date.now()}.py`);

    const script = [
      'import sqlite3, hashlib, re',
      'from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes',
      '',
      `db = sqlite3.connect('${cookieDb}')`,
      'row = db.execute(\'SELECT encrypted_value FROM cookies WHERE name="sessionKey" AND host_key LIKE "%claude%"\').fetchone()',
      'db.close()',
      '',
      'if not row:',
      '    print("NO_COOKIE")',
      '    exit()',
      '',
      'encrypted = row[0]',
      "if encrypted[:3] != b'v10':",
      '    print("BAD_FORMAT")',
      '    exit()',
      '',
      `password_str = '${encryptionKey}'`,
      "key = hashlib.pbkdf2_hmac('sha1', password_str.encode('utf-8'), b'saltysalt', 1003, dklen=16)",
      'encrypted_data = encrypted[3:]',
      "iv = b' ' * 16",
      'cipher = Cipher(algorithms.AES(key), modes.CBC(iv))',
      'decryptor = cipher.decryptor()',
      'decrypted = decryptor.update(encrypted_data) + decryptor.finalize()',
      '',
      "text = decrypted.decode('latin-1')",
      "matches = re.findall(r'sk-ant-sid\\d+-[A-Za-z0-9_\\-]+', text)",
      'if matches:',
      '    print(matches[0])',
      'else:',
      '    print("NO_KEY_FOUND")',
    ].join('\n');

    writeFileSync(scriptPath, script);

    let result: string;
    try {
      result = execSync(`python3 "${scriptPath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
    } finally {
      try { unlinkSync(scriptPath); } catch {}
    }

    if (result.startsWith('sk-ant-')) {
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Connect & Scan
// ============================================================

/**
 * Connect to Claude.ai — extracts session key and verifies API access.
 *
 * Session key resolution order:
 * 1. Explicit sessionKey parameter (from --session-key flag)
 * 2. CLAUDE_SESSION_KEY environment variable
 * 3. Already saved in Prime config (reconnect/refresh)
 * 4. Auto-extract from Claude Desktop cookie store (requires Keychain access)
 * 5. Manual paste as last resort
 */
export async function connectClaude(db: Database.Database, sessionKeyParam?: string): Promise<boolean> {
  let sessionKey = sessionKeyParam || null;

  // Try env var
  if (!sessionKey && process.env.CLAUDE_SESSION_KEY) {
    sessionKey = process.env.CLAUDE_SESSION_KEY;
    console.log('  ✓ Session key from CLAUDE_SESSION_KEY env var');
  }

  // Try existing config (re-verify)
  if (!sessionKey) {
    const existing = getConfig(db, 'claude_session_key');
    if (existing) {
      sessionKey = existing;
      console.log('  ✓ Session key from existing config (re-verifying...)');
    }
  }

  // Try auto-extraction from Claude Desktop
  if (!sessionKey) {
    console.log('  Attempting auto-extraction from Claude Desktop...');
    sessionKey = await extractSessionKey();
    if (sessionKey) {
      console.log('  ✓ Session key extracted from Claude Desktop');
    }
  }

  // Fall back to manual entry
  if (!sessionKey) {
    console.log('  Auto-extraction failed. Please paste your sessionKey.');
    console.log('  (Browser DevTools → Application → Cookies → claude.ai → sessionKey)');
    console.log('  Or set CLAUDE_SESSION_KEY env var to skip this step next time.');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
    sessionKey = (await ask('  sessionKey: ')).trim();
    rl.close();

    if (!sessionKey.startsWith('sk-ant-')) {
      console.log('  ✗ Invalid session key. Must start with sk-ant-');
      return false;
    }
  }

  // Verify by fetching organizations
  try {
    const orgs = await claudeApiGet<ClaudeOrganization[]>('/organizations', sessionKey);
    if (!orgs || orgs.length === 0) {
      console.log('  ✗ No organizations found. Session key may be invalid.');
      return false;
    }

    // Save session key and org info
    setConfig(db, 'claude_session_key', sessionKey);
    setConfig(db, 'claude_organizations', orgs.map(o => ({
      uuid: o.uuid,
      name: o.name,
      capabilities: o.capabilities,
    })));

    // Use the first org with chat capability, prefer work orgs
    const chatOrg = orgs.find(o => o.capabilities?.includes('chat') && !o.name.includes('@'))
      || orgs.find(o => o.capabilities?.includes('chat'))
      || orgs[0];

    setConfig(db, 'claude_active_org', chatOrg.uuid);

    db.prepare(
      `INSERT OR REPLACE INTO sync_state (source, status, config, updated_at) VALUES ('claude', 'connected', ?, datetime('now'))`
    ).run(JSON.stringify({ org: chatOrg.name, org_uuid: chatOrg.uuid, org_count: orgs.length }));

    console.log(`  ✓ Connected to Claude.ai`);
    console.log(`  Organizations:`);
    for (const org of orgs) {
      const active = org.uuid === chatOrg.uuid ? ' (active)' : '';
      console.log(`    ${org.name}${active}`);
    }

    return true;
  } catch (err: any) {
    console.log(`  ✗ Failed to connect: ${err.message}`);
    return false;
  }
}

/**
 * Extract artifacts from messages.
 *
 * Artifacts are stored in TWO places:
 * 1. As <antArtifact> XML tags in assistant message text (older format)
 * 2. As attachments on messages (current API format) — with extracted_content
 */
function extractArtifacts(messages: ClaudeMessage[]): { title: string; type: string; identifier: string; content: string }[] {
  const artifacts: { title: string; type: string; identifier: string; content: string }[] = [];

  for (const msg of messages) {
    // Method 1: Parse <antArtifact> XML from assistant text
    if (msg.sender === 'assistant' && msg.text) {
      const regex = /<antArtifact\s+([^>]*)>([\s\S]*?)<\/antArtifact>/g;
      let match;
      while ((match = regex.exec(msg.text)) !== null) {
        const attrs = match[1];
        const content = match[2].trim();
        const getAttr = (name: string) => {
          const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
          return m ? m[1] : '';
        };
        artifacts.push({
          title: getAttr('title') || 'Untitled artifact',
          type: getAttr('type') || 'unknown',
          identifier: getAttr('identifier') || `xml-${msg.uuid}`,
          content,
        });
      }
    }

    // Method 2: Extract from attachments (current API format)
    const attachments = msg.attachments || [];
    for (const att of attachments) {
      if (att.extracted_content && att.extracted_content.length > 100) {
        // Determine artifact type from file_type and content
        const fileType = att.file_type || 'unknown';
        let artifactType = 'document';
        if (['tsx', 'jsx', 'ts', 'js', 'py'].includes(fileType) || att.extracted_content.includes('import ') || att.extracted_content.includes('function ')) {
          artifactType = 'code';
        } else if (att.extracted_content.includes('<html') || att.extracted_content.includes('<!DOCTYPE')) {
          artifactType = 'html';
        } else if (fileType === 'svg' || att.extracted_content.includes('<svg')) {
          artifactType = 'svg';
        }

        // Try to infer title from first meaningful line or file_name
        let title = att.file_name || '';
        if (!title) {
          // Look for component names, function names, or class names
          const nameMatch = att.extracted_content.match(/(?:export default function|function|class|const)\s+(\w+)/);
          if (nameMatch) {
            title = nameMatch[1];
          } else {
            // Use first non-empty line
            const firstLine = att.extracted_content.split('\n').find((l: string) => l.trim().length > 5);
            title = firstLine?.trim().slice(0, 60) || 'Attachment artifact';
          }
        }

        artifacts.push({
          title,
          type: artifactType,
          identifier: att.id || `att-${msg.uuid}`,
          content: att.extracted_content,
        });
      }
    }
  }

  return artifacts;
}

/**
 * Strip artifact XML from text, leaving just the conversational content.
 */
function stripArtifacts(text: string): string {
  return text
    .replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '[artifact]')
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/g, '')
    .trim();
}

/**
 * Scan Claude.ai conversations and ingest into the knowledge base.
 */
export async function scanClaude(
  db: Database.Database,
  options: { days?: number; maxConversations?: number; orgId?: string } = {}
): Promise<{ conversations: number; items: number; artifacts: number; skipped: number }> {
  const days = options.days || 90;
  const maxConversations = options.maxConversations || 200;

  const sessionKey = getConfig(db, 'claude_session_key');
  const apiKey = getConfig(db, 'openai_api_key');
  const orgId = options.orgId || getConfig(db, 'claude_active_org');

  if (!sessionKey) throw new Error('Claude not connected. Run: recall connect claude');
  if (!apiKey) throw new Error('No API key. Run: recall init');
  if (!orgId) throw new Error('No active organization. Run: recall connect claude');

  const stats = { conversations: 0, items: 0, artifacts: 0, skipped: 0 };

  // Fetch conversation list
  const allConversations = await claudeApiGet<ClaudeConversation[]>(
    `/organizations/${orgId}/chat_conversations`,
    sessionKey
  );

  // Filter by date
  const cutoff = new Date(Date.now() - days * 86400000);
  const conversations = allConversations
    .filter(c => new Date(c.updated_at) >= cutoff)
    .slice(0, maxConversations);

  console.log(`  Found ${allConversations.length} total, ${conversations.length} in last ${days} days`);

  // Fetch projects for enrichment
  let projects: ClaudeProject[] = [];
  try {
    projects = await claudeApiGet<ClaudeProject[]>(
      `/organizations/${orgId}/projects`,
      sessionKey
    );
  } catch {
    // Non-fatal
  }

  const projectMap = new Map(projects.map(p => [p.uuid, p.name]));

  // ---- PHASE 1: Fetch all conversations in parallel (batches of 10) ----
  console.log('  Phase 1: Fetching conversation details...');

  // Filter out already-indexed conversations first
  const toFetch: ClaudeConversation[] = [];
  for (const convoMeta of conversations) {
    const existing = db.prepare(
      `SELECT id FROM knowledge WHERE source_ref = ? AND updated_at > ?`
    ).get(`claude:${convoMeta.uuid}`, convoMeta.updated_at);
    if (existing) {
      stats.skipped++;
    } else {
      toFetch.push(convoMeta);
    }
  }

  console.log(`  ${toFetch.length} to process, ${stats.skipped} already indexed`);

  // Parallel fetch with timeout
  const FETCH_CONCURRENCY = 10;
  const FETCH_TIMEOUT = 15000; // 15s per conversation

  const fetchWithTimeout = async (convoMeta: ClaudeConversation): Promise<ClaudeConversation | null> => {
    try {
      return await Promise.race([
        claudeApiGet<ClaudeConversation>(
          `/organizations/${orgId}/chat_conversations/${convoMeta.uuid}`,
          sessionKey
        ),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT)),
      ]);
    } catch {
      return null;
    }
  };

  const fetchedConversations: ClaudeConversation[] = [];
  for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchWithTimeout));
    for (const r of results) {
      if (r && (r.chat_messages?.length ?? 0) >= 2) {
        fetchedConversations.push(r);
      } else {
        stats.skipped++;
      }
    }
    process.stdout.write(`\r  Fetched: ${Math.min(i + FETCH_CONCURRENCY, toFetch.length)}/${toFetch.length}`);
  }
  console.log('');

  // ---- PHASE 2: AI extraction in parallel (batches of 5) ----
  console.log(`  Phase 2: AI extraction on ${fetchedConversations.length} conversations...`);

  const EXTRACT_CONCURRENCY = 5;

  interface ProcessedConvo {
    convo: ClaudeConversation;
    extracted: Awaited<ReturnType<typeof extractIntelligence>>;
    artifacts: { title: string; type: string; identifier: string; content: string }[];
    projectName: string | null;
    conversationText: string;
  }

  const processedConversations: ProcessedConvo[] = [];

  for (let i = 0; i < fetchedConversations.length; i += EXTRACT_CONCURRENCY) {
    const batch = fetchedConversations.slice(i, i + EXTRACT_CONCURRENCY);
    const results = await Promise.all(batch.map(async (convo): Promise<ProcessedConvo | null> => {
      try {
        const messages = convo.chat_messages || [];
        const conversationText = messages
          .map(m => `${m.sender}: ${stripArtifacts(m.text)}`)
          .join('\n\n')
          .slice(0, 8000);

        // Extract artifacts from ALL messages (assistant text + attachments)
        const artifacts = extractArtifacts(messages);

        const extracted = await extractIntelligence(conversationText, apiKey);
        const projectName = convo.project_uuid ? (projectMap.get(convo.project_uuid) ?? null) : null;

        return { convo, extracted, artifacts, projectName, conversationText };
      } catch {
        return null;
      }
    }));

    for (const r of results) {
      if (r) processedConversations.push(r);
      else stats.skipped++;
    }
    process.stdout.write(`\r  Extracted: ${Math.min(i + EXTRACT_CONCURRENCY, fetchedConversations.length)}/${fetchedConversations.length}`);
  }
  console.log('');

  // ---- PHASE 3: Generate embeddings in batch ----
  console.log(`  Phase 3: Generating embeddings...`);

  // Collect all texts that need embeddings
  const embeddingTexts: string[] = [];
  const embeddingIndex: { type: 'conversation' | 'artifact'; idx: number; artifactIdx?: number }[] = [];

  for (let i = 0; i < processedConversations.length; i++) {
    const { convo, extracted, artifacts, projectName } = processedConversations[i];

    // Conversation embedding
    const embText = [
      convo.name || extracted.title,
      extracted.summary,
      projectName ? `Project: ${projectName}` : '',
      artifacts.length ? `Artifacts: ${artifacts.map(a => a.title).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    embeddingTexts.push(embText);
    embeddingIndex.push({ type: 'conversation', idx: i });

    // Artifact embeddings
    for (let j = 0; j < artifacts.length; j++) {
      if (artifacts[j].content.length < 100) continue;
      embeddingTexts.push(`${artifacts[j].title}\n${artifacts[j].content.slice(0, 2000)}`);
      embeddingIndex.push({ type: 'artifact', idx: i, artifactIdx: j });
    }
  }

  // Batch embeddings (OpenAI supports up to 100 at a time)
  const { generateEmbeddings } = await import('../embedding.js');
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < embeddingTexts.length; i += 100) {
    const batch = embeddingTexts.slice(i, i + 100);
    const embeddings = await generateEmbeddings(batch, apiKey);
    allEmbeddings.push(...embeddings);
    process.stdout.write(`\r  Embeddings: ${Math.min(i + 100, embeddingTexts.length)}/${embeddingTexts.length}`);
  }
  console.log('');

  // ---- PHASE 4: Insert into database ----
  console.log(`  Phase 4: Saving to knowledge base...`);

  for (let ei = 0; ei < embeddingIndex.length; ei++) {
    const entry = embeddingIndex[ei];
    const embedding = allEmbeddings[ei];
    const { convo, extracted, artifacts, projectName } = processedConversations[entry.idx];

    if (entry.type === 'conversation') {
      const item: KnowledgeItem = {
        id: uuid(),
        title: convo.name || extracted.title || 'Claude conversation',
        summary: extracted.summary,
        source: 'claude',
        source_ref: `claude:${convo.uuid}`,
        source_date: convo.updated_at || convo.created_at,
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        decisions: extracted.decisions,
        commitments: extracted.commitments,
        action_items: extracted.action_items,
        tags: [
          ...extracted.tags,
          'claude-conversation',
          ...(convo.is_starred ? ['starred'] : []),
          ...(convo.model ? [`model:${convo.model}`] : []),
        ],
        project: projectName || extracted.project || undefined,
        importance: convo.is_starred ? 'high' : extracted.importance,
        embedding,
        metadata: {
          conversation_uuid: convo.uuid,
          model: convo.model,
          message_count: (convo.chat_messages || []).length,
          project_uuid: convo.project_uuid,
          project_name: projectName,
          artifact_count: artifacts.length,
          artifact_titles: artifacts.map(a => a.title),
          is_starred: convo.is_starred,
          platform: 'claude.ai',
        },
      };

      insertKnowledge(db, item);
      stats.items++;
      stats.conversations++;
      stats.artifacts += artifacts.length;
    } else if (entry.type === 'artifact' && entry.artifactIdx !== undefined) {
      const artifact = artifacts[entry.artifactIdx!];

      // Check for existing versions of this artifact (by title match)
      const existingVersions = db.prepare(
        "SELECT id, source_date, metadata FROM knowledge WHERE title LIKE ? AND source = 'claude' AND tags LIKE '%claude-artifact%' ORDER BY source_date DESC"
      ).all(`Artifact: ${artifact.title}%`) as any[];

      const versionNum = existingVersions.length + 1;
      const isUpdate = existingVersions.length > 0;

      // Mark previous versions as superseded
      if (isUpdate) {
        const latestPrev = existingVersions[0];
        db.prepare(
          "UPDATE knowledge SET valid_until = datetime('now'), superseded_by = ?, importance = 'low' WHERE id = ?"
        ).run(`artifact-v${versionNum}`, latestPrev.id);
      }

      // Store more content in the summary for better searchability
      const contentPreview = artifact.content.slice(0, 800).replace(/\n/g, ' ').trim();

      const artifactItem: KnowledgeItem = {
        id: uuid(),
        title: `Artifact: ${artifact.title}${versionNum > 1 ? ` (v${versionNum})` : ''}`,
        summary: `${artifact.type} artifact${isUpdate ? ` (version ${versionNum}, updated)` : ''} from conversation "${convo.name || 'Untitled'}". Content: ${contentPreview}`,
        source: 'claude',
        source_ref: `claude-artifact:${convo.uuid}:${artifact.identifier}`,
        source_date: convo.updated_at || convo.created_at,
        contacts: extracted.contacts,
        organizations: extracted.organizations,
        tags: [
          'claude-artifact',
          `artifact-type:${artifact.type}`,
          ...(projectName ? [projectName] : []),
          ...(isUpdate ? ['updated-artifact', `version:${versionNum}`] : ['new-artifact']),
          ...(artifact.title.toLowerCase().includes('brand') ? ['branding'] : []),
          ...(artifact.title.toLowerCase().includes('logo') ? ['branding', 'logo'] : []),
        ],
        project: projectName || extracted.project || undefined,
        importance: isUpdate ? 'high' : 'normal', // Updates are more important — they represent the latest
        embedding,
        metadata: {
          artifact_type: artifact.type,
          artifact_identifier: artifact.identifier,
          conversation_uuid: convo.uuid,
          conversation_name: convo.name,
          content_length: artifact.content.length,
          content_preview: artifact.content.slice(0, 2000), // Store more content for retrieval
          version: versionNum,
          is_latest: true,
          previous_version_id: existingVersions[0]?.id || null,
          total_versions: versionNum,
        },
      };

      insertKnowledge(db, artifactItem);
      stats.items++;
    }
  }

  // Update sync state
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('claude', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.items);

  return stats;
}

// ============================================================
// Legacy: Import from file exports (kept for backward compat)
// ============================================================

export async function importClaudeConversations(
  db: Database.Database,
  path: string,
  options: { project?: string } = {}
): Promise<{ conversations: number; items: number }> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const stats = { conversations: 0, items: 0 };

  if (path.endsWith('.json')) {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const conversations = Array.isArray(data) ? data : data.conversations || [];

    for (const convo of conversations) {
      try {
        const messages = convo.chat_messages || convo.messages || [];
        if (messages.length < 2) continue;

        const text = messages
          .map((m: any) => `${m.sender || m.role}: ${stripArtifacts(m.text || m.content || '')}`)
          .join('\n\n')
          .slice(0, 8000);

        const extracted = await extractIntelligence(text, apiKey);
        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: uuid(),
          title: extracted.title || convo.name || convo.title || 'Claude conversation',
          summary: extracted.summary,
          source: 'claude',
          source_ref: `claude:${convo.uuid || convo.id || uuid()}`,
          source_date: convo.created_at || convo.updated_at || new Date().toISOString(),
          contacts: extracted.contacts,
          organizations: extracted.organizations,
          decisions: extracted.decisions,
          commitments: extracted.commitments,
          action_items: extracted.action_items,
          tags: [...extracted.tags, 'claude-conversation'],
          project: options.project || extracted.project || undefined,
          importance: extracted.importance,
          embedding,
        };

        insertKnowledge(db, item);
        stats.items++;
        stats.conversations++;

        await new Promise(r => setTimeout(r, 200));
      } catch {
        continue;
      }
    }
  } else {
    const files = readdirSync(path)
      .filter(f => extname(f) === '.md' || extname(f) === '.txt')
      .map(f => join(path, f));

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.length < 50) continue;

        let metadata: Record<string, any> = {};
        let bodyContent = content;

        if (content.startsWith('---')) {
          const endIdx = content.indexOf('---', 3);
          if (endIdx > 0) {
            const frontmatter = content.slice(3, endIdx).trim();
            bodyContent = content.slice(endIdx + 3).trim();
            for (const line of frontmatter.split('\n')) {
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                metadata[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
              }
            }
          }
        }

        const extracted = await extractIntelligence(bodyContent.slice(0, 6000), apiKey);
        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: uuid(),
          title: metadata.title || extracted.title || basename(filePath, extname(filePath)),
          summary: metadata.summary || extracted.summary,
          source: 'claude',
          source_ref: filePath,
          source_date: metadata.date || new Date().toISOString(),
          contacts: extracted.contacts,
          organizations: extracted.organizations,
          decisions: extracted.decisions,
          commitments: extracted.commitments,
          action_items: extracted.action_items,
          tags: [...extracted.tags, 'claude-conversation', ...(metadata.label ? [metadata.label] : [])],
          project: options.project || metadata.project || extracted.project || undefined,
          importance: extracted.importance,
          embedding,
        };

        insertKnowledge(db, item);
        stats.items++;
        stats.conversations++;

        await new Promise(r => setTimeout(r, 200));
      } catch {
        continue;
      }
    }
  }

  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('claude', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(stats.items);

  return stats;
}
