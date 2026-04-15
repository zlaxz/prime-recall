import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig } from '../db.js';
import { getDefaultProvider } from './providers.js';
import { search } from './search.js';
import { getCorrectionRules } from '../intelligence-loop.js';
import { getThreadContext } from '../narrative-threads.js';
import { retrieveDeepContext } from '../source-retrieval.js';

// ============================================================
// Prime Chat Engine — Multi-turn conversational AI
//
// Replaces Claude Desktop as the primary chat interface.
// Project-organized, context-injected, action-generating.
// ============================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: any[];
  actions_generated?: string[];
  intent?: string;
  created_at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  summary?: string;
  session_type: string;
  status: string;
  primary_project?: string;
  primary_thread_id?: string;
  message_count: number;
  last_summary?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatResponse {
  session_id: string;
  message_id: string;
  content: string;
  sources: any[];
  actions: any[];
  intent: string;
  threads_linked: string[];
  suggested_followups: string[];
}

// ── Speculative Context Cache ─────────────────────────
// Pre-computed context for predicted follow-up topics.
// Key = lowercase topic/entity name, value = pre-built context + expiry.

interface CachedContext {
  context: string;
  expires: number;
}

const speculativeCache = new Map<string, CachedContext>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedContext(key: string): string | null {
  const entry = speculativeCache.get(key.toLowerCase());
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    speculativeCache.delete(key.toLowerCase());
    return null;
  }
  return entry.context;
}

function setCachedContext(key: string, context: string): void {
  speculativeCache.set(key.toLowerCase(), {
    context,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

/** Evict all expired entries. Called after each response. */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of speculativeCache) {
    if (now > entry.expires) speculativeCache.delete(key);
  }
}

// ── Intent Classification ─────────────────────────────

export function classifyIntent(message: string): 'search' | 'question' | 'investigation' | 'action' | 'correction' {
  const lower = message.toLowerCase().trim();

  // Action patterns
  if (/^(draft|send|email|schedule|remind|book|create|set up|approve|reject)\b/.test(lower)) return 'action';
  if (/\b(draft an? email|send an? email|schedule a? meeting|remind me|set a? reminder)\b/.test(lower)) return 'action';

  // Correction patterns
  if (/^(actually|no,|correct|update|change|mark|tell prime|that's wrong)\b/.test(lower)) return 'correction';
  if (/\bis (a |an )?(vendor|client|partner|employee|carrier|broker)\b/.test(lower)) return 'correction';

  // Search patterns
  if (/^(find|search|who is|when did|look up|show me|get me)\b/.test(lower)) return 'search';

  // Investigation patterns
  if (/^(analyze|compare|investigate|why is|deep dive|full picture|what should)\b/.test(lower)) return 'investigation';
  if (/\b(stalling|failing|behind|overdue|risk|problem)\b/.test(lower) && lower.length > 30) return 'investigation';

  return 'question';
}

// ── Context Assembly ──────────────────────────────────

async function buildChatContext(
  db: Database.Database,
  session: ChatSession | null,
  query: string
): Promise<{ systemPrompt: string; history: { role: string; content: string }[] }> {
  const businessCtx = getConfig(db, 'business_context') || '';
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // ================================================================
  // PINNED CONTEXT — Layer 0
  // Everything in this block is PERMANENT. It must appear at the TOP
  // of the system prompt and must NEVER be compressed, summarized,
  // or removed during context-window management. If the window is
  // too large, trim from the BOTTOM (search results, history) first.
  // ================================================================
  let system = `The following context is PERMANENT and takes priority over any contradicting information in the conversation history.

You are Prime, an AI Chief of Staff for Zach Stock (Recapture Insurance MGA founder, ADHD).
Today is ${todayStr}.
${businessCtx ? '\nBusiness context: ' + businessCtx : ''}`;

  // PINNED: Entity correction rules — user-verified truth, never contradicted
  const corrRules = getCorrectionRules(db);
  if (corrRules) system += '\n\n' + corrRules;

  // PINNED: Active predictions — system's current bets on the future
  const predictions = db.prepare(
    "SELECT prediction, confidence, subject FROM predictions WHERE outcome = 'pending' ORDER BY prediction_date DESC LIMIT 5"
  ).all() as any[];
  if (predictions.length > 0) {
    system += '\n\nACTIVE PREDICTIONS:\n' + predictions.map((p: any) =>
      `- ${p.prediction} (${Math.round(p.confidence * 100)}% confidence)`
    ).join('\n');
  }

  // PINNED: Current project state (thread narrative)
  if (session?.primary_thread_id) {
    const thread = db.prepare(
      'SELECT title, narrative_md, current_state, next_action FROM narrative_threads WHERE id = ?'
    ).get(session.primary_thread_id) as any;
    if (thread) {
      system += `\n\nNARRATIVE THREAD: "${thread.title}"\nCurrent state: ${thread.current_state}\nNext action: ${thread.next_action}\n${thread.narrative_md ? thread.narrative_md.slice(0, 1500) : ''}`;
    }
  } else if (session?.primary_project) {
    const threadCtx = getThreadContext(db, session.primary_project);
    if (threadCtx) system += '\n\n' + threadCtx;
  }

  // ================================================================
  // END PINNED CONTEXT — everything below can be trimmed if needed
  // ================================================================

  system += `\n\nYou have access to Zach's complete business knowledge base — emails, meetings, calendar, Claude conversations, and documents. Answer from this data, not general knowledge. Cite specific dates and sources.

When asked to draft an email, include it as:
\`\`\`action:email
{"to": "recipient@email.com", "subject": "...", "body": "..."}
\`\`\`

When asked to schedule a meeting, include:
\`\`\`action:calendar
{"title": "...", "start_time": "ISO date", "duration_min": 30, "attendees": ["email"]}
\`\`\`

When asked to set a reminder, include:
\`\`\`action:reminder
{"text": "...", "due_date": "YYYY-MM-DD"}
\`\`\`

Write for someone with ADHD: be direct, lead with the answer, skip filler.`;

  // Layer 1.5: Check speculative cache for pre-loaded context
  const cacheHits: string[] = [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const [key] of speculativeCache) {
    // Match if the query contains the cached topic name
    if (query.toLowerCase().includes(key) || queryWords.some(w => key.includes(w))) {
      const cached = getCachedContext(key);
      if (cached) cacheHits.push(cached);
    }
  }
  if (cacheHits.length > 0) {
    system += '\n\nSPECULATIVE PRE-LOADED CONTEXT (from previous turn analysis):\n' + cacheHits.slice(0, 2).join('\n\n');
  }

  // Layer 2: Entity profiles for detected people
  const entityNames = extractEntityNames(query, db);
  if (entityNames.length > 0) {
    const profiles = db.prepare(`
      SELECT e.canonical_name, e.user_label, e.email, ep.communication_nature, ep.alert_verdict
      FROM entities e LEFT JOIN entity_profiles ep ON e.id = ep.entity_id
      WHERE e.canonical_name IN (${entityNames.map(() => '?').join(',')}) AND e.user_dismissed = 0
    `).all(...entityNames) as any[];
    if (profiles.length > 0) {
      system += '\n\nPEOPLE MENTIONED:\n' + profiles.map((p: any) =>
        `${p.canonical_name}: ${p.user_label || 'unknown'}, ${p.email || 'no email'}${p.communication_nature ? ', ' + p.communication_nature : ''}`
      ).join('\n');
    }
  }

  // Layer 4: Chat history
  const history: { role: string; content: string }[] = [];
  if (session) {
    const msgs = db.prepare(
      'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(session.id) as any[];
    // Keep last 20 messages for context window management
    const recent = msgs.slice(-20);
    for (const m of recent) {
      history.push({ role: m.role, content: m.content });
    }

    // If session has a summary of older messages, prepend it
    if (session.last_summary && msgs.length > 20) {
      system += `\n\nPREVIOUS CONVERSATION SUMMARY:\n${session.last_summary}`;
    }
  }

  // Layer 5: Search results (always real-time)
  const searchResult = await search(db, query, { limit: 10, rerank: true });
  if (searchResult.items.length > 0) {
    system += '\n\nRELEVANT KNOWLEDGE (from search — may be more recent than thread narrative):\n' +
      searchResult.items.slice(0, 8).map((item: any, i: number) => {
        const age = item.source_date ? Math.round((Date.now() - new Date(item.source_date).getTime()) / 86400000) : '?';
        return `[${i + 1}] [${item.source}] ${item.source_date?.slice(0, 10)} (${age}d ago): ${item.title}\n  ${item.summary?.slice(0, 200)}`;
      }).join('\n');
  }

  // Layer 5.5: Deep source retrieval for top search results
  if (searchResult.items.length > 0) {
    try {
      const deepContent = await retrieveDeepContext(db, searchResult.items.slice(0, 3), 3);
      if (deepContent) {
        system += '\n\nDETAILED SOURCE MATERIAL:\n' + deepContent;
      }
    } catch (err: any) {
      // Non-fatal — chat still works with summaries only
      console.log(`  Chat deep retrieval warning: ${err.message?.slice(0, 100)}`);
    }
  }

  // Layer 6: Pending staged actions
  const pendingActions = db.prepare(
    "SELECT type, summary, project FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 5"
  ).all() as any[];
  if (pendingActions.length > 0) {
    system += '\n\nPENDING ACTIONS (awaiting approval):\n' +
      pendingActions.map((a: any) => `- [${a.type}] ${a.summary}${a.project ? ' (' + a.project + ')' : ''}`).join('\n');
  }

  return { systemPrompt: system, history };
}

// ── Entity Name Extraction ────────────────────────────

function extractEntityNames(query: string, db: Database.Database): string[] {
  // Get known entity names and check if they appear in the query
  const entities = db.prepare(
    "SELECT canonical_name FROM entities WHERE user_dismissed = 0 AND type = 'person' ORDER BY LENGTH(canonical_name) DESC LIMIT 200"
  ).all() as any[];

  const lower = query.toLowerCase();
  const matches: string[] = [];
  for (const e of entities) {
    const name = e.canonical_name;
    // Check if first name or full name appears
    const firstName = name.split(' ')[0];
    if (lower.includes(name.toLowerCase()) || (firstName.length > 3 && lower.includes(firstName.toLowerCase()))) {
      matches.push(name);
      if (matches.length >= 5) break;
    }
  }
  return matches;
}

// ── Action Parsing ────────────────────────────────────

function parseActions(response: string, db: Database.Database, sessionId: string): string[] {
  const actionIds: string[] = [];
  const actionRegex = /```action:(email|calendar|reminder)\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = actionRegex.exec(response)) !== null) {
    const type = match[1];
    try {
      const payload = JSON.parse(match[2]);
      const id = db.prepare(`
        INSERT INTO staged_actions (type, summary, payload, reasoning, project, source_task, expires_at)
        VALUES (?, ?, ?, ?, ?, 'chat', datetime('now', '+72 hours'))
        RETURNING id
      `).get(
        type,
        payload.subject || payload.title || payload.text || 'Chat action',
        JSON.stringify(payload),
        'Generated from chat conversation',
        null,
      ) as any;

      if (id) actionIds.push(String(id.id));
    } catch (_e) {}
  }

  return actionIds;
}

// ── Speculative Pre-loading ───────────────────────────
// After each response, predict what the user will ask next and
// pre-compute context for the top 3 likely follow-up topics.

interface MentionedTopic {
  type: 'entity' | 'project';
  name: string;
  id?: string;
}

/** Scan the response + query for entities and projects mentioned in this turn. */
function detectMentionedTopics(db: Database.Database, query: string, response: string): MentionedTopic[] {
  const combined = (query + ' ' + response).toLowerCase();
  const topics: MentionedTopic[] = [];

  // Detect entities
  const entities = db.prepare(
    "SELECT id, canonical_name FROM entities WHERE user_dismissed = 0 AND type = 'person' ORDER BY LENGTH(canonical_name) DESC LIMIT 200"
  ).all() as any[];

  for (const e of entities) {
    const name: string = e.canonical_name;
    const firstName = name.split(' ')[0];
    if (combined.includes(name.toLowerCase()) || (firstName.length > 3 && combined.includes(firstName.toLowerCase()))) {
      topics.push({ type: 'entity', name, id: e.id });
      if (topics.filter(t => t.type === 'entity').length >= 5) break;
    }
  }

  // Detect projects
  const projects = db.prepare(
    "SELECT DISTINCT project FROM narrative_threads WHERE status = 'active' AND project IS NOT NULL"
  ).all() as any[];

  for (const p of projects) {
    if (p.project && combined.includes(p.project.toLowerCase())) {
      topics.push({ type: 'project', name: p.project });
    }
  }

  return topics;
}

/** For a given entity, find the top related entities via entity_edges (current edges only). */
function getRelatedEntities(db: Database.Database, entityId: string, limit: number = 3): { id: string; name: string }[] {
  return db.prepare(`
    SELECT e.id, e.canonical_name as name
    FROM entity_edges ee
    JOIN entities e ON (
      CASE WHEN ee.source_entity_id = ? THEN ee.target_entity_id
           ELSE ee.source_entity_id END = e.id
    )
    WHERE (ee.source_entity_id = ? OR ee.target_entity_id = ?)
      AND ee.invalid_at IS NULL
      AND e.user_dismissed = 0
    ORDER BY ee.co_occurrence_count DESC LIMIT ?
  `).all(entityId, entityId, entityId, limit) as any[];
}

/** Build a context snippet for a single entity (profile + recent items + threads). */
function buildEntityContext(db: Database.Database, entityId: string, entityName: string): string {
  const parts: string[] = [`PRE-LOADED CONTEXT FOR: ${entityName}`];

  // Profile
  const profile = db.prepare(`
    SELECT e.canonical_name, e.user_label, e.email, e.relationship_type,
           ep.communication_nature, ep.alert_verdict
    FROM entities e LEFT JOIN entity_profiles ep ON e.id = ep.entity_id
    WHERE e.id = ?
  `).get(entityId) as any;

  if (profile) {
    parts.push(`Role: ${profile.user_label || profile.relationship_type || 'unknown'}, Email: ${profile.email || 'unknown'}${profile.communication_nature ? ', Nature: ' + profile.communication_nature : ''}`);
  }

  // Recent items
  const recentItems = db.prepare(`
    SELECT k.title, k.source, k.source_date
    FROM knowledge_primary k
    JOIN entity_mentions em ON k.id = em.knowledge_item_id
    WHERE em.entity_id = ?
    ORDER BY k.source_date DESC LIMIT 5
  `).all(entityId) as any[];

  if (recentItems.length > 0) {
    parts.push('Recent activity:');
    for (const item of recentItems) {
      parts.push(`  - [${item.source}] ${item.source_date?.slice(0, 10) || '?'}: ${item.title}`);
    }
  }

  // Threads involving this entity
  const threads = db.prepare(`
    SELECT title, current_state, project FROM narrative_threads
    WHERE status = 'active' AND entity_ids LIKE ?
    ORDER BY latest_source_date DESC LIMIT 3
  `).all(`%${entityId}%`) as any[];

  if (threads.length > 0) {
    parts.push('Active threads:');
    for (const t of threads) {
      parts.push(`  - ${t.title} (${t.project || 'no project'}): ${t.current_state || 'unknown state'}`);
    }
  }

  // Connected entities
  const connected = getRelatedEntities(db, entityId, 5);
  if (connected.length > 0) {
    parts.push('Connected to: ' + connected.map(c => c.name).join(', '));
  }

  return parts.join('\n');
}

/** Build a context snippet for a project (threads + stalling comparison). */
function buildProjectContext(db: Database.Database, project: string): string {
  const parts: string[] = [`PRE-LOADED CONTEXT FOR PROJECT: ${project}`];

  const threads = db.prepare(`
    SELECT title, current_state, next_action, latest_source_date
    FROM narrative_threads WHERE status = 'active' AND project = ?
    ORDER BY latest_source_date DESC LIMIT 5
  `).all(project) as any[];

  if (threads.length > 0) {
    parts.push('Threads:');
    for (const t of threads) {
      const age = t.latest_source_date ? Math.round((Date.now() - new Date(t.latest_source_date).getTime()) / 86400000) : '?';
      parts.push(`  - ${t.title} (${age}d since last activity): ${t.current_state || '?'}`);
      if (t.next_action) parts.push(`    Next: ${t.next_action}`);
    }
  }

  // Stalling projects for comparison
  const stallingThreads = db.prepare(`
    SELECT project, title, current_state, latest_source_date
    FROM narrative_threads
    WHERE status = 'active' AND project != ? AND project IS NOT NULL
      AND latest_source_date < datetime('now', '-7 days')
    ORDER BY latest_source_date ASC LIMIT 5
  `).all(project) as any[];

  if (stallingThreads.length > 0) {
    parts.push('Other stalling projects (for comparison):');
    for (const t of stallingThreads) {
      const age = t.latest_source_date ? Math.round((Date.now() - new Date(t.latest_source_date).getTime()) / 86400000) : '?';
      parts.push(`  - [${t.project}] ${t.title}: ${t.current_state || '?'} (${age}d stale)`);
    }
  }

  return parts.join('\n');
}

/**
 * Fire-and-forget: after responding, pre-compute context for predicted follow-ups.
 * Populates speculativeCache with the top 3 likely next topics.
 */
function preloadSpeculativeContext(db: Database.Database, query: string, response: string): void {
  try {
    const topics = detectMentionedTopics(db, query, response);
    let preloaded = 0;

    for (const topic of topics) {
      if (preloaded >= 3) break;

      if (topic.type === 'entity' && topic.id) {
        // Pre-load related entities (the user discussed entity X, they'll likely ask about X's connections)
        const related = getRelatedEntities(db, topic.id, 3);
        for (const rel of related) {
          if (preloaded >= 3) break;
          const key = rel.name.toLowerCase();
          if (!speculativeCache.has(key)) {
            setCachedContext(key, buildEntityContext(db, rel.id, rel.name));
            preloaded++;
          }
        }

        // Also pre-load the entity's own threads (user may ask "what about their threads?")
        const threadKey = `${topic.name.toLowerCase()}_threads`;
        if (!speculativeCache.has(threadKey)) {
          const threads = db.prepare(`
            SELECT title, current_state, project FROM narrative_threads
            WHERE status = 'active' AND entity_ids LIKE ?
            ORDER BY latest_source_date DESC LIMIT 3
          `).all(`%${topic.id}%`) as any[];
          if (threads.length > 0) {
            const ctx = threads.map((t: any) => `- ${t.title} (${t.project || 'no project'}): ${t.current_state || '?'}`).join('\n');
            setCachedContext(threadKey, `THREADS INVOLVING ${topic.name}:\n${ctx}`);
          }
        }
      }

      if (topic.type === 'project') {
        const key = topic.name.toLowerCase();
        if (!speculativeCache.has(key)) {
          setCachedContext(key, buildProjectContext(db, topic.name));
          preloaded++;
        }
      }
    }

    evictExpired();
  } catch {
    // Pre-loading is best-effort; never block the response
  }
}

/** Generate 3 natural-language follow-up suggestions based on detected topics. */
function generateFollowups(db: Database.Database, query: string, response: string): string[] {
  const topics = detectMentionedTopics(db, query, response);
  const followups: string[] = [];

  // Suggestion 1: related entity
  const entityTopics = topics.filter(t => t.type === 'entity' && t.id);
  if (entityTopics.length > 0) {
    const primary = entityTopics[0];
    const related = getRelatedEntities(db, primary.id!, 1);
    if (related.length > 0) {
      followups.push(`What about ${related[0].name}?`);
    }
  }

  // Suggestion 2: related project impact
  const projectTopics = topics.filter(t => t.type === 'project');
  if (projectTopics.length > 0) {
    // Find another active project to compare against
    const otherProjects = db.prepare(`
      SELECT DISTINCT project FROM narrative_threads
      WHERE status = 'active' AND project IS NOT NULL AND project != ?
      ORDER BY latest_source_date DESC LIMIT 1
    `).all(projectTopics[0].name) as any[];
    if (otherProjects.length > 0) {
      followups.push(`How does this affect ${otherProjects[0].project}?`);
    }
  } else if (entityTopics.length > 0) {
    // If no project detected, check the entity's project
    const entityProject = db.prepare(`
      SELECT project FROM narrative_threads
      WHERE status = 'active' AND entity_ids LIKE ? AND project IS NOT NULL
      LIMIT 1
    `).get(`%${entityTopics[0].id}%`) as any;
    if (entityProject) {
      followups.push(`How does this affect ${entityProject.project}?`);
    }
  }

  // Suggestion 3: detected gap / stalling item
  const stallingThread = db.prepare(`
    SELECT title FROM narrative_threads
    WHERE status = 'active' AND latest_source_date < datetime('now', '-7 days')
      AND project IS NOT NULL
    ORDER BY latest_source_date ASC LIMIT 1
  `).get() as any;
  if (stallingThread) {
    followups.push(`What should I do about ${stallingThread.title}?`);
  }

  // If we still have slots, fill with generic entity-based followups
  if (followups.length < 3 && entityTopics.length > 1) {
    followups.push(`What about ${entityTopics[1].name}?`);
  }

  return followups.slice(0, 3);
}

// ── Main Chat Function ────────────────────────────────

export async function chatMessage(
  db: Database.Database,
  opts: { session_id?: string; message: string; project?: string; thread_id?: string }
): Promise<ChatResponse> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  // Get or create session
  let session: ChatSession | null = null;
  let sessionId = opts.session_id;

  if (sessionId) {
    session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as ChatSession | null;
  }

  if (!session) {
    sessionId = uuid();
    const title = opts.message.slice(0, 60) + (opts.message.length > 60 ? '...' : '');
    db.prepare(`
      INSERT INTO chat_sessions (id, title, session_type, status, primary_project, primary_thread_id)
      VALUES (?, ?, 'general', 'active', ?, ?)
    `).run(sessionId, title, opts.project || null, opts.thread_id || null);
    session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as ChatSession;
  }

  // Classify intent
  const intent = classifyIntent(opts.message);

  // Build context BEFORE saving message (so history doesn't include current message)
  const { systemPrompt, history } = await buildChatContext(db, session, opts.message);

  // NOW save user message (after context is built)
  const userMsgId = uuid();
  db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, content, intent, created_at)
    VALUES (?, ?, 'user', ?, ?, datetime('now'))
  `).run(userMsgId, sessionId, opts.message, intent);

  // Assemble messages for LLM — filter out any empty assistant messages from previous failures
  const cleanHistory = history.filter(m => m.content && m.content.trim().length > 0);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...cleanHistory,
    { role: 'user', content: opts.message },
  ];

  // Call LLM with retry
  let response: string;
  try {
    response = await provider.chat(messages, { temperature: 0.3, max_tokens: 3000 });
  } catch (err: any) {
    // Retry once
    try {
      response = await provider.chat(messages, { temperature: 0.3, max_tokens: 3000 });
    } catch (err2: any) {
      response = `I encountered an error processing your request. Error: ${err2.message?.slice(0, 100)}. Please try again.`;
    }
  }

  // Ensure response is not empty
  if (!response || response.trim().length === 0) {
    response = 'I was unable to generate a response. This may be a temporary issue. Please try again.';
  }

  // Parse actions from response
  const actionIds = parseActions(response, db, sessionId!);

  // Clean response text (strip action blocks for display)
  let cleanResponse = response;
  // Keep action blocks visible in chat but mark them
  // (the UI will render them as interactive cards)

  // Store assistant response in KB for agent access
  try {
    const { insertKnowledge } = await import('../db.js');
    insertKnowledge(db, {
      id: uuid(),
      title: `Quinn response: ${response.slice(0, 80)}`,
      summary: response.slice(0, 2000),
      source: 'quinn-response',
      source_ref: `chat:${sessionId}:assistant:${Date.now()}`,
      source_date: new Date().toISOString(),
      tags: ['quinn-response'],
      importance: 'normal',
      provenance: 'derived',
      metadata: { session_id: sessionId, intent },
    });
  } catch { /* non-critical */ }

  // Save assistant message
  const assistantMsgId = uuid();
  const searchResult = await search(db, opts.message, { limit: 5, rerank: false });
  const sources = searchResult.items.map((item: any) => ({
    id: item.id, title: item.title, source: item.source, source_date: item.source_date,
  }));

  db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, content, sources, actions_generated, intent, created_at)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, datetime('now'))
  `).run(assistantMsgId, sessionId, response, JSON.stringify(sources), JSON.stringify(actionIds), intent);

  // ── Store ALL substantive user messages as knowledge ──
  // Every CEO statement is primary source material that agents need to find
  try {
    const userLower = opts.message.toLowerCase();
    const isDecision = /\b(decided|done|handled|completed|paused|stopped|cancelled|postponed|approved|rejected|signed|confirmed|changed|updated|moved|dropped)\b/.test(userLower);
    const isCorrection = /\b(wrong|incorrect|not right|actually|no that's|stop showing|already|don't|doesn't|isn't)\b/.test(userLower);
    const isSubstantive = opts.message.trim().length > 3 && !opts.message.startsWith('[');

    if (isDecision || isCorrection || isSubstantive) {
      const { insertKnowledge } = await import('../db.js');
      insertKnowledge(db, {
        id: uuid(),
        title: `User update: ${opts.message.slice(0, 120)}`,
        summary: opts.message,
        source: 'user-feedback',
        source_ref: `chat:${sessionId}:${userMsgId}`,
        source_date: new Date().toISOString(),
        tags: isCorrection ? ['user-correction', 'feedback'] : isDecision ? ['user-decision', 'feedback'] : ['ceo-input', 'feedback'],
        project: session.primary_project || undefined,
        importance: isCorrection ? 'critical' : 'high',
        provenance: 'primary',
        metadata: { session_id: sessionId, intent, type: isCorrection ? 'correction' : isDecision ? 'decision' : 'ceo-statement' },
      });

      // If it's a correction, also create a strategic lesson
      if (isCorrection) {
        db.prepare(`
          INSERT OR IGNORE INTO strategic_lessons (id, lesson_date, lesson_type, lesson, domain, severity, correction_rule)
          VALUES (?, date('now'), 'user_correction', ?, 'general', 'high', ?)
        `).run(uuid(), `User said: ${opts.message.slice(0, 200)}`, opts.message.slice(0, 500));
      }
    }
  } catch { /* non-critical — don't break chat if extraction fails */ }

  // Update session
  const msgCount = (db.prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?').get(sessionId) as any).cnt;
  db.prepare(`
    UPDATE chat_sessions SET message_count = ?, updated_at = datetime('now') WHERE id = ?
  `).run(msgCount, sessionId);

  // Auto-link threads based on detected entities/projects
  const linkedThreads = autoLinkThreads(db, sessionId!, opts.message);

  // Generate session summary every 10 messages
  if (msgCount > 0 && msgCount % 10 === 0) {
    generateSessionSummary(db, sessionId!).catch(() => {});
  }

  // Generate follow-up suggestions from detected topics
  const suggested_followups = generateFollowups(db, opts.message, response);

  // Fire-and-forget: speculatively pre-load context for predicted follow-up topics
  preloadSpeculativeContext(db, opts.message, response);

  return {
    session_id: sessionId!,
    message_id: assistantMsgId,
    content: response,
    sources,
    actions: actionIds.map(id => {
      const action = db.prepare('SELECT * FROM staged_actions WHERE id = ?').get(id) as any;
      return action ? { id: action.id, type: action.type, summary: action.summary, payload: JSON.parse(action.payload) } : null;
    }).filter(Boolean),
    intent,
    threads_linked: linkedThreads,
    suggested_followups,
  };
}

// ── Auto-link Threads ─────────────────────────────────

function autoLinkThreads(db: Database.Database, sessionId: string, message: string): string[] {
  const linked: string[] = [];
  const lower = message.toLowerCase();

  // Check active threads for title/project matches
  const threads = db.prepare(
    "SELECT id, title, project FROM narrative_threads WHERE status = 'active'"
  ).all() as any[];

  for (const t of threads) {
    const titleWords = (t.title || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    const matchCount = titleWords.filter((w: string) => lower.includes(w)).length;
    if (matchCount >= 2 || (t.project && lower.includes(t.project.toLowerCase()))) {
      const exists = db.prepare(
        'SELECT 1 FROM chat_session_threads WHERE session_id = ? AND thread_id = ?'
      ).get(sessionId, t.id);
      if (!exists) {
        db.prepare(
          'INSERT INTO chat_session_threads (id, session_id, thread_id, relevance) VALUES (?, ?, ?, ?)'
        ).run(uuid(), sessionId, t.id, matchCount >= 3 ? 1.0 : 0.7);
        linked.push(t.id);

        // Update session's primary thread if not set
        const sess = db.prepare('SELECT primary_thread_id FROM chat_sessions WHERE id = ?').get(sessionId) as any;
        if (!sess.primary_thread_id) {
          db.prepare('UPDATE chat_sessions SET primary_thread_id = ?, primary_project = ? WHERE id = ?')
            .run(t.id, t.project, sessionId);
        }
      }
    }
  }

  return linked;
}

// ── Session Summary ───────────────────────────────────

async function generateSessionSummary(db: Database.Database, sessionId: string): Promise<void> {
  const msgs = db.prepare(
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as any[];

  if (msgs.length < 5) return;

  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  const transcript = msgs.map((m: any) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');

  const summary = await provider.chat([{
    role: 'user',
    content: `Summarize this conversation in 2-3 sentences. Focus on decisions made, actions taken, and key insights:\n\n${transcript.slice(0, 4000)}`,
  }], { temperature: 0.1, max_tokens: 300 });

  db.prepare("UPDATE chat_sessions SET last_summary = ?, last_summary_at = datetime('now') WHERE id = ?")
    .run(summary, sessionId);
}

// ── Sidebar Data ──────────────────────────────────────

export function getChatSidebar(db: Database.Database): any {
  const pinned = db.prepare(
    "SELECT * FROM chat_sessions WHERE status = 'pinned' ORDER BY updated_at DESC"
  ).all();

  // Get projects with threads and their chat sessions
  const activeThreads = db.prepare(
    "SELECT * FROM narrative_threads WHERE status = 'active' ORDER BY project, latest_source_date DESC"
  ).all() as any[];

  const projectMap = new Map<string, { threads: any[]; sessions: any[] }>();
  for (const t of activeThreads) {
    const proj = t.project || 'Unassigned';
    if (!projectMap.has(proj)) projectMap.set(proj, { threads: [], sessions: [] });
    const sessions = db.prepare(`
      SELECT cs.* FROM chat_sessions cs
      JOIN chat_session_threads cst ON cs.id = cst.session_id
      WHERE cst.thread_id = ? AND cs.status = 'active'
      ORDER BY cs.updated_at DESC LIMIT 5
    `).all(t.id);
    projectMap.get(proj)!.threads.push({ ...t, sessions });
  }

  // Recent unlinked sessions
  const recent = db.prepare(`
    SELECT * FROM chat_sessions WHERE status = 'active'
    AND id NOT IN (SELECT session_id FROM chat_session_threads)
    ORDER BY updated_at DESC LIMIT 10
  `).all();

  return {
    pinned,
    projects: Array.from(projectMap.entries()).map(([name, data]) => ({
      name,
      threads: data.threads,
    })),
    recent,
  };
}
