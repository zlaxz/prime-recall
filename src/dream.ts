import type Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb, getConfig } from './db.js';
import { generateWorldModel, saveWorldModel, worldModelToMarkdown } from './ai/world.js';
import { getAlerts } from './ai/intelligence.js';
import { buildEntityGraph, computeRelationshipMomentum } from './entities.js';
import { retrieveDeepContext, retrieveGmailThread } from './source-retrieval.js';
import { notify } from './notify.js';
import { generateBriefingDoc } from './briefing-doc.js';
import { autoExecuteLowRisk } from './actions.js';
import { task15PredictionVerification, task16StrategicReflection, getCorrectionRules } from './intelligence-loop.js';
import { task17ThreadBuilder, getThreadContext } from './narrative-threads.js';
import { runIntelligenceCycle } from './intelligence-cycle.js';
import { runClaude } from './utils/claude-spawn.js';
import { getBulkProvider } from './ai/providers.js';

// ============================================================
// Dream State Pipeline — Phase 5 of v1.0 Brain Architecture
//
// dream.ts is the ORCHESTRATOR. claude -p is the reasoning engine.
// Each task: pre-query DB → assemble prompt → claude -p → validate → apply.
//
// PINNED CONTEXT RULE: When any task builds a prompt that includes
// business context, entity corrections, or current project state,
// those sections MUST appear at the TOP of the prompt and MUST be
// prefixed with a note that they are permanent/authoritative.
// Entity corrections (user labels, dismissed contacts) are ABSOLUTE
// and must never be contradicted by LLM reasoning. Business context
// from getConfig(db, 'business_context') is the ground truth.
// See buildChatContext() in src/ai/chat.ts for the reference pattern.
// ============================================================

const DREAM_DIR = join(homedir(), '.prime', 'dream');
const RESULTS_DIR = join(DREAM_DIR, 'results');
const LOGS_DIR = join(homedir(), '.prime', 'logs', 'dream');

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

function ensureDirs() {
  for (const dir of [DREAM_DIR, RESULTS_DIR, LOGS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── claude -p invocation ────────────────────────────────────

// Persistent session UUIDs — these workers accumulate context across runs
export const PERSISTENT_SESSIONS = {
  dream: '00000000-0000-4000-a000-000000000001',       // Task 09: World narrative
  reflection: '00000000-0000-4000-a000-000000000002',   // Task 16: Strategic reflection
  investigation: '00000000-0000-4000-a000-000000000003', // Task 14: Investigation
  entity: '00000000-0000-4000-a000-000000000004',       // Task 06: Entity understanding
  project: '00000000-0000-4000-a000-000000000005',      // Task 07: Project understanding
  actions: '00000000-0000-4000-a000-000000000006',      // Task 18: Action generation
  episodic: '00000000-0000-4000-a000-000000000007',     // Task 13: Episodic extraction
  commitments: '00000000-0000-4000-a000-000000000008',  // Task 08: Commitment verification
  ripple: '00000000-0000-4000-a000-000000000009',       // Ripple Engine: Cascading impact analysis
};

async function callClaudeOnce(prompt: string, timeoutMs: number = 300000, sessionId?: string): Promise<string> {
  // Try the headless proxy first (no Terminal windows, has GUI Keychain access)
  try {
    const proxyUrl = 'http://localhost:3211/claude';
    const { request: httpRequest } = await import('http');
    const proxyResult = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({
        prompt,
        timeout: Math.floor(timeoutMs / 1000),
        args: sessionId ? ['--resume', sessionId] : [],
      });
      const req = httpRequest(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs + 10000, // Give proxy extra time
      }, (res) => {
        let data = '';
        res.on('data', (d: Buffer) => { data += d.toString(); });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              // Store session ID
              if (parsed.session_id && sessionId === undefined) {
                try {
                  const db = getDb();
                  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_claude_session_id', ?, datetime('now'))")
                    .run(JSON.stringify(parsed.session_id));
                } catch (_e) {}
              }
              resolve(parsed.result || '');
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`Proxy returned ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
      req.write(body);
      req.end();
    });
    return proxyResult;
  } catch (proxyErr: any) {
    // Proxy not available — fall back to GUI wrapper or direct CLI
    if (!proxyErr.message?.includes('ECONNREFUSED')) {
      console.log(`    Proxy error (falling back): ${proxyErr.message?.slice(0, 60)}`);
    }
  }

  // GUI wrapper fallback DISABLED — spawns Terminal windows on headless Mac Mini.
  // If proxy fails, just throw. The retry logic in callClaude handles recovery.
  throw new Error('Proxy unavailable and GUI fallback disabled (headless mode)');
}


export async function callClaude(prompt: string, timeoutMs: number = 300000, sessionId?: string): Promise<string> {
  // For persistent sessions: track turns and inject summary when context gets large
  // Wrapped in try/catch so session management failures don't skip the retry logic below
  if (sessionId) {
    try {
      const turnCount = incrementSessionTurnCount(sessionId);

      if (turnCount >= SESSION_SUMMARIZE_THRESHOLD) {
        // Trigger summarization pass before the real prompt
        await summarizeSession(sessionId);
        // Now inject the summary as context prefix for the next prompt
        const summary = getSessionSummary(sessionId);
        if (summary) {
          prompt = `CONTEXT FROM PREVIOUS SESSION STATE (anchored summary — treat as authoritative):\n${summary}\n\n---\n\n${prompt}`;
        }
      } else {
        // Below threshold but a summary exists from a previous compaction — inject it
        const existingSummary = getSessionSummary(sessionId);
        if (existingSummary) {
          prompt = `CONTEXT FROM PREVIOUS SESSION STATE (anchored summary — treat as authoritative):\n${existingSummary}\n\n---\n\n${prompt}`;
        }
      }
    } catch (sessionErr: any) {
      console.log(`    Session management error (continuing without summary): ${sessionErr.message?.slice(0, 100)}`);
    }
  }

  // Strategic thinking framework REMOVED — was causing melodramatic, speculative output.
  // UPGRADE_REQUEST system note REMOVED — biased toward finding problems instead of reporting facts.

  // Self-healing query loop: multi-stage recovery cascade
  const MAX_CONTINUATION_RETRIES = 3;
  let response: string;

  // Stage 1: Normal call
  try {
    response = await callClaudeOnce(prompt, timeoutMs, sessionId);
  } catch (err1: any) {
    console.log(`    Stage 1 failed: ${err1.message?.slice(0, 80)}`);

    // Stage 2: Micro-compaction — if prompt > 10K chars, truncate middle
    let compactedPrompt = prompt;
    if (prompt.length > 10000) {
      compactedPrompt = prompt.slice(0, 2000) + '\n\n[... middle truncated for recovery ...]\n\n' + prompt.slice(-6000);
      console.log(`    Stage 2: micro-compaction (${prompt.length} -> ${compactedPrompt.length} chars)`);
    }
    try {
      await new Promise(r => setTimeout(r, 5000));
      response = await callClaudeOnce(compactedPrompt, timeoutMs, sessionId);
    } catch (err2: any) {
      console.log(`    Stage 2 failed: ${err2.message?.slice(0, 80)}`);

      // Stage 3: Model fallback — try DeepSeek instead of Claude
      try {
        console.log('    Stage 3: falling back to DeepSeek...');
        const db = getDb();
        const provider = await getBulkProvider(getConfig(db, 'openai_api_key') || undefined);
        response = await provider.chat([{ role: 'user', content: compactedPrompt }]);
      } catch (err3: any) {
        // Stage 4: Surface error — all recovery attempts exhausted
        console.log(`    Stage 3 failed: ${err3.message?.slice(0, 80)}`);
        throw new Error(`All recovery stages exhausted. Last error: ${err3.message}`);
      }
    }
  }

  // Token escalation: if response ends mid-sentence, retry with continuation prompt
  for (let contRetry = 0; contRetry < MAX_CONTINUATION_RETRIES; contRetry++) {
    const trimmed = response.trimEnd();
    // Detect mid-sentence cutoff
    // Be CONSERVATIVE — only retry if clearly cut mid-word/sentence
    // JSON responses, markdown, code blocks, and lists all end "cleanly" even without periods
    const endsClean = /[.!?}\])`'":\d\n]$/.test(trimmed)
      || trimmed.endsWith('```') || trimmed.endsWith('---') || trimmed.endsWith('*')
      || trimmed.endsWith(',') // JSON arrays/objects in progress are valid
      || /\n\s*$/.test(response); // Ends with newline = probably complete
    if (endsClean || trimmed.length < 50) break;

    console.log(`    Token escalation retry ${contRetry + 1}/${MAX_CONTINUATION_RETRIES}: response appears cut short`);
    try {
      const continuation = await callClaudeOnce(
        'Continue from where you stopped. Do not repeat.',
        timeoutMs,
        sessionId
      );
      response = response + '\n' + continuation;
    } catch {
      break; // Don't fail the whole call over a continuation attempt
    }
  }

  // Parse and save any upgrade requests from the response
  try {
    const upgradeMatch = response.match(/UPGRADE_REQUEST:\s*\[([^\]]+)\]\s*(.+)/);
    if (upgradeMatch) {
      const [, category, description] = upgradeMatch;
      const db = getDb();
      db.prepare(
        "INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, importance, tags) VALUES (?, ?, ?, 'system', ?, datetime('now'), 'high', ?)"
      ).run(
        require('uuid').v4(),
        `UPGRADE REQUEST [${category.trim()}]: ${description.trim().slice(0, 80)}`,
        `${description.trim()}`,
        `upgrade:${Date.now()}`,
        JSON.stringify(['upgrade-request', category.trim()])
      );
      console.log(`    ⚡ Self-improvement: ${category.trim()} — ${description.trim().slice(0, 60)}`);
    }
  } catch (_e) {}

  return response;
}

function tryParseJSON(text: string): any {
  // Strip markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); } catch (_e) {}

  // Progressive extraction: find the JSON by trying progressively shorter substrings
  // This handles trailing text after the JSON (from token escalation, markdown, etc.)
  const arrayStart = text.indexOf('[');
  const objStart = text.indexOf('{');
  const start = arrayStart >= 0 && (objStart < 0 || arrayStart < objStart) ? arrayStart : objStart;
  const endChar = start === arrayStart ? ']' : '}';

  if (start >= 0) {
    for (let end = text.length; end > start; end--) {
      if (text[end - 1] !== endChar) continue;
      try { return JSON.parse(text.slice(start, end)); } catch (_e) {}
    }
  }

  return null;
}

// ── Correction Propagation ───────────────────────────────────

async function propagatePendingCorrections(db: Database.Database): Promise<{ propagated: number; failed: number }> {
  let propagated = 0;
  let failed = 0;

  const pending = db.prepare(
    `SELECT id, original_claim, corrected_claim, correction_type, affected_entity_id, affected_project
     FROM brain_corrections WHERE propagation_status = 'pending'`
  ).all() as any[];

  for (const corr of pending) {
    try {
      if (corr.correction_type === 'entity_label' && corr.affected_entity_id) {
        // Extract the new label from corrected_claim (e.g. "EntityName is employee")
        const labelMatch = corr.corrected_claim.match(/is\s+(\w+)/i);
        if (labelMatch) {
          db.prepare(
            `UPDATE entities SET user_label = ?, relationship_type = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).run(labelMatch[1], labelMatch[1], corr.affected_entity_id);
        }
      } else if (corr.correction_type === 'entity_project' && corr.affected_entity_id) {
        // Update entity_mentions project association
        if (corr.affected_project) {
          db.prepare(
            `UPDATE entity_mentions SET role = 'corrected'
             WHERE entity_id = ? AND knowledge_item_id IN (
               SELECT id FROM knowledge WHERE project = ?
             )`
          ).run(corr.affected_entity_id, corr.affected_project);
        }
      } else if (corr.correction_type === 'fact') {
        // Insert correction as knowledge item with source='correction'
        const { v4: uuidv4 } = await import('uuid');
        db.prepare(
          `INSERT OR IGNORE INTO knowledge (id, title, summary, source, source_ref, source_date, project, importance, metadata)
           VALUES (?, ?, ?, 'correction', ?, datetime('now'), ?, 'high', ?)`
        ).run(
          uuidv4(),
          `Correction: ${corr.corrected_claim.slice(0, 80)}`,
          corr.corrected_claim,
          `correction:${corr.id}`,
          corr.affected_project || null,
          JSON.stringify({ original: corr.original_claim, correction_id: corr.id })
        );
      }

      db.prepare(
        `UPDATE brain_corrections SET propagation_status = 'propagated', propagated_at = datetime('now') WHERE id = ?`
      ).run(corr.id);
      propagated++;
    } catch (err: any) {
      console.error(`    ✗ Failed to propagate correction ${corr.id}: ${err.message}`);
      db.prepare(
        `UPDATE brain_corrections SET propagation_status = 'failed' WHERE id = ?`
      ).run(corr.id);
      failed++;
    }
  }

  return { propagated, failed };
}

// ── Dream Tasks ─────────────────────────────────────────────

async function task01Consolidate(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Pre-query: new items since last dream
    const lastRun = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_run'").get() as any)?.value || '2000-01-01';
    const newItems = db.prepare(`
      SELECT id, title, summary, source, source_date, contacts, organizations, project, tags, metadata
      FROM knowledge_primary WHERE source_date > ?
      ORDER BY source_date DESC LIMIT 50
    `).all(lastRun) as any[];

    if (newItems.length === 0) {
      return { task: '01-consolidate', status: 'skipped', duration_seconds: 0, output: { reason: 'no new items' } };
    }

    // Run incremental entity build (no LLM needed)
    const entityStats = buildEntityGraph(db, { incremental: true });

    // Process directives for implicit learning signals
    const { recordSignal } = await import('./entities.js');
    const directives = newItems.filter((item: any) => {
      const tags = typeof item.tags === 'string' ? JSON.parse(item.tags) : (item.tags || []);
      return tags.includes('directive') || item.source === 'directive';
    });

    let signalsRecorded = 0;
    for (const directive of directives) {
      const meta = typeof directive.metadata === 'string' ? JSON.parse(directive.metadata) : (directive.metadata || {});
      const decisions = typeof directive.decisions === 'string' ? JSON.parse(directive.decisions) : (directive.decisions || []);

      for (const decision of decisions) {
        const lower = (decision || '').toLowerCase();
        // Extract entity name from the decision text
        const contacts = typeof directive.contacts === 'string' ? JSON.parse(directive.contacts) : (directive.contacts || []);

        for (const contact of contacts) {
          if (lower.includes('dismiss') || lower.includes('ignore') || lower.includes('skip')) {
            recordSignal(db, contact, 'alert_ignored');
            signalsRecorded++;
          } else if (lower.includes('approv') || lower.includes('send') || lower.includes('call') || lower.includes('respond')) {
            recordSignal(db, contact, 'alert_acted');
            signalsRecorded++;
          }
        }
      }
    }

    return {
      task: '01-consolidate',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { items_processed: newItems.length, ...entityStats },
    };
  } catch (err: any) {
    return { task: '01-consolidate', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task02EntityClassify(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get entities needing classification
    const toClassify = db.prepare(`
      SELECT e.id, e.canonical_name, e.email, e.domain, e.relationship_type, e.relationship_confidence,
        COUNT(em.id) as mentions,
        SUM(CASE WHEN em.direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN em.direction = 'outbound' THEN 1 ELSE 0 END) as outbound
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.user_dismissed = 0 AND e.user_label IS NULL AND e.type = 'person'
        AND (e.relationship_confidence < 0.7 OR e.relationship_type IS NULL)
      GROUP BY e.id
      HAVING mentions >= 5
      ORDER BY mentions DESC LIMIT 20
    `).all() as any[];

    if (toClassify.length === 0) {
      return { task: '02-entity-classify', status: 'skipped', duration_seconds: 0, output: { reason: 'all entities classified' } };
    }

    // Get user-labeled entities as examples
    const labeled = db.prepare(`
      SELECT canonical_name, user_label FROM entities WHERE user_label IS NOT NULL
    `).all() as any[];

    const prompt = `Classify business contacts by relationship type. Return ONLY a JSON array — no explanation, no markdown, no text before or after.

Known labels (DO NOT contradict):
${labeled.map((l: any) => `${l.canonical_name} = ${l.user_label}`).join(', ')}

People to classify:
${toClassify.map((e: any) => `${e.canonical_name}${e.email ? ` <${e.email}>` : ''} | ${e.mentions} mentions | ${e.inbound} in ${e.outbound} out${e.domain ? ` | ${e.domain}` : ''}`).join('\n')}

Classification guide:
- employee: high inbound, work topics, same org domain as user
- partner: bidirectional, deal/business topics, external org
- client: user provides services, invoices sent
- vendor: provides services to user, invoices received
- advisor: occasional, strategic, user seeks advice
- broker: intermediary, connects parties
- noise: single interaction, cold outreach, no response
- unknown: insufficient data (use confidence < 0.5)

Return ONLY this JSON (no other text):
[{"name":"...","type":"...","confidence":0.8,"reasoning":"..."}]`;

    const response = await callClaude(prompt, 120000);
    const parsed = tryParseJSON(response);

    if (parsed && Array.isArray(parsed)) {
      let classified = 0;
      for (const item of parsed) {
        if (item.name && item.type && item.confidence >= 0.5) {
          db.prepare(`
            UPDATE entities SET relationship_type = ?, relationship_confidence = ?, updated_at = datetime('now')
            WHERE canonical_name = ? AND user_label IS NULL
          `).run(item.type, item.confidence, item.name);
          classified++;
        }
      }
      return { task: '02-entity-classify', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { classified, total: toClassify.length } };
    }

    return { task: '02-entity-classify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse classification response' };
  } catch (err: any) {
    return { task: '02-entity-classify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 12: Proactive Meeting Prep ──────────────────────────
// Scans calendar for meetings in the next 48h.
// For each meeting, builds a prep brief from entity history + source retrieval.

// ── Task 13: Episodic Memory Extraction ──────────────────────
// Adapted from December 2025 architecture (Obsidian/memoryplan).
// Extracts EPISODIC MOMENTS from recent items — not summaries, but
// understanding with temporal binding and business significance.
// Uses claude -p (Opus 4.6, 1M context) instead of DeepSeek.

async function task13EpisodicExtraction(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get recent items that haven't had episodic extraction yet
    const recentItems = db.prepare(`
      SELECT k.id, k.title, k.summary, k.source, k.source_date, k.project,
        k.contacts, k.commitments, k.decisions, k.action_items, k.source_ref
      FROM knowledge_primary k
      WHERE k.source_date >= datetime('now', '-7 days')
        AND k.id NOT IN (SELECT source_item_id FROM episodic_moments WHERE source_item_id IS NOT NULL)
        AND k.source NOT IN ('calendar')
      ORDER BY k.source_date DESC LIMIT 30
    `).all() as any[];

    if (recentItems.length === 0) {
      return { task: '13-episodic-extraction', status: 'skipped', duration_seconds: 0, output: { reason: 'no new items for episodic extraction' } };
    }

    // Retrieve deep content for the most important items
    const itemsWithContent: string[] = [];
    for (const item of recentItems.slice(0, 15)) {
      let content = `[${item.source}] ${item.title}\n${item.summary}`;

      // Try to get full source content for richer episodic extraction
      try {
        const stored = db.prepare('SELECT raw_content FROM knowledge WHERE id = ? AND raw_content IS NOT NULL').get(item.id) as any;
        if (stored?.raw_content) {
          content = `[${item.source}] ${item.title}\n\nFULL CONTENT:\n${stored.raw_content.slice(0, 5000)}`;
        }
      } catch (_e) {}

      const contacts = JSON.parse(item.contacts || '[]');
      const commits = JSON.parse(item.commitments || '[]');
      const decisions = JSON.parse(item.decisions || '[]');

      if (contacts.length) content += `\nPeople: ${contacts.join(', ')}`;
      if (commits.length) content += `\nCommitments: ${commits.join('; ')}`;
      if (decisions.length) content += `\nDecisions: ${decisions.join('; ')}`;
      content += `\nProject: ${item.project || 'none'}`;
      content += `\nDate: ${item.source_date?.slice(0, 10) || '?'}`;

      itemsWithContent.push(content);
    }

    const prompt = `You are extracting EPISODIC MEMORIES from business communications for Zach Stock (Recapture Insurance MGA, ADHD founder).

Extract experiences that shaped understanding, NOT technical details or generic summaries.

## Extract ONLY these types (priority order):

1. **Strategic Decisions**: What was decided + WHY + what alternatives were rejected
2. **Commitments**: Specific promises made BY or TO Zach — who owes what to whom, with deadlines
3. **Relationship Signals**: Trust gained/lost, power dynamics, enthusiasm/cooling detected
4. **Risks Identified**: Something that could go wrong + why it matters + urgency
5. **Opportunities**: Connections, deals, introductions that create business value
6. **Breakthroughs**: Insights that reshape understanding of a deal/relationship/project

## DO NOT Extract:
- Generic email summaries ("discussed the project")
- Technical details or file paths
- Routine scheduling or logistics
- Automated emails, newsletters, cold outreach

## For each moment, include TEMPORAL BINDING:
- preceded_by: What led to this moment
- enables: What becomes possible because of it
- cascade: What downstream effects it has on other projects/people

ITEMS TO ANALYZE:
${itemsWithContent.join('\n\n---\n\n')}

Return JSON array:
[{
  "source_index": 0,
  "moment_type": "strategic_decision|commitment|relationship_signal|risk_identified|opportunity|breakthrough",
  "what_happened": "specific event with names and details",
  "why_it_matters": "business significance — dollars, relationships, deadlines",
  "consequence": "how this changes the situation going forward",
  "preceded_by": "what led to this",
  "enables": "what becomes possible",
  "cascade": "downstream effects on other projects/people",
  "project": "project name or null",
  "entity_name": "primary person involved or null",
  "confidence": 0.0-1.0,
  "source_quote": "exact text from the source that supports this moment"
}]

Return ONLY significant moments. If an item has nothing episodic, skip it. Quality over quantity — 5 deep moments beats 20 shallow ones.`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    let stored = 0;
    if (parsed && Array.isArray(parsed)) {
      const { v4: uuid } = await import('uuid');

      for (const moment of parsed) {
        if (!moment.what_happened || !moment.why_it_matters) continue;

        const sourceItem = recentItems[moment.source_index || 0];
        const entityId = moment.entity_name ? (
          db.prepare("SELECT id FROM entities WHERE canonical_name = ?").get(moment.entity_name) as any
        )?.id : null;

        db.prepare(`
          INSERT INTO episodic_moments (id, source_item_id, entity_id, project, moment_type,
            what_happened, why_it_matters, consequence, preceded_by, enables, cascade,
            confidence, source_quote)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          sourceItem?.id || null,
          entityId,
          moment.project || sourceItem?.project || null,
          moment.moment_type || 'breakthrough',
          moment.what_happened,
          moment.why_it_matters,
          moment.consequence || null,
          moment.preceded_by || null,
          moment.enables || null,
          moment.cascade || null,
          moment.confidence || 0.8,
          moment.source_quote || null,
        );
        stored++;
      }
    }

    return {
      task: '13-episodic-extraction',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { items_analyzed: recentItems.length, moments_extracted: stored },
    };
  } catch (err: any) {
    return { task: '13-episodic-extraction', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 18: Strategic Action Generator ──────────────────────
// Generates PROACTIVE work items for ALL active projects.
// Unlike Task 14 (stalling investigation), this asks:
// "What WORK should Zach create/complete to move the business forward?"
// Produces deliverable-focused staged actions, not reply-focused ones.
// Uses DeepSeek Reasoner (cheap bulk work).

async function task18StrategicActions(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const profilesRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'project_profiles'"
    ).get() as any)?.value;
    if (!profilesRaw) return { task: '18-strategic-actions', status: 'skipped', duration_seconds: 0, output: { reason: 'no project profiles' } };

    const profiles = JSON.parse(profilesRaw);

    // Focus on projects that need WORK, not just stalling ones
    const activeProjects = profiles.filter((p: any) =>
      ['accelerating', 'active', 'stalling'].includes(p.status)
      && p.next_action
      && !p.next_action.toLowerCase().includes('no action needed')
    );

    if (activeProjects.length === 0) {
      return { task: '18-strategic-actions', status: 'skipped', duration_seconds: 0, output: { reason: 'no active projects needing work' } };
    }

    // Expire old staged actions (72h max)
    db.prepare("UPDATE staged_actions SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-72 hours')").run();

    // Build context with entity emails and relationship detail
    const projectContext = activeProjects.map((p: any) => {
      const items = db.prepare(
        "SELECT title, source, source_date FROM knowledge WHERE project = ? AND importance != 'noise' ORDER BY source_date DESC LIMIT 5"
      ).all(p.project) as any[];

      const commitments = db.prepare(
        "SELECT text, state, due_date, owner FROM commitments WHERE project = ? AND state IN ('active', 'overdue') ORDER BY due_date ASC LIMIT 3"
      ).all(p.project) as any[];

      // Get key people with EMAIL ADDRESSES for this project
      const people = db.prepare(`
        SELECT e.canonical_name, e.email, e.relationship_type, e.user_label
        FROM entities e
        JOIN entity_mentions em ON e.id = em.entity_id
        JOIN knowledge_primary k ON em.knowledge_item_id = k.id
        WHERE k.project = ? AND e.type = 'person' AND e.user_dismissed = 0
          AND e.canonical_name NOT LIKE '%Zach%Stock%'
        GROUP BY e.id
        ORDER BY COUNT(em.id) DESC LIMIT 5
      `).all(p.project) as any[];

      // Get active threads for this project
      const threads = db.prepare(
        "SELECT title, current_state, next_action FROM narrative_threads WHERE status = 'active' AND (title LIKE ? OR project = ?) LIMIT 2"
      ).all(`%${p.project}%`, p.project) as any[];

      return `## ${p.project} [${p.status}]
Status: ${p.status_reasoning?.slice(0, 300)}
Next action: ${p.next_action}
Key people: ${people.map((pe: any) => `${pe.canonical_name}${pe.email ? ' <' + pe.email + '>' : ''}${pe.user_label ? ' (' + pe.user_label + ')' : ''}`).join('; ') || 'unknown'}
Active threads: ${threads.map((t: any) => `"${t.title}" — ${t.current_state?.slice(0, 150)}`).join('; ') || 'none'}
Recent activity: ${items.map((i: any) => `${i.source_date?.slice(0, 10)} ${i.source}: ${i.title}`).join('; ')}
Open commitments: ${commitments.map((c: any) => `${c.text} [${c.state}]${c.due_date ? ' due:' + c.due_date : ''}`).join('; ') || 'none'}`;
    }).join('\n\n');

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Load voice profile for authentic drafts
    let voiceReference = '';
    try {
      const voicePath = join(homedir(), 'GitHub', 'prime', 'prompts', 'voice-profile.md');
      if (existsSync(voicePath)) {
        voiceReference = '\n\n' + readFileSync(voicePath, 'utf-8');
      }
    } catch (_e) {}

    // SOURCE RETRIEVAL: Get actual content for top projects so DeepSeek has real material
    let deepSourceMaterial = '';
    try {
      for (const p of activeProjects.slice(0, 3)) {
        const projItems = db.prepare(
          "SELECT title, source, source_ref, source_date, metadata FROM knowledge_primary WHERE project = ? ORDER BY source_date DESC LIMIT 5"
        ).all(p.project) as any[];
        const deepContent = await retrieveDeepContext(db, projItems.slice(0, 5), 3);
        if (deepContent) {
          deepSourceMaterial += `\n\n=== FULL SOURCE MATERIAL: ${p.project} ===${deepContent}`;
        }
      }
    } catch (err: any) {
      console.log(`    Task 18 source retrieval warning: ${err.message?.slice(0, 100)}`);
    }

    // Load standing decisions as constraints
    let standingDecisions = '';
    try {
      const decisions = db.prepare(
        "SELECT decision, category, entity_name, project FROM decisions WHERE active = 1 ORDER BY created_at DESC LIMIT 15"
      ).all() as any[];
      if (decisions.length > 0) {
        standingDecisions = '\n\nSTANDING DECISIONS (from user — treat as absolute constraints):\n' +
          decisions.map((d: any) => {
            const tag = d.entity_name ? `[${d.entity_name}]` : d.project ? `[${d.project}]` : d.category ? `[${d.category}]` : '';
            return `- ${tag} ${d.decision}`;
          }).join('\n');
      }
    } catch (_e) {}

    // Use Claude for drafts — DeepSeek produces generic corporate-speak
    const actionPrompt = `You are drafting REAL business communications for Zach Stock, founder of Recapture Insurance (an MGA specializing in senior living/healthcare insurance). Today is ${today}.${standingDecisions}

ZACH'S WRITING STYLE:
- Direct, confident, not corporate. Never "I hope this finds you well."
- Short sentences. Gets to the point fast.
- References specific prior conversations: "Following up on our March 24 call..."
- Uses first names, not "Dear Mr./Ms."
- Signs off with just "Zach" or "- Zach"
- When he knows someone well: casual, warm. When cold outreach: professional but not stiff.

YOUR JOB: Generate 3-5 work items. For EACH email, write a COMPLETE draft that Zach would actually send with minimal editing.

RULES:
1. Every email MUST have: real recipient name, email address (from the Key People data), specific subject line, FULL body text (not an outline).
2. Reference SPECIFIC details from the source material — dates, numbers, prior conversations, agreements.
3. If you don't have enough detail to write a real email, say so — don't fake it with placeholders.
4. Prioritize REVENUE-GENERATING and DEADLINE-DRIVEN items.
5. Maximum 2 items per project. Highest-leverage only.
6. For documents: write the ACTUAL content, not bullet point outlines.

Return JSON:
{
  "actions": [
    {
      "type": "email|document|calendar|task",
      "summary": "One line description",
      "project": "Project Name",
      "reasoning": "Why this matters NOW — cite specific evidence from source material",
      "to": "email@address",
      "subject": "Email subject",
      "body": "COMPLETE draft — ready to send",
      "urgency": "critical|high|medium"
    }
  ]
}`;

    const response = await runClaude(actionPrompt + voiceReference + '\n\n' + (() => {
      let gapBlock = '';
      try {
        const gapsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'detected_gaps'").get() as any)?.value;
        if (gapsRaw) {
          const gapsList = JSON.parse(gapsRaw) as any[];
          const criticalHigh = gapsList.filter((g: any) => g.severity === 'critical' || g.severity === 'high');
          if (criticalHigh.length > 0) {
            gapBlock = '\n\n## DETECTED GAPS\n' + criticalHigh.slice(0, 8).map((g: any) =>
              `- [${g.severity.toUpperCase()}] ${g.type}: ${g.description}`
            ).join('\n');
          }
        }
      } catch (_e) {}
      return projectContext + (deepSourceMaterial ? '\n\nSOURCE MATERIAL:\n' + deepSourceMaterial : '') + gapBlock;
    })(), { timeout: 300000 });

    // Legacy DeepSeek path removed — Claude produces dramatically better drafts
    const _unused_provider = null; // kept to avoid import warnings
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? tryParseJSON(jsonMatch[0]) : null;
    if (!result?.actions?.length) {
      return { task: '18-strategic-actions', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { actions: 0, reason: 'no actions generated' } };
    }

    // Store as staged actions
    let created = 0;
    for (const action of result.actions.slice(0, 5)) {
      // Quality check: skip if no clear deliverable
      if (!action.summary || action.summary.length < 10) continue;

      db.prepare(`
        INSERT INTO staged_actions (type, summary, reasoning, project, payload, source_task, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'task-18-strategic', 'pending', datetime('now'), datetime('now', '+72 hours'))
      `).run(
        action.type || 'task',
        action.summary,
        action.reasoning || '',
        action.project || '',
        JSON.stringify({
          type: action.type,
          to: action.to || null,
          subject: action.subject || null,
          body: action.body || null,
        })
      );
      created++;
    }

    console.log(`    Generated ${created} strategic actions for ${activeProjects.length} projects`);

    return {
      task: '18-strategic-actions',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { actions: created, projects: activeProjects.length },
    };
  } catch (err: any) {
    return { task: '18-strategic-actions', status: 'failed', duration_seconds: (Date.now() - start) / 1000, output: { error: err.message?.slice(0, 200) } };
  }
}

// ── Task 14: Strategic Investigation ──────────────────────────
// Designed by 5-agent debate: Architect, Simplicity, ADHD UX, Red Team, Explorer
// Detects stalling projects and does DEEP investigation with full context.
// Produces diagnosis + leverage point + drafted action.

async function task14Investigation(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const profilesRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'project_profiles'"
    ).get() as any)?.value;
    if (!profilesRaw) return { task: '14-investigation', status: 'skipped', duration_seconds: 0, output: { reason: 'no project profiles yet' } };

    const profiles = JSON.parse(profilesRaw);
    const stalling = profiles.filter((p: any) => ['stalling', 'stalled'].includes(p.status));
    if (stalling.length === 0) return { task: '14-investigation', status: 'skipped', duration_seconds: 0, output: { reason: 'no stalling projects' } };

    // Investigate the top stalling project
    const project = stalling[0];
    console.log(`    Investigating: ${project.project} [${project.status}]`);

    // Pre-query ALL context (Red Team: workers can't access DB, CEO must pre-query)
    const items = db.prepare(
      'SELECT title, summary, source, source_date, contacts, commitments, decisions FROM knowledge_primary WHERE project = ? ORDER BY source_date DESC LIMIT 20'
    ).all(project.project) as any[];

    const entities = db.prepare(`
      SELECT DISTINCT e.canonical_name, e.user_label, e.relationship_type
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      JOIN knowledge_primary k ON em.knowledge_item_id = k.id
      WHERE k.project = ? AND e.user_dismissed = 0 AND e.canonical_name NOT LIKE '%Zach%Stock%'
    `).all(project.project) as any[];

    const commitments = db.prepare(
      "SELECT text, state, due_date, owner FROM commitments WHERE project = ? AND state IN ('active', 'overdue') ORDER BY due_date"
    ).all(project.project) as any[];

    const episodic = db.prepare(
      'SELECT moment_type, what_happened, why_it_matters, consequence, enables FROM episodic_moments WHERE project = ? ORDER BY confidence DESC LIMIT 5'
    ).all(project.project) as any[];

    // Source retrieval — COMPLETE NARRATIVE from ALL sources, ordered chronologically
    // Email threads + meeting transcripts + Claude conversations + Cowork sessions
    // The investigation must see the FULL STORY as it unfolded across every surface
    let deepContent = '';
    try {
      const allSourceItems = db.prepare(
        "SELECT title, source, source_ref, source_date, summary, raw_content FROM knowledge_primary WHERE project = ? ORDER BY source_date DESC LIMIT 15"
      ).all(project.project) as any[];

      const narrativeParts: string[] = [];

      for (const item of allSourceItems.slice(0, 8)) {
        // Try to get full content from each source type
        if (item.raw_content) {
          // Cached content available
          narrativeParts.push(`\n=== [${item.source.toUpperCase()}] ${item.source_date?.slice(0,10)} — ${item.title} ===\n${item.raw_content.slice(0, 5000)}`);
        } else if (item.source === 'gmail' || item.source === 'gmail-sent') {
          const threadId = item.source_ref?.replace('thread:', '');
          if (threadId) {
            try {
              const threadContent = await retrieveGmailThread(db, threadId);
              if (threadContent) narrativeParts.push(`\n=== [EMAIL THREAD] ${item.source_date?.slice(0,10)} — ${item.title} ===\n${threadContent}`);

              // Also retrieve ATTACHMENTS (Word docs, PDFs, etc.) — the actual documents matter
              try {
                const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});
                // Find message IDs in this thread that might have attachments
                const { retrieveGmailAttachments } = await import('./source-retrieval.js');
                // Use the thread's first message ID from source_ref or metadata
                const msgId = meta.message_id || threadId;
                const attachments = await retrieveGmailAttachments(db, msgId);
                for (const att of attachments) {
                  narrativeParts.push(`\n=== [ATTACHED DOCUMENT] ${att.filename} ===\n${att.content}`);
                }
              } catch (_e) {}
            } catch (_e) {}
          }
        } else if (item.source === 'fireflies') {
          const meetingId = item.source_ref?.replace('fireflies:', '');
          if (meetingId) {
            try {
              const { retrieveFirefliesTranscript } = await import('./source-retrieval.js');
              const transcript = await retrieveFirefliesTranscript(db, meetingId);
              if (transcript) narrativeParts.push(`\n=== [MEETING TRANSCRIPT] ${item.source_date?.slice(0,10)} — ${item.title} ===\n${transcript}`);
            } catch (_e) {}
          }
        } else {
          // Claude conversations, Cowork sessions, Otter transcripts, manual entries
          // Include the summary + any available detail
          narrativeParts.push(`\n=== [${item.source.toUpperCase()}] ${item.source_date?.slice(0,10)} — ${item.title} ===\n${item.summary}`);
        }
      }

      deepContent = narrativeParts.join('\n');
    } catch (_e) {}

    const itemContext = items.map((i: any) => {
      const c = JSON.parse(i.contacts || '[]');
      const cm = JSON.parse(i.commitments || '[]');
      return `${i.source_date?.slice(0,10)} | ${i.source} | ${i.title}\n  ${(i.summary || '').slice(0, 200)}${c.length ? '\n  People: ' + c.join(', ') : ''}${cm.length ? '\n  Commitments: ' + cm.slice(0,2).join('; ') : ''}`;
    }).join('\n');

    const entityContext = entities.map((e: any) => `${e.canonical_name} [${e.user_label || e.relationship_type || '?'}]`).join(', ');
    const commitContext = commitments.map((c: any) => `- ${c.text} [${c.state}]${c.due_date ? ' due: ' + c.due_date : ''} (${c.owner || '?'})`).join('\n');
    const episodicContext = episodic.map((m: any) => `[${m.moment_type}] ${m.what_happened}\n  WHY: ${m.why_it_matters}${m.enables ? '\n  ENABLES: ' + m.enables : ''}`).join('\n\n');

    // Load standing decisions relevant to this project
    let investigationDecisions = '';
    try {
      const decisions = db.prepare(
        "SELECT decision, category, entity_name, project FROM decisions WHERE active = 1 AND (project = ? OR project IS NULL) ORDER BY created_at DESC LIMIT 15"
      ).all(project.project) as any[];
      if (decisions.length > 0) {
        investigationDecisions = '\n\nSTANDING DECISIONS (from user — treat as absolute constraints, do not contradict):\n' +
          decisions.map((d: any) => {
            const tag = d.entity_name ? `[${d.entity_name}]` : d.project ? `[${d.project}]` : d.category ? `[${d.category}]` : '';
            return `- ${tag} ${d.decision}`;
          }).join('\n') + '\n';
      }
    } catch (_e) {}

    const prompt = `You are Prime, AI Chief of Staff for Zach Stock (Recapture Insurance MGA, ADHD founder).
${investigationDecisions}
You are conducting a DEEP STRATEGIC INVESTIGATION into why "${project.project}" is stalling.

PROJECT ANALYSIS (from earlier tonight):
Status: ${project.status}
Reasoning: ${project.status_reasoning}
Risks: ${JSON.stringify(project.risks)}
Next action identified: ${project.next_action}
Critical person: ${project.critical_person}

ALL PROJECT COMMUNICATIONS (last 20 items):
${itemContext}

${deepContent ? 'COMPLETE PROJECT NARRATIVE (emails, meetings, Claude conversations, Cowork sessions — read as ONE STORY unfolding over time):\n' + deepContent : ''}

TODAY IS: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.

${getCorrectionRules(db, 'project') || getCorrectionRules(db, 'deal') || getCorrectionRules(db) || ''}
${getThreadContext(db, project.project) || ''}
CRITICAL RULES FOR REASONING:
1. READ THE FULL NARRATIVE ABOVE before making claims. If Zach sent a reply, he responded. If the other person gave counter-points, that's NEGOTIATION not rejection.
2. Trace the conversation across ALL sources — an email thread may be followed by a Claude session where the response was drafted, then a meeting where it was discussed.
3. Check the DATES — the most recent communication determines where things actually stand.
4. Do NOT assume silence from stale extracted summaries. The narrative above is the truth.
5. TEMPORAL AWARENESS: Know what day and time it is. Do NOT suggest sending business emails on Saturday night or Sunday. Monday morning is appropriate. Consider the other person's stated schedule (meetings, travel, holidays).
6. SOCIAL RHYTHM: If someone said "let's talk end of week" and it's now the weekend, that's NORMAL — not a crisis. A few days of silence after a mutual agreement to talk is expected business rhythm, not a dropped ball.
7. CALENDAR CROSS-REFERENCE: Before claiming a scheduled conversation didn't happen, check if there's a calendar event for it. Someone saying "let's discuss end of week" may have sent a calendar invite Zach accepted.
8. RELATIONSHIP TEMPO: Every relationship has a natural cadence. A partner who responds within hours to emails has a different expectation than one who responds weekly. Don't apply one-size-fits-all urgency.

KEY PEOPLE: ${entityContext || '(none identified)'}

OPEN COMMITMENTS:
${commitContext || '(none)'}

EPISODIC UNDERSTANDING:
${episodicContext || '(none)'}

INVESTIGATE DEEPLY:
1. WHY is this project stalling? Challenge the obvious answer. What's the REAL blocker?
2. What is being AVOIDED? (ADHD avoidance pattern: the task that keeps getting deferred is usually the most important one)
3. What is the SINGLE highest-leverage action that would unstall this? Not 5 things — ONE thing.
4. Draft the SPECIFIC email, call agenda, or document that executes this action. Real names, real context.
5. What would change your assessment? What evidence would you need?
6. Is there a connection to ANOTHER project that's being missed?

Return JSON:
{
  "diagnosis": "why it's REALLY stalling — be specific, cite evidence from the communications",
  "avoidance_pattern": "what Zach is likely avoiding and why (null if not applicable)",
  "leverage_point": "the ONE thing that would change everything",
  "cross_project_connection": "connection to another project that creates leverage (null if none)",
  "prepared_action": {"type": "email|calendar|document", "to": "recipient", "subject": "...", "body": "full draft text"},
  "uncertainty": "what you're not sure about",
  "confidence": 0.0-1.0
}`;

    // Phase 1: Single deep investigation call
    const response = await callClaude(prompt, 180000);
    const initialAnalysis = tryParseJSON(response);

    // Phase 2: Bull/Bear Debate — spawn 3 parallel claude -p workers
    // Only runs if initial analysis was successful (we need context for the debate)
    let debateResult: any = null;
    if (initialAnalysis && entities.length >= 2) {
      console.log('    Spawning bull/bear debate (3 parallel workers)...');
      try {
        const sharedContext = `PROJECT: ${project.project}\nDIAGNOSIS: ${initialAnalysis.diagnosis}\nLEVERAGE: ${initialAnalysis.leverage_point}\nCROSS-PROJECT: ${initialAnalysis.cross_project_connection || 'none'}\n\nKEY PEOPLE: ${entityContext}\nCOMMITMENTS:\n${commitContext}\n\n${deepContent ? 'SOURCE MATERIAL:\n' + deepContent.slice(0, 8000) : ''}`;

        const [bullResponse, bearResponse] = await Promise.all([
          // BULL: Argue FOR aggressive action
          callClaudeOnce(`You are the BULL ADVOCATE in a strategic debate about "${project.project}".

${sharedContext}

INITIAL ANALYSIS says the project is stalling because: ${initialAnalysis.diagnosis}

YOUR JOB: Argue why this project should be PURSUED AGGRESSIVELY. What opportunity is being missed? What happens if Zach acts boldly NOW? Find the upside everyone is underweighting.

Be specific. Cite evidence from the communications. Return JSON:
{"argument": "your case for aggressive action", "opportunity_size": "what's at stake in dollars/relationships", "bold_move": "the specific aggressive action to take", "confidence": 0.0-1.0}`, 60000),

          // BEAR: Argue FOR walking away or pausing
          callClaudeOnce(`You are the BEAR ADVOCATE (Risk Analyst) in a strategic debate about "${project.project}".

${sharedContext}

INITIAL ANALYSIS says the project is stalling because: ${initialAnalysis.diagnosis}

YOUR JOB: Argue why Zach should PAUSE, WALK AWAY, or DEPRIORITIZE this project. What risks are being ignored? What is this project costing in attention and opportunity cost? Where would Zach's time be better spent?

Be specific. Cite evidence. Return JSON:
{"argument": "your case for pausing/walking away", "hidden_risks": "risks not yet surfaced", "opportunity_cost": "what Zach is NOT doing because of this project", "walk_away_plan": "specific steps to cleanly disengage", "confidence": 0.0-1.0}`, 60000),
        ]);

        const bull = tryParseJSON(bullResponse);
        const bear = tryParseJSON(bearResponse);

        if (bull && bear) {
          // CEO SYNTHESIS: Takes both arguments and makes the call
          const ceoPrompt = `You are Prime, the CEO synthesizer. You've heard the bull and bear cases for "${project.project}".

BULL CASE (pursue aggressively):
${JSON.stringify(bull, null, 2)}

BEAR CASE (pause/walk away):
${JSON.stringify(bear, null, 2)}

INITIAL INVESTIGATION:
Diagnosis: ${initialAnalysis.diagnosis}
Avoidance pattern: ${initialAnalysis.avoidance_pattern}
Leverage point: ${initialAnalysis.leverage_point}
Cross-project: ${initialAnalysis.cross_project_connection}

DECIDE: Given both perspectives and the full context, what should Zach do?
If Bull and Bear agree on something, it's high confidence. Where they disagree, explain the uncertainty.

Return JSON:
{
  "verdict": "pursue|pause|pivot|walk_away",
  "reasoning": "why this verdict, citing both bull and bear arguments",
  "convergence": "what both sides agree on (high confidence)",
  "divergence": "where they disagree (flag as uncertain)",
  "final_action": {"type": "email|calendar|document", "to": "...", "subject": "...", "body": "full draft"},
  "confidence": 0.0-1.0
}`;

          const ceoResponse = await callClaude(ceoPrompt, 120000);
          debateResult = tryParseJSON(ceoResponse);
        }
      } catch (err: any) {
        console.log(`    Debate warning: ${err.message?.slice(0, 80)}`);
      }
    }

    // Use debate result if available, otherwise fall back to initial analysis
    const finalResult = debateResult || initialAnalysis;
    const parsed = finalResult;

    let actionsCreated = 0;
    if (parsed) {
      // Store both the investigation and debate results
      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).run(`investigation_${project.project}`, JSON.stringify({
        ...initialAnalysis,
        debate: debateResult ? { verdict: debateResult.verdict, convergence: debateResult.convergence, divergence: debateResult.divergence } : null,
      }));

      // Create staged action from the best available output
      const action = debateResult?.final_action || initialAnalysis?.prepared_action;
      const confidence = debateResult?.confidence || initialAnalysis?.confidence || 0;

      if (action && confidence > 0.7) {
        db.prepare(
          "INSERT INTO staged_actions (type, summary, payload, reasoning, project, source_task, expires_at) VALUES (?, ?, ?, ?, ?, 'investigation', datetime('now', '+72 hours'))"
        ).run(
          action.type || 'email',
          action.subject || action.title || 'Investigation action',
          JSON.stringify(action),
          (debateResult?.reasoning || initialAnalysis?.diagnosis || '').slice(0, 300),
          project.project,
        );
        actionsCreated++;
      }
    }

    return {
      task: '14-investigation',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        project: project.project,
        diagnosis: parsed?.diagnosis?.slice(0, 100),
        leverage: parsed?.leverage_point?.slice(0, 100),
        confidence: parsed?.confidence,
        actions_created: actionsCreated,
      },
    };
  } catch (err: any) {
    return { task: '14-investigation', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task12MeetingPrep(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600000);

    // Find upcoming meetings from calendar items
    const meetings = db.prepare(`
      SELECT k.title, k.summary, k.contacts, k.source_date, k.source_ref, k.metadata
      FROM knowledge_primary k
      WHERE k.source = 'calendar'
        AND k.source_date >= ? AND k.source_date <= ?
      ORDER BY k.source_date ASC
    `).all(now.toISOString(), in48h.toISOString()) as any[];

    if (meetings.length === 0) {
      return { task: '12-meeting-prep', status: 'skipped', duration_seconds: 0, output: { reason: 'no meetings in next 48h' } };
    }

    const preps: any[] = [];

    for (const meeting of meetings.slice(0, 3)) { // max 3 meetings
      const contacts = JSON.parse(meeting.contacts || '[]')
        .filter((c: string) => !c.toLowerCase().includes('zach stock'));

      if (contacts.length === 0) continue;

      // For each attendee, pull their full entity context
      const attendeeContexts = contacts.slice(0, 3).map((name: string) => {
        const entity = db.prepare(`
          SELECT e.id, e.canonical_name, e.user_label, e.relationship_type, e.email, e.domain
          FROM entities e
          LEFT JOIN entity_aliases ea ON e.id = ea.entity_id
          WHERE e.canonical_name = ? OR ea.alias_normalized = ?
          LIMIT 1
        `).get(name, name.toLowerCase().replace(/[^a-z\s-]/g, '').trim()) as any;

        if (!entity) return `${name}: no entity profile`;

        const recentItems = db.prepare(`
          SELECT k.title, k.source, k.source_date, k.summary
          FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ?
          ORDER BY k.source_date DESC LIMIT 5
        `).all(entity.id) as any[];

        const commits = db.prepare(`
          SELECT text, state, due_date FROM commitments
          WHERE (owner LIKE ? OR assigned_to LIKE ?) AND state IN ('active', 'overdue')
        `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

        return `${entity.canonical_name} [${entity.user_label || entity.relationship_type || '?'}] @ ${entity.domain || '?'}
  Recent: ${recentItems.map((i: any) => i.source_date?.slice(0, 10) + ' ' + i.title?.slice(0, 50)).join(' | ')}
  Open commitments: ${commits.map((c: any) => c.text?.slice(0, 60)).join('; ') || 'none'}`;
      }).join('\n\n');

      // SOURCE RETRIEVAL: Get actual content for attendee interactions
      let attendeeDeepContent = '';
      try {
        const allAttendeeItems: any[] = [];
        for (const name of contacts.slice(0, 3)) {
          const entity = db.prepare(
            "SELECT e.id FROM entities e LEFT JOIN entity_aliases ea ON e.id = ea.entity_id WHERE e.canonical_name = ? OR ea.alias_normalized = ? LIMIT 1"
          ).get(name, name.toLowerCase().replace(/[^a-z\s-]/g, '').trim()) as any;
          if (entity) {
            const items = db.prepare(
              "SELECT k.title, k.source, k.source_ref, k.source_date, k.metadata FROM knowledge_primary k JOIN entity_mentions em ON k.id = em.knowledge_item_id WHERE em.entity_id = ? ORDER BY k.source_date DESC LIMIT 3"
            ).all(entity.id) as any[];
            allAttendeeItems.push(...items);
          }
        }
        if (allAttendeeItems.length > 0) {
          attendeeDeepContent = await retrieveDeepContext(db, allAttendeeItems.slice(0, 3), 2);
        }
      } catch (err: any) {
        console.log(`    Task 12 source retrieval warning: ${err.message?.slice(0, 100)}`);
      }

      const meetingTime = new Date(meeting.source_date);
      const hoursUntil = Math.round((meetingTime.getTime() - now.getTime()) / 3600000);

      const prepPrompt = `Generate a meeting prep brief for Zach Stock (Recapture Insurance MGA).

MEETING: ${meeting.title}
WHEN: ${meetingTime.toLocaleString()} (${hoursUntil} hours from now)
ATTENDEES:
${attendeeContexts}
${attendeeDeepContent ? '\nSOURCE MATERIAL:\n' + attendeeDeepContent : ''}

Based on the attendee history and relationship context:
1. What is the likely PURPOSE of this meeting?
2. What happened in the LAST interaction with each attendee?
3. What COMMITMENTS are open between Zach and these people?
4. What should Zach PREPARE or BRING to this meeting?
5. What OUTCOME should Zach aim for?
6. Any RISKS or sensitivities to be aware of?

Be specific and actionable. This is a 60-second read before the meeting.
Return plain text, not JSON.`;

      try {
        const brief = await callClaude(prepPrompt, 60000);
        if (brief && brief.length > 50) {
          preps.push({
            meeting: meeting.title,
            time: meeting.source_date,
            attendees: contacts,
            brief,
          });
        }
      } catch (_e) {}
    }

    if (preps.length > 0) {
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('meeting_preps', ?, datetime('now'))
      `).run(JSON.stringify(preps));
    }

    return {
      task: '12-meeting-prep',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { meetings_found: meetings.length, preps_generated: preps.length },
    };
  } catch (err: any) {
    return { task: '12-meeting-prep', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task03CommitmentCheck(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const active = db.prepare(`
      SELECT id, text, owner, assigned_to, due_date, state, project FROM commitments
      WHERE state IN ('active', 'detected') ORDER BY due_date ASC
    `).all() as any[];

    const now = new Date().toISOString();
    let newOverdue = 0;

    for (const c of active) {
      if (c.due_date && c.due_date < now && c.state !== 'overdue') {
        db.prepare("UPDATE commitments SET state = 'overdue', state_changed_at = datetime('now') WHERE id = ?").run(c.id);
        newOverdue++;
      }
    }

    return { task: '03-commitment-check', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { checked: active.length, new_overdue: newOverdue } };
  } catch (err: any) {
    return { task: '03-commitment-check', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task04WorldRebuild(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const model = generateWorldModel(db);
    saveWorldModel(model);
    return {
      task: '04-world-rebuild',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { people: model.people.length, projects: model.projects.length, alerts: model.alerts.length },
    };
  } catch (err: any) {
    return { task: '04-world-rebuild', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

async function task05SelfAudit(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get yesterday's agent reports
    const reports = db.prepare(`
      SELECT title, summary, metadata FROM knowledge_derived
      WHERE source = 'agent-report' AND source_date >= datetime('now', '-1 day')
      ORDER BY source_date DESC LIMIT 3
    `).all() as any[];

    if (reports.length === 0) {
      return { task: '05-self-audit', status: 'skipped', duration_seconds: 0, output: { reason: 'no recent reports to audit' } };
    }

    // Get current alerts for ground truth
    const alerts = getAlerts(db);

    const reportText = reports.map((r: any) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return `REPORT: ${r.title}\n${meta.full_report || r.summary}`;
    }).join('\n\n---\n\n');

    const prompt = `Audit these agent reports for accuracy. Compare claims against the ground truth alerts below.

AGENT REPORTS:
${reportText.slice(0, 4000)}

GROUND TRUTH ALERTS (${alerts.length} total):
${alerts.slice(0, 30).map(a => `[${a.severity}] ${a.title}: ${a.detail}`).join('\n')}

Return JSON:
{
  "reports_audited": N,
  "total_claims": N,
  "accurate_claims": N,
  "hallucinated_claims": N,
  "overall_accuracy": 0.0-1.0,
  "issues": [{"claim": "...", "problem": "...", "severity": "high|medium|low"}],
  "recommendations": ["..."]
}`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    if (parsed && parsed.overall_accuracy !== undefined) {
      // Save accuracy score for tracking over time
      const dateStr = new Date().toISOString().slice(0, 10);
      const existingScores = (db.prepare("SELECT value FROM graph_state WHERE key = 'accuracy_history'").get() as any)?.value || '[]';
      const scores = JSON.parse(existingScores);
      scores.push({ date: dateStr, accuracy: parsed.overall_accuracy, hallucination_rate: parsed.hallucinated_claims || 0, issues: parsed.issues?.length || 0 });
      // Keep last 90 days
      const recent = scores.filter((s: any) => new Date(s.date) > new Date(Date.now() - 90 * 86400000));
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('accuracy_history', ?, datetime('now'))").run(JSON.stringify(recent));

      return { task: '05-self-audit', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: parsed };
    }

    return { task: '05-self-audit', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { raw: response.slice(0, 500) } };
  } catch (err: any) {
    return { task: '05-self-audit', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 06: Entity Understanding — THE intelligence layer ──
// Sends full context to claude -p. No regex. No heuristics.
// The LLM reads every email and makes a judgment call.

async function task06EntityUnderstanding(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Evaluate ALL active entities — not just those with open threads.
    // Important relationships need monitoring even when no email is pending.
    // This REPLACES task 02 (shallow classification) with deep understanding.
    const candidates = db.prepare(`
      SELECT e.id, e.canonical_name, e.email, e.domain,
        e.user_label, e.relationship_type,
        COUNT(em.id) as mention_count,
        MAX(em.mention_date) as last_seen
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.user_dismissed = 0
        AND e.type = 'person'
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND (e.user_label IS NULL OR e.user_label NOT IN ('employee', 'noise'))
      GROUP BY e.id
      HAVING mention_count >= 3
      ORDER BY mention_count DESC
      LIMIT 60
    `).all() as any[];

    // Filter out entities that already have a fresh, user-confirmed profile
    const needsEval = candidates.filter((c: any) => {
      const profile = db.prepare(
        'SELECT user_override, last_verified_at FROM entity_profiles WHERE entity_id = ?'
      ).get(c.id) as any;
      if (profile?.user_override) return false;
      // Re-evaluate if no profile or older than 7 days
      if (!profile?.last_verified_at) return true;
      const age = Date.now() - new Date(profile.last_verified_at).getTime();
      return age > 7 * 86400000;
    });

    if (needsEval.length === 0) {
      return { task: '06-entity-understanding', status: 'skipped', duration_seconds: 0, output: { reason: 'all entities profiled' } };
    }

    console.log(`    Evaluating ${needsEval.length} entities with LLM...`);

    // Process in batches of 5 entities per LLM call
    const BATCH_SIZE = 5;
    let evaluated = 0;
    let surfaced = 0;
    let suppressed = 0;

    for (let i = 0; i < needsEval.length; i += BATCH_SIZE) {
      const batch = needsEval.slice(i, i + BATCH_SIZE);

      // Build DEEP context for each entity — not just titles, but the full intelligence
      const entityContexts = batch.map((entity: any) => {
        // Get ALL items with FULL extracted intelligence
        const items = db.prepare(`
          SELECT k.title, k.summary, k.source, k.source_date, k.tags, k.project,
                 k.contacts, k.commitments, k.decisions, k.action_items, k.importance,
                 em.direction, em.role,
                 json_extract(k.metadata, '$.last_from') as last_from
          FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ?
          ORDER BY k.source_date DESC
        `).all(entity.id) as any[];

        // Open threads
        const openThreads = items.filter((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          return tags.includes('awaiting_reply');
        });

        // Communication stats
        const stats = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
            MIN(mention_date) as first_seen,
            MAX(mention_date) as last_seen
          FROM entity_mentions WHERE entity_id = ?
        `).get(entity.id) as any;

        // CROSS-ENTITY: who do they co-occur with? (relationship web)
        const connections = db.prepare(`
          SELECT e2.canonical_name, e2.user_label, e2.relationship_type,
            ee.co_occurrence_count, ee.edge_type
          FROM entity_edges ee
          JOIN entities e2 ON (CASE WHEN ee.source_entity_id = ? THEN ee.target_entity_id ELSE ee.source_entity_id END = e2.id)
          WHERE (ee.source_entity_id = ? OR ee.target_entity_id = ?)
            AND ee.invalid_at IS NULL
            AND e2.user_dismissed = 0 AND e2.canonical_name NOT LIKE '%Zach%Stock%'
          ORDER BY ee.co_occurrence_count DESC LIMIT 5
        `).all(entity.id, entity.id, entity.id) as any[];

        // Open commitments involving this person
        const commitments = db.prepare(`
          SELECT text, state, due_date FROM commitments
          WHERE (owner LIKE ? OR assigned_to LIKE ?) AND state IN ('active', 'overdue')
        `).all(`%${entity.canonical_name}%`, `%${entity.canonical_name}%`) as any[];

        // Build RICH item lines with extracted intelligence
        const itemLines = items.slice(0, 20).map((it: any) => {
          const tags = typeof it.tags === 'string' ? JSON.parse(it.tags) : (it.tags || []);
          const isOpen = tags.includes('awaiting_reply') ? ' [AWAITING REPLY]' : '';
          const extractedCommitments = typeof it.commitments === 'string' ? JSON.parse(it.commitments || '[]') : (it.commitments || []);
          const extractedDecisions = typeof it.decisions === 'string' ? JSON.parse(it.decisions || '[]') : (it.decisions || []);
          const extractedActions = typeof it.action_items === 'string' ? JSON.parse(it.action_items || '[]') : (it.action_items || []);

          let line = `  ${it.source_date?.slice(0, 10) || '?'} | ${it.source} | ${it.direction || '?'} | ${it.title}${isOpen}`;
          line += `\n    Summary: ${(it.summary || '').slice(0, 150)}`;
          if (extractedCommitments.length) line += `\n    Commitments: ${extractedCommitments.slice(0, 2).join('; ')}`;
          if (extractedDecisions.length) line += `\n    Decisions: ${extractedDecisions.slice(0, 2).join('; ')}`;
          if (extractedActions.length) line += `\n    Action items: ${extractedActions.slice(0, 2).join('; ')}`;
          return line;
        }).join('\n');

        const connectionLines = connections.map((c: any) =>
          `  ${c.canonical_name} [${c.user_label || c.relationship_type || '?'}] (${c.co_occurrence_count} shared items)`
        ).join('\n');

        const commitmentLines = commitments.map((c: any) =>
          `  - ${c.text} [${c.state}]${c.due_date ? ' due: ' + c.due_date : ''}`
        ).join('\n');

        // Projects this person ACTUALLY appears in (from data, not assumption)
        const actualProjects = db.prepare(`
          SELECT DISTINCT k.project, COUNT(*) as cnt FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          WHERE em.entity_id = ? AND k.project IS NOT NULL AND k.project != ''
          GROUP BY k.project ORDER BY cnt DESC
        `).all(entity.id) as any[];
        const projectLine = actualProjects.map((p: any) => `${p.project} (${p.cnt} items)`).join(', ');

        return `
ENTITY: ${entity.canonical_name}
Email: ${entity.email || 'unknown'}
Domain: ${entity.domain || 'unknown'}
Current label: ${entity.user_label || entity.relationship_type || 'none'}
Total interactions: ${stats?.total || 0} (${stats?.inbound || 0} inbound, ${stats?.outbound || 0} outbound)
First seen: ${stats?.first_seen?.slice(0, 10) || '?'} | Last seen: ${stats?.last_seen?.slice(0, 10) || '?'}
PROJECTS (from data): ${projectLine || '(none)'}
Open threads: ${openThreads.length}
Connected to: ${connections.length > 0 ? '\n' + connectionLines : '(no connections)'}
Open commitments: ${commitments.length > 0 ? '\n' + commitmentLines : '(none)'}

All communications (most recent first):
${itemLines || '  (none)'}
`;
      }).join('\n---\n');

      // SOURCE RETRIEVAL: For the batch, retrieve actual content from APIs
      // for the most important items. This is "going back to the shelf."
      let deepContextBlock = '';
      try {
        // Pick the 2 most important entities in this batch to do deep retrieval
        const deepEntities = batch.slice(0, 2);
        for (const entity of deepEntities) {
          const entityItems = db.prepare(`
            SELECT k.title, k.source, k.source_ref, k.source_date, k.metadata
            FROM knowledge_primary k
            JOIN entity_mentions em ON k.id = em.knowledge_item_id
            WHERE em.entity_id = ?
            ORDER BY k.source_date DESC
          `).all(entity.id) as any[];

          const deepContent = await retrieveDeepContext(db, entityItems, 2);
          if (deepContent) {
            deepContextBlock += `\n\nDEEP SOURCE CONTENT for ${entity.canonical_name}:${deepContent}`;
          }
        }
      } catch (err: any) {
        // Source retrieval is best-effort — don't fail the whole task
        console.log(`    Source retrieval warning: ${err.message?.slice(0, 100)}`);
      }

      // Load business context if available
      const businessCtx = getConfig(db, 'business_context') || '';

      // Load USER CORRECTIONS as hard constraints
      const userLabeled = db.prepare(`
        SELECT canonical_name, user_label, user_notes FROM entities
        WHERE user_label IS NOT NULL AND user_dismissed = 0
      `).all() as any[];
      const userDismissed = db.prepare(`
        SELECT canonical_name FROM entities WHERE user_dismissed = 1
      `).all() as any[];

      const correctionLines = userLabeled.map((e: any) =>
        `- ${e.canonical_name} IS a ${e.user_label}${e.user_notes ? ' (' + e.user_notes + ')' : ''}`
      ).join('\n');
      const dismissedLines = userDismissed.map((e: any) => e.canonical_name).join(', ');

      // PINNED CONTEXT at top of prompt — see dream.ts header comment
      const prompt = `The following context is PERMANENT and takes priority over any contradicting information below.

You are the AI Chief of Staff for Zach Stock. You have DEEP knowledge of his business and must evaluate each contact with that understanding.

BUSINESS CONTEXT:
Zach Stock is the founder of Recapture Insurance, a Managing General Agency (MGA) in the insurance industry.
- An MGA underwrites policies on behalf of carriers. Carrier capacity is existential.
- Zach has ADHD — he drops balls from context-switching, not lack of caring.
${businessCtx ? '\nAdditional user-provided context:\n' + businessCtx : ''}

USER-VERIFIED CORRECTIONS (THESE ARE ABSOLUTE — NEVER contradict):
${correctionLines || '(none)'}

DISMISSED CONTACTS (NEVER surface these):
${dismissedLines || '(none)'}

IMPORTANT: Do NOT assume which projects a person is connected to. The data below shows exactly which projects each entity appears in. Trust the DATA, not assumptions. If an entity's communications are all about "Physician Cyber Program", they are NOT involved in "Carefront" even if both are insurance projects.

${getCorrectionRules(db, 'entity') || getCorrectionRules(db, 'relationship') || ''}

EVALUATION INSTRUCTIONS:
For each entity, analyze their ENTIRE communication history including extracted commitments, decisions, and action items. Consider:
1. What is this person's actual relationship? Use the communication CONTENT, not just frequency.
2. Are there OPEN QUESTIONS or REQUESTS in their emails that genuinely need a response? (Policy deliveries, invoices, and FYI emails do NOT need replies even if tagged "awaiting reply")
3. How does this person connect to Zach's key projects and other important people? (Cross-entity impact)
4. What would a brilliant human Chief of Staff recommend about this relationship RIGHT NOW?
5. Should the system surface alerts about this person, or stay SILENT? (Silence is better than noise)

CRITICAL: An email tagged "awaiting reply" does NOT mean a reply is needed. Evaluate the CONTENT: Does it contain an open question? A request? A time-sensitive ask? Or is it informational/transactional?

ENTITIES TO EVALUATE:
${entityContexts}
${deepContextBlock ? '\n--- ORIGINAL SOURCE MATERIAL (retrieved from APIs — this is the ACTUAL content, not summaries) ---' + deepContextBlock : ''}

Return ONLY this JSON array (no other text):
[
  {
    "name": "Full Name",
    "relationship": "partner|client|vendor|carrier|broker|advisor|employee|cold_outreach|automated|unknown",
    "communication_nature": "transactional|relational|strategic|informational|spam",
    "reply_needed": true/false,
    "reply_reasoning": "Why or why not a reply is needed — be specific",
    "alert_verdict": "surface|suppress",
    "verdict_reasoning": "Why surface or suppress — reference specific emails",
    "importance": "critical|high|medium|low|none",
    "confidence": 0.0-1.0
  }
]`;

      try {
        const response = await callClaude(prompt, 180000);
        const parsed = tryParseJSON(response);

        if (parsed && Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item.name || !item.alert_verdict) continue;

            // Find matching entity
            const matchEntity = batch.find((e: any) =>
              (e.canonical_name || '').toLowerCase() === (item.name || '').toLowerCase()
            );
            if (!matchEntity) continue;

            // Map LLM reply_expectation from reply_needed
            const replyExp = item.reply_needed ? 'sometimes' :
              item.communication_nature === 'spam' ? 'never' :
              item.communication_nature === 'transactional' ? 'rarely' : 'unknown';

            // Store profile
            db.prepare(`
              INSERT INTO entity_profiles (entity_id, communication_nature, reply_expectation,
                email_types, importance_to_business, importance_evidence,
                relationship_evidence, alert_verdict, verdict_reasoning,
                verdict_confidence, last_verified_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
              ON CONFLICT(entity_id) DO UPDATE SET
                communication_nature = excluded.communication_nature,
                reply_expectation = excluded.reply_expectation,
                importance_to_business = excluded.importance_to_business,
                importance_evidence = excluded.importance_evidence,
                relationship_evidence = excluded.relationship_evidence,
                alert_verdict = excluded.alert_verdict,
                verdict_reasoning = excluded.verdict_reasoning,
                verdict_confidence = excluded.verdict_confidence,
                last_verified_at = excluded.last_verified_at,
                updated_at = excluded.updated_at
            `).run(
              matchEntity.id,
              item.communication_nature || 'unknown',
              replyExp,
              item.importance || 'unknown',
              item.verdict_reasoning || '',
              item.reply_reasoning || '',
              item.alert_verdict,
              item.verdict_reasoning || '',
              item.confidence || 0.5,
            );

            // Also update entity relationship_type if AI provides one and user hasn't set it
            if (item.relationship && !matchEntity.user_label) {
              db.prepare(`
                UPDATE entities SET relationship_type = ?, relationship_confidence = ?,
                  updated_at = datetime('now')
                WHERE id = ? AND user_label IS NULL
              `).run(item.relationship, item.confidence || 0.5, matchEntity.id);
            }

            evaluated++;
            if (item.alert_verdict === 'surface') surfaced++;
            else suppressed++;
          }
        }
      } catch (err: any) {
        console.log(`    Batch ${i / BATCH_SIZE + 1} failed: ${err.message.slice(0, 100)}`);
      }

      // Progress
      console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(needsEval.length / BATCH_SIZE)}: ${evaluated} evaluated`);
    }

    return {
      task: '06-entity-understanding',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { evaluated, surfaced, suppressed, total_candidates: needsEval.length },
    };
  } catch (err: any) {
    return { task: '06-entity-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 07: Project Understanding ──────────────────────────
// LLM evaluates each active project with full context: items, people, commitments, timeline

async function task07ProjectUnderstanding(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const projects = db.prepare(`
      SELECT project, COUNT(*) as item_count, MAX(source_date) as last_activity,
        GROUP_CONCAT(DISTINCT source) as sources
      FROM knowledge_primary
      WHERE project IS NOT NULL AND project != ''
      GROUP BY project HAVING item_count >= 3
      ORDER BY MAX(source_date) DESC LIMIT 15
    `).all() as any[];

    if (projects.length === 0) {
      return { task: '07-project-understanding', status: 'skipped', duration_seconds: 0, output: { reason: 'no active projects' } };
    }

    // Build context for all projects in one prompt
    const projectContexts = projects.map((proj: any) => {
      // Key people
      const people = db.prepare(`
        SELECT e.canonical_name, e.user_label, e.relationship_type, COUNT(*) as cnt
        FROM entity_mentions em
        JOIN knowledge_primary k ON em.knowledge_item_id = k.id
        JOIN entities e ON em.entity_id = e.id
        WHERE k.project = ? AND e.type = 'person' AND e.user_dismissed = 0
          AND e.canonical_name NOT LIKE '%Zach%Stock%'
        GROUP BY e.id ORDER BY cnt DESC LIMIT 5
      `).all(proj.project) as any[];

      // Recent items — include source_ref and metadata for deep retrieval
      const items = db.prepare(`
        SELECT title, source, source_date, source_ref, summary, metadata FROM knowledge_primary
        WHERE project = ? ORDER BY source_date DESC LIMIT 15
      `).all(proj.project) as any[];

      // Open commitments
      const commitments = db.prepare(`
        SELECT text, state, due_date, owner FROM commitments
        WHERE project = ? AND state IN ('active', 'overdue', 'detected')
      `).all(proj.project) as any[];

      const daysSince = Math.floor((Date.now() - new Date(proj.last_activity).getTime()) / 86400000);

      return `
PROJECT: ${proj.project}
Items: ${proj.item_count} | Last activity: ${daysSince}d ago | Sources: ${proj.sources}
Key people: ${people.map((p: any) => `${p.canonical_name} [${p.user_label || p.relationship_type || '?'}](${p.cnt})`).join(', ') || 'none'}
Open commitments: ${commitments.length}
${commitments.map((c: any) => `  - ${c.text} [${c.state}]${c.due_date ? ' due: ' + c.due_date : ''}`).join('\n') || '  (none)'}
Recent activity:
${items.slice(0, 10).map((i: any) => `  ${i.source_date?.slice(0, 10) || '?'} | ${i.source} | ${i.title}\n    ${(i.summary || '').slice(0, 200)}`).join('\n')}
`;
    }).join('\n---\n');

    // SOURCE RETRIEVAL: Get actual content for the top 3 most active projects
    let deepProjectContext = '';
    try {
      const topProjects = projects.slice(0, 3);
      for (const proj of topProjects) {
        const projItems = db.prepare(`
          SELECT title, source, source_ref, source_date, metadata FROM knowledge_primary
          WHERE project = ? ORDER BY source_date DESC LIMIT 5
        `).all(proj.project) as any[];

        const deepContent = await retrieveDeepContext(db, projItems, 2);
        if (deepContent) {
          deepProjectContext += `\n\n=== FULL SOURCE MATERIAL: ${proj.project} ===${deepContent}`;
        }
      }
    } catch (err: any) {
      console.log(`    Source retrieval warning: ${err.message?.slice(0, 100)}`);
    }

    const prompt = `You are the AI Chief of Staff for Zach Stock, founder of Recapture Insurance (MGA). Analyze each project and provide a strategic assessment.

For each project, determine:
1. Current status and momentum (accelerating, steady, stalling, stalled, dead)
2. What's the single most important next action?
3. Key risks or blockers
4. Who is the most critical person to this project right now?
5. Is anything being neglected that shouldn't be?

PROJECTS:
${projectContexts}
${deepProjectContext ? '\n--- ORIGINAL SOURCE MATERIAL (actual emails and meeting transcripts, not summaries) ---' + deepProjectContext : ''}

${getCorrectionRules(db, 'project') || getCorrectionRules(db, 'deal') || ''}
${getThreadContext(db) || ''}
Report FACTS from the data. Do NOT speculate or dramatize. Status should reflect what the evidence shows, not worst-case scenarios. Be direct and grounded. If something is fine, say it's fine — don't manufacture urgency.

Return ONLY this JSON array:
[{
  "project": "name",
  "status": "accelerating|steady|stalling|stalled|dead",
  "status_reasoning": "one sentence why",
  "next_action": "the single most important thing to do",
  "risks": ["risk 1", "risk 2"],
  "critical_person": "name or null",
  "neglected_items": ["anything being dropped"],
  "importance": "critical|high|medium|low",
  "confidence": 0.0-1.0
}]`;

    console.log('    Prompt built: ' + prompt.length + ' chars, calling Claude...');
    const response = await callClaude(prompt, 180000);
    console.log('    Claude responded: ' + (response?.length || 0) + ' chars');
    if (response && response.length < 200) console.log('    Short response: ' + response);
    const parsed = tryParseJSON(response);
    if (!parsed) console.log('    Parse failed. First 500 chars: ' + response?.slice(0, 500));

    if (parsed && Array.isArray(parsed)) {
      // Store project profiles in graph_state
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('project_profiles', ?, datetime('now'))
      `).run(JSON.stringify(parsed));

      // CROSS-PROJECT SYNTHESIS: look for connections, conflicts, opportunities
      try {
        const crossProjectPrompt = `You have analyzed ${parsed.length} projects for Zach Stock (Recapture Insurance MGA). Now think ACROSS projects.

PROJECT SUMMARIES:
${parsed.map((p: any) => `${p.project} [${p.status}]: ${p.status_reasoning}\n  Next: ${p.next_action}\n  Critical: ${p.critical_person}\n  Risks: ${(p.risks || []).join('; ')}`).join('\n\n')}

ENTITY-PROJECT MAP (who works across which projects):
${(() => {
  const verifiedEP = db.prepare("SELECT value FROM graph_state WHERE key = 'verified_entity_projects'").get() as any;
  if (!verifiedEP) return '(not available)';
  const data = JSON.parse(verifiedEP.value);
  // Find people in 2+ projects
  const personProjects = new Map<string, string[]>();
  for (const ep of data) {
    if (!personProjects.has(ep.canonical_name)) personProjects.set(ep.canonical_name, []);
    personProjects.get(ep.canonical_name)!.push(ep.project);
  }
  return [...personProjects.entries()]
    .filter(([_, projs]) => projs.length >= 2)
    .map(([name, projs]) => `${name}: ${projs.join(', ')}`)
    .join('\n');
})()}

Think like a strategic advisor. Identify:
1. CONNECTIONS: People or resources in one project that could accelerate another
2. CONFLICTS: Where projects compete for the same resource (time, person, capital)
3. OPPORTUNITIES: Combinations of projects that create value neither has alone
4. SEQUENCE: What should be done in what order given dependencies
5. LEVERAGE: How success in one project creates leverage for another

Return JSON:
{
  "connections": [{"from": "project A", "to": "project B", "through": "person/resource", "insight": "why this matters"}],
  "conflicts": [{"projects": ["A", "B"], "resource": "what they compete for", "resolution": "how to handle"}],
  "opportunities": [{"description": "the opportunity", "projects_involved": ["A", "B"], "action": "specific next step"}],
  "recommended_sequence": ["do X first because it enables Y"],
  "biggest_leverage": "the single most valuable cross-project insight"
}`;

        const crossResponse = await callClaude(crossProjectPrompt, 120000);
        const crossParsed = tryParseJSON(crossResponse);
        if (crossParsed) {
          db.prepare(`
            INSERT OR REPLACE INTO graph_state (key, value, updated_at)
            VALUES ('cross_project_synthesis', ?, datetime('now'))
          `).run(JSON.stringify(crossParsed));
        }
      } catch (err: any) {
        console.log(`    Cross-project synthesis warning: ${err.message?.slice(0, 80)}`);
      }

      return {
        task: '07-project-understanding',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { projects_evaluated: parsed.length, statuses: parsed.map((p: any) => `${p.project}: ${p.status}`).join(', ') },
      };
    }

    return { task: '07-project-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse response' };
  } catch (err: any) {
    return { task: '07-project-understanding', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 08: Commitment Verification ────────────────────────
// LLM reads actual email context to verify if commitments are real, fulfilled, or stale

async function task08CommitmentVerification(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const commitments = db.prepare(`
      SELECT c.id, c.text, c.state, c.due_date, c.owner, c.assigned_to, c.project,
        c.detected_from
      FROM commitments c
      WHERE c.state IN ('active', 'overdue', 'detected')
      ORDER BY c.due_date ASC LIMIT 30
    `).all() as any[];

    if (commitments.length === 0) {
      return { task: '08-commitment-verify', status: 'skipped', duration_seconds: 0, output: { reason: 'no active commitments' } };
    }

    // For each commitment, get the source context + any recent activity
    const commitmentContexts = commitments.map((c: any) => {
      let sourceContext = '';
      if (c.detected_from) {
        const item = db.prepare('SELECT title, summary, source, source_date FROM knowledge WHERE id = ?').get(c.detected_from) as any;
        if (item) sourceContext = `Source: ${item.source_date?.slice(0, 10)} | ${item.source} | ${item.title}\n  ${item.summary?.slice(0, 200)}`;
      }

      // Check for resolution evidence — newer items mentioning same people/project
      let recentActivity = '';
      if (c.project) {
        const recent = db.prepare(`
          SELECT title, source_date FROM knowledge_primary
          WHERE project = ? AND source_date > ? ORDER BY source_date DESC LIMIT 3
        `).all(c.project, c.due_date || '2000-01-01') as any[];
        if (recent.length > 0) {
          recentActivity = 'Recent project activity:\n' + recent.map((r: any) => `  ${r.source_date?.slice(0, 10)} | ${r.title}`).join('\n');
        }
      }

      return `COMMITMENT: "${c.text}"
State: ${c.state} | Due: ${c.due_date || 'none'} | Owner: ${c.owner || '?'} | Assigned: ${c.assigned_to || '?'} | Project: ${c.project || '?'}
${sourceContext}
${recentActivity}`;
    }).join('\n---\n');

    const prompt = `Review these business commitments for Zach Stock (Recapture Insurance MGA). For each, determine if it's still valid, has been fulfilled, or should be dropped.

COMMITMENTS:
${commitmentContexts}

For each commitment, assess:
1. Is this still a real, active obligation?
2. Has it likely been fulfilled (based on recent activity)?
3. Is it stale (so old that following up would be weird)?
4. What should Zach do about it?

Return ONLY this JSON array:
[{
  "text": "commitment text (exact match)",
  "current_state": "active|fulfilled|stale|invalid",
  "reasoning": "why this assessment",
  "recommended_action": "what to do or null",
  "confidence": 0.0-1.0
}]`;

    const response = await callClaude(prompt, 180000);
    const parsed = tryParseJSON(response);

    if (parsed && Array.isArray(parsed)) {
      let updated = 0;
      for (const item of parsed) {
        if (!item.text || !item.current_state) continue;

        // Map to commitment states
        const stateMap: Record<string, string> = {
          'fulfilled': 'done', 'stale': 'abandoned', 'invalid': 'abandoned', 'active': 'active'
        };
        const newState = stateMap[item.current_state] || item.current_state;

        if (newState !== 'active') {
          // Find and update the commitment
          const match = db.prepare(
            "SELECT id FROM commitments WHERE text = ? AND state IN ('active', 'overdue', 'detected')"
          ).get(item.text) as any;
          if (match) {
            db.prepare("UPDATE commitments SET state = ?, state_changed_at = datetime('now') WHERE id = ?")
              .run(newState, match.id);
            updated++;
          }
        }
      }

      // Store full verification results
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('commitment_verification', ?, datetime('now'))
      `).run(JSON.stringify(parsed));

      return {
        task: '08-commitment-verify',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { verified: parsed.length, state_changes: updated },
      };
    }

    return { task: '08-commitment-verify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Could not parse response' };
  } catch (err: any) {
    return { task: '08-commitment-verify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 10: Consistency Verification ────────────────────────
// Cross-checks ALL derived data against primary sources.
// Every table that stores a project/entity association is verified.
// Mismatches are auto-corrected to match the source item.

async function task10ConsistencyVerification(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    let fixes = { commitments: 0, total_checked: 0, mismatches: 0 };

    // ── 1. Commitment-source project consistency ──────────────
    // If commitment.project != source_item.project, auto-correct
    const commitMismatches = db.prepare(`
      SELECT c.id, c.text, c.project as commit_project,
        k.project as source_project, k.title as source_title
      FROM commitments c
      JOIN knowledge k ON c.detected_from = k.id
      WHERE c.project IS NOT NULL AND k.project IS NOT NULL
        AND c.project != k.project
        AND c.state IN ('active', 'overdue', 'detected')
    `).all() as any[];

    for (const m of commitMismatches) {
      // Only auto-fix if names are genuinely different (not just case/variant)
      const commitNorm = (m.commit_project || '').toLowerCase().replace(/[^a-z]/g, '');
      const sourceNorm = (m.source_project || '').toLowerCase().replace(/[^a-z]/g, '');
      if (commitNorm !== sourceNorm) {
        db.prepare('UPDATE commitments SET project = ? WHERE id = ?')
          .run(m.source_project, m.id);
        fixes.commitments++;
        fixes.mismatches++;
      }
    }
    fixes.total_checked += commitMismatches.length;

    // ── 2. Orphaned commitments (source item doesn't exist) ───
    const orphanedCommits = db.prepare(`
      SELECT c.id, c.text FROM commitments c
      WHERE c.detected_from IS NOT NULL
        AND c.detected_from NOT IN (SELECT id FROM knowledge)
        AND c.state IN ('active', 'overdue', 'detected')
    `).all() as any[];

    for (const o of orphanedCommits) {
      db.prepare("UPDATE commitments SET state = 'abandoned', state_changed_at = datetime('now') WHERE id = ?")
        .run(o.id);
      fixes.mismatches++;
    }

    // ── 3. Facts-source consistency ──────────────────────────
    const factMismatches = db.prepare(`
      SELECT f.id, f.project as fact_project,
        k.project as source_project
      FROM facts f
      JOIN knowledge k ON f.source_item_id = k.id
      WHERE f.project IS NOT NULL AND k.project IS NOT NULL
        AND f.project != k.project
    `).all() as any[];

    let factFixes = 0;
    for (const m of factMismatches) {
      const fNorm = (m.fact_project || '').toLowerCase().replace(/[^a-z]/g, '');
      const sNorm = (m.source_project || '').toLowerCase().replace(/[^a-z]/g, '');
      if (fNorm !== sNorm) {
        db.prepare('UPDATE facts SET project = ? WHERE id = ?').run(m.source_project, m.id);
        factFixes++;
      }
    }
    fixes.total_checked += factMismatches.length;

    // ── 4. Build verified entity-project map ──────────────────
    // This is the GROUND TRUTH for who is involved in what project.
    // Stored in graph_state for task 09 to use.
    const entityProjectMap = db.prepare(`
      SELECT e.canonical_name, k.project, COUNT(*) as evidence_count
      FROM entity_mentions em
      JOIN knowledge_primary k ON em.knowledge_item_id = k.id
      JOIN entities e ON em.entity_id = e.id
      WHERE k.project IS NOT NULL AND k.project != ''
        AND e.user_dismissed = 0 AND e.type = 'person'
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
      GROUP BY e.canonical_name, k.project
      HAVING evidence_count >= 2
      ORDER BY e.canonical_name, evidence_count DESC
    `).all() as any[];

    db.prepare(`
      INSERT OR REPLACE INTO graph_state (key, value, updated_at)
      VALUES ('verified_entity_projects', ?, datetime('now'))
    `).run(JSON.stringify(entityProjectMap));

    return {
      task: '10-consistency-verify',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        commitments_fixed: fixes.commitments,
        facts_fixed: factFixes,
        orphaned_commits: orphanedCommits.length,
        entity_project_pairs: entityProjectMap.length,
      },
    };
  } catch (err: any) {
    return { task: '10-consistency-verify', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 19: Gap Detection ────────────────────────────────────
// Finds what's MISSING, not what's there. Pure SQL — no LLM needed.
// Communication gaps, overdue commitments, stale threads, uncovered projects,
// missed prediction verifications. Highest-value intelligence for ADHD.

interface DetectedGap {
  type: 'communication' | 'commitment' | 'thread' | 'project' | 'prediction';
  subject: string;
  description: string;
  severity: 'critical' | 'high' | 'medium';
  days_stale: number;
}

// ── Task 20: Deep Session Strategic Triage ────────────────────
// Asks Claude: "Given everything in Prime, what deep sessions should we suggest?"
// Produces ranked suggestions for the workspace. Auto-runs #1 only if critical.
async function task20DeepSessionTrigger(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Gather signals for strategic triage
    const projectProfilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
    const activeProjects = projectProfilesRaw
      ? (JSON.parse(projectProfilesRaw) as any[]).filter((p: any) => p.status && !['dormant', 'completed'].includes(p.status)).slice(0, 10)
      : [];
    const overdueCommitments = db.prepare(`SELECT text, owner, due_date, project FROM commitments WHERE state = 'overdue' LIMIT 10`).all() as any[];
    const upcomingCommitments = db.prepare(`SELECT text, owner, due_date, project FROM commitments WHERE state = 'active' AND due_date IS NOT NULL ORDER BY due_date ASC LIMIT 10`).all() as any[];
    const recentSessions = db.prepare(`SELECT title, project, created_at FROM deep_sessions WHERE created_at > datetime('now', '-7 days') ORDER BY created_at DESC`).all() as any[];
    const pendingSuggestions = db.prepare(`SELECT topic, project, suggested_by FROM deep_session_suggestions WHERE status = 'pending'`).all() as any[];

    const context = [
      '=== ACTIVE PROJECTS ===',
      ...activeProjects.map((p: any) => `${p.project} — status: ${p.status}, next: ${p.next_action || 'none'}`),
      '', '=== OVERDUE COMMITMENTS ===',
      ...overdueCommitments.map((c: any) => `${c.text} (due: ${c.due_date}, project: ${c.project})`),
      '', '=== UPCOMING COMMITMENTS ===',
      ...upcomingCommitments.map((c: any) => `${c.text} (due: ${c.due_date}, project: ${c.project})`),
      '', '=== DEEP SESSIONS THIS WEEK ===',
      recentSessions.length ? recentSessions.map((s: any) => `${s.title} (${s.project})`).join('\n') : 'None',
      '', '=== PENDING SUGGESTIONS ===',
      pendingSuggestions.length ? pendingSuggestions.map((s: any) => `${s.topic} (by ${s.suggested_by})`).join('\n') : 'None',
    ].join('\n');

    const prompt = `You are the strategic triage system for Prime. Look at everything happening and recommend 1-3 deep sessions that would deliver the highest value RIGHT NOW.

A deep session reads everything in Prime about a topic, does web research, and produces a complete strategy with finished deliverables.

Only suggest deep sessions for problems that need STRATEGIC THINKING — not simple tasks. Good reasons:
- A project needs a unified strategy and doesn't have one
- A deadline is approaching with no plan
- New information changes the strategy
- An opportunity has a closing window
- Gap between commitments and action

${context}

Return ONLY valid JSON:
{"suggestions":[{"topic":"...","project":"...","reasoning":"Why this matters RIGHT NOW","urgency":"critical|high|normal"}],"auto_run":false}

Max 3. If nothing needs deep work, return empty suggestions array.`;

    const response = await callClaude(prompt, 60000);

    let parsed: any = null;
    try {
      const cleaned = response.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        const match = response.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch { /* failed */ }
    }

    if (!parsed?.suggestions?.length) {
      return { task: '20-deep-session-triage', status: 'skipped', duration_seconds: (Date.now() - start) / 1000, output: { reason: 'no suggestions' } };
    }

    const { v4: uuidv4 } = await import('uuid');
    const insert = db.prepare(`INSERT INTO deep_session_suggestions (id, suggested_by, topic, project, reasoning, urgency) VALUES (?, 'dream', ?, ?, ?, ?)`);
    let written = 0;
    for (const s of parsed.suggestions.slice(0, 3)) {
      insert.run(uuidv4(), s.topic, s.project || null, s.reasoning, s.urgency || 'normal');
      written++;
    }
    console.log(`    ${written} deep session suggestions generated`);

    // Auto-run #1 only if critical urgency
    if (parsed.auto_run && parsed.suggestions[0]?.urgency === 'critical') {
      const top = parsed.suggestions[0];
      const recent = db.prepare(`SELECT id FROM deep_sessions WHERE project = ? AND created_at > datetime('now', '-1 days') LIMIT 1`).get(top.project);
      if (!recent) {
        console.log(`    Auto-running critical: ${top.topic}`);
        const { runDeepSession } = await import('./deep-session.js');
        const result = await runDeepSession(db, top.topic, 'dream', top.project);
        return { task: '20-deep-session-triage', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { suggestions: written, auto_ran: top.topic, session_id: result.id } };
      }
    }

    return { task: '20-deep-session-triage', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { suggestions: written } };
  } catch (err: any) {
    return { task: '20-deep-session-triage', status: 'failed', duration_seconds: (Date.now() - start) / 1000, output: { error: err.message?.slice(0, 200) } };
  }
}

async function task19GapDetection(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const gaps: DetectedGap[] = [];

    // ── 1. COMMUNICATION GAPS ──────────────────────────────────
    // Key people where the last entity_mention is >5 days old
    // AND there's an active commitment or thread involving them
    const commGaps = db.prepare(`
      SELECT e.canonical_name,
        MAX(em.mention_date) as last_mention,
        CAST(julianday('now') - julianday(MAX(em.mention_date)) AS INTEGER) as days_silent,
        e.user_label,
        e.id as entity_id
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      WHERE e.user_label IN ('partner', 'client', 'key')
        AND e.user_dismissed = 0
      GROUP BY e.id
      HAVING days_silent > 5
      ORDER BY days_silent DESC
    `).all() as any[];

    for (const cg of commGaps) {
      // Check if there's an active commitment or thread involving this entity
      const hasActiveCommitment = db.prepare(`
        SELECT 1 FROM commitments
        WHERE state IN ('active', 'overdue')
          AND (owner LIKE ? OR assigned_to LIKE ? OR text LIKE ?)
        LIMIT 1
      `).get(`%${cg.canonical_name}%`, `%${cg.canonical_name}%`, `%${cg.canonical_name}%`);

      const hasActiveThread = db.prepare(`
        SELECT 1 FROM narrative_threads
        WHERE status = 'active'
          AND (entity_ids LIKE ? OR title LIKE ?)
        LIMIT 1
      `).get(`%${cg.entity_id}%`, `%${cg.canonical_name}%`);

      if (hasActiveCommitment || hasActiveThread) {
        gaps.push({
          type: 'communication',
          subject: cg.canonical_name,
          description: `${cg.user_label} "${cg.canonical_name}" — no communication in ${cg.days_silent} days with active commitments/threads open`,
          severity: cg.days_silent > 14 ? 'critical' : cg.days_silent > 7 ? 'high' : 'medium',
          days_stale: cg.days_silent,
        });
      }
    }

    // ── 2. COMMITMENT GAPS ─────────────────────────────────────
    // Active commitments where due_date passed or within 3 days,
    // with no recent knowledge items referencing them
    const commitGaps = db.prepare(`
      SELECT c.id, c.text, c.due_date, c.project, c.owner,
        CAST(julianday(c.due_date) - julianday('now') AS INTEGER) as days_until_due
      FROM commitments c
      WHERE c.state = 'active'
        AND c.due_date IS NOT NULL
        AND julianday(c.due_date) - julianday('now') < 3
      ORDER BY c.due_date ASC
    `).all() as any[];

    for (const cc of commitGaps) {
      // Check for recent knowledge items referencing this commitment
      const recentRef = db.prepare(`
        SELECT 1 FROM knowledge_primary
        WHERE source_date >= datetime('now', '-5 days')
          AND (summary LIKE ? OR title LIKE ? OR commitments LIKE ?)
        LIMIT 1
      `).get(`%${cc.text.slice(0, 40)}%`, `%${cc.text.slice(0, 40)}%`, `%${cc.text.slice(0, 40)}%`);

      if (!recentRef) {
        const isOverdue = cc.days_until_due < 0;
        gaps.push({
          type: 'commitment',
          subject: cc.text.slice(0, 80),
          description: isOverdue
            ? `Overdue by ${Math.abs(cc.days_until_due)} days: "${cc.text}"${cc.project ? ` (${cc.project})` : ''} — no recent activity found`
            : `Due in ${cc.days_until_due} days: "${cc.text}"${cc.project ? ` (${cc.project})` : ''} — no recent activity found`,
          severity: isOverdue ? 'critical' : cc.days_until_due <= 1 ? 'high' : 'medium',
          days_stale: isOverdue ? Math.abs(cc.days_until_due) : 0,
        });
      }
    }

    // ── 3. THREAD GAPS ─────────────────────────────────────────
    // Active narrative_threads where latest_source_date >7 days old
    // AND current_state contains awaiting/pending/follow-up language
    const threadGaps = db.prepare(`
      SELECT t.id, t.title, t.current_state, t.project, t.latest_source_date,
        CAST(julianday('now') - julianday(t.latest_source_date) AS INTEGER) as days_stale
      FROM narrative_threads t
      WHERE t.status = 'active'
        AND t.latest_source_date IS NOT NULL
        AND julianday('now') - julianday(t.latest_source_date) > 7
        AND (
          t.current_state LIKE '%await%'
          OR t.current_state LIKE '%pending%'
          OR t.current_state LIKE '%follow%up%'
          OR t.current_state LIKE '%follow-up%'
          OR t.current_state LIKE '%waiting%'
          OR t.current_state LIKE '%response%needed%'
          OR t.current_state LIKE '%no reply%'
        )
      ORDER BY days_stale DESC
    `).all() as any[];

    for (const tg of threadGaps) {
      gaps.push({
        type: 'thread',
        subject: tg.title,
        description: `"${tg.title}" stale ${tg.days_stale} days — state: ${(tg.current_state || '').slice(0, 100)}${tg.project ? ` (${tg.project})` : ''}`,
        severity: tg.days_stale > 21 ? 'critical' : tg.days_stale > 14 ? 'high' : 'medium',
        days_stale: tg.days_stale,
      });
    }

    // ── 4. PROJECT GAPS ────────────────────────────────────────
    // Projects with status stalling/stalled and no staged_action for them
    const profilesRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'project_profiles'"
    ).get() as any)?.value;

    if (profilesRaw) {
      const profiles = JSON.parse(profilesRaw);
      const stallingProjects = profiles.filter((p: any) =>
        p.status === 'stalling' || p.status === 'stalled'
      );

      for (const sp of stallingProjects) {
        const hasAction = db.prepare(`
          SELECT 1 FROM staged_actions
          WHERE status = 'pending'
            AND project = ?
          LIMIT 1
        `).get(sp.project);

        if (!hasAction) {
          // Calculate staleness from last knowledge item
          const lastActivity = db.prepare(`
            SELECT MAX(source_date) as last_date FROM knowledge_primary WHERE project = ?
          `).get(sp.project) as any;
          const daysSinceActivity = lastActivity?.last_date
            ? Math.round((Date.now() - new Date(lastActivity.last_date).getTime()) / 86400000)
            : 999;

          gaps.push({
            type: 'project',
            subject: sp.project,
            description: `Project "${sp.project}" is ${sp.status} with no staged actions — ${sp.status_reasoning?.slice(0, 100) || 'no details'}`,
            severity: sp.status === 'stalled' ? 'critical' : 'high',
            days_stale: daysSinceActivity,
          });
        }
      }
    }

    // ── 5. PREDICTION GAPS ─────────────────────────────────────
    // Predictions where check_by has passed but outcome still pending
    const predGaps = db.prepare(`
      SELECT p.id, p.subject, p.prediction, p.check_by, p.confidence, p.domain, p.project,
        CAST(julianday('now') - julianday(p.check_by) AS INTEGER) as days_overdue
      FROM predictions p
      WHERE p.outcome = 'pending'
        AND julianday(p.check_by) < julianday('now')
      ORDER BY days_overdue DESC
    `).all() as any[];

    for (const pg of predGaps) {
      gaps.push({
        type: 'prediction',
        subject: pg.subject,
        description: `Prediction verification missed (${pg.days_overdue}d overdue): "${pg.prediction.slice(0, 80)}" — check_by was ${pg.check_by}`,
        severity: pg.days_overdue > 7 ? 'high' : 'medium',
        days_stale: pg.days_overdue,
      });
    }

    // ── Store results ──────────────────────────────────────────
    // Sort: critical first, then by days_stale descending
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
    gaps.sort((a, b) => {
      const sev = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sev !== 0) return sev;
      return b.days_stale - a.days_stale;
    });

    db.prepare(`
      INSERT OR REPLACE INTO graph_state (key, value, updated_at)
      VALUES ('detected_gaps', ?, datetime('now'))
    `).run(JSON.stringify(gaps));

    const summary = {
      total: gaps.length,
      critical: gaps.filter(g => g.severity === 'critical').length,
      high: gaps.filter(g => g.severity === 'high').length,
      medium: gaps.filter(g => g.severity === 'medium').length,
      by_type: {
        communication: gaps.filter(g => g.type === 'communication').length,
        commitment: gaps.filter(g => g.type === 'commitment').length,
        thread: gaps.filter(g => g.type === 'thread').length,
        project: gaps.filter(g => g.type === 'project').length,
        prediction: gaps.filter(g => g.type === 'prediction').length,
      },
    };

    return {
      task: '19-gap-detection',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: summary,
    };
  } catch (err: any) {
    return { task: '19-gap-detection', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 11: Claim Verification Loop ─────────────────────────
// Before presenting ANY claim, verify it against primary sources.
// Search Gmail for evidence that contradicts the claim.
// This is the "self-doubt" mechanism — doubt every assertion, check reality.

async function task11ClaimVerification(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    let verified = 0;
    let invalidated = 0;
    let checked = 0;

    // ── 1. Verify overdue commitments ────────────────────────
    // For each commitment marked overdue, search for fulfillment evidence
    const overdueCommits = db.prepare(`
      SELECT c.id, c.text, c.owner, c.assigned_to, c.project, c.detected_from
      FROM commitments c
      WHERE c.state = 'overdue'
      LIMIT 15
    `).all() as any[];

    for (const commit of overdueCommits) {
      checked++;

      // Build a search query from the commitment
      const owner = commit.owner || commit.assigned_to || '';
      const keywords = commit.text
        .replace(/committed to|will|should|needs to/gi, '')
        .replace(/[^\w\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter((w: string) => w.length > 3)
        .slice(0, 4)
        .join(' ');

      if (!keywords || keywords.length < 5) continue;

      // Search knowledge base for fulfillment evidence
      // Look for newer items from the same person mentioning the same topic
      const evidence = db.prepare(`
        SELECT k.id, k.title, k.summary, k.source_date
        FROM knowledge_primary k
        WHERE k.source_date > COALESCE(
          (SELECT source_date FROM knowledge WHERE id = ?), '2000-01-01'
        )
        AND (k.title LIKE ? OR k.summary LIKE ?)
        ORDER BY k.source_date DESC LIMIT 3
      `).all(
        commit.detected_from,
        `%${keywords.split(' ')[0]}%`,
        `%${keywords.split(' ')[0]}%`
      ) as any[];

      // If there's newer activity on this topic, send to LLM for verification
      if (evidence.length > 0) {
        const evidenceText = evidence.map((e: any) =>
          `${e.source_date?.slice(0, 10)} | ${e.title} | ${e.summary?.slice(0, 150)}`
        ).join('\n');

        const prompt = `A commitment tracking system says this is OVERDUE:
"${commit.text}" (assigned to: ${owner})

But newer activity was found:
${evidenceText}

Based on this evidence, has the commitment been FULFILLED or is it still genuinely overdue?
Return ONLY one word: FULFILLED or OVERDUE`;

        try {
          const response = await callClaude(prompt, 30000);
          const verdict = response.trim().toUpperCase();

          if (verdict.includes('FULFILLED')) {
            db.prepare(`
              UPDATE commitments SET state = 'done', state_changed_at = datetime('now'),
                fulfilled_evidence = ? WHERE id = ?
            `).run(
              `Auto-verified: found evidence in ${evidence[0].title} (${evidence[0].source_date?.slice(0, 10)})`,
              commit.id
            );
            invalidated++;
          } else {
            verified++; // Confirmed still overdue
          }
        } catch {
          // LLM call failed — skip, don't block
        }
      } else {
        verified++; // No contradicting evidence found — still overdue
      }
    }

    // ── 2. Verify "awaiting reply" items ─────────────────────
    // Check if items tagged awaiting_reply have actually been resolved
    const awaitingItems = db.prepare(`
      SELECT k.id, k.title, k.source_ref, k.contacts, k.source_date,
        json_extract(k.metadata, '$.last_from') as last_from
      FROM knowledge_primary k
      WHERE k.tags LIKE '%awaiting_reply%'
      ORDER BY k.source_date DESC LIMIT 20
    `).all() as any[];

    let replyFixed = 0;
    for (const item of awaitingItems) {
      // Check for a newer item in the same thread (sent mail scan)
      if (item.source_ref?.startsWith('thread:')) {
        const threadId = item.source_ref.replace('thread:', '');
        const newerInThread = db.prepare(`
          SELECT id FROM knowledge_primary
          WHERE source_ref = ? AND source_date > ? AND source != 'gmail'
        `).get(`thread:${threadId}`, item.source_date);

        // Also check sent mail for same thread
        const sentReply = db.prepare(`
          SELECT id FROM knowledge_primary
          WHERE source = 'gmail-sent' AND source_ref LIKE ? AND source_date > ?
        `).get(`%${threadId}%`, item.source_date);

        if (newerInThread || sentReply) {
          // Remove awaiting_reply tag
          const tags = JSON.parse(
            (db.prepare('SELECT tags FROM knowledge WHERE id = ?').get(item.id) as any)?.tags || '[]'
          ).filter((t: string) => t !== 'awaiting_reply');
          db.prepare('UPDATE knowledge SET tags = ?, metadata = json_set(COALESCE(metadata, \'{}\'), \'$.user_replied\', true) WHERE id = ?')
            .run(JSON.stringify(tags), item.id);
          replyFixed++;
        }
      }
    }

    // ── 3. Commitment cross-referencing (SQL-only, no LLM) ────
    // For each active/detected commitment, search for evidence it was fulfilled:
    //   - Sent emails matching commitment keywords
    //   - Documents/actions with matching project + contacts after commitment date
    //   - Knowledge items referencing completion keywords
    // If strong evidence found, auto-fulfill. If overdue with zero evidence, flag genuinely overdue.
    let crossRefChecked = 0;
    let crossRefFulfilled = 0;
    let crossRefGenuineOverdue = 0;

    const activeCommits = db.prepare(`
      SELECT c.id, c.text, c.owner, c.assigned_to, c.project, c.due_date,
        c.detected_from, c.state, c.detected_at
      FROM commitments c
      WHERE c.state IN ('active', 'overdue', 'detected')
      ORDER BY c.due_date ASC LIMIT 30
    `).all() as any[];

    for (const commit of activeCommits) {
      crossRefChecked++;
      const commitDate = commit.detected_at || commit.due_date || '2000-01-01';

      // Extract meaningful keywords from commitment text
      const keywords = commit.text
        .replace(/\b(committed to|will|should|needs to|promised|agreed|going to|plan to)\b/gi, '')
        .replace(/[^\w\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter((w: string) => w.length > 3 && !/^(that|this|with|from|they|have|been|would|could|about|their|some|also)$/i.test(w))
        .slice(0, 5);

      if (keywords.length < 1) continue;

      // Build LIKE clauses for each keyword — match if ANY keyword appears in title/summary
      // Also check for completion-signaling words in same items
      const completionWords = ['sent', 'completed', 'done', 'delivered', 'submitted', 'signed', 'approved', 'finalized', 'confirmed', 'scheduled'];

      // Search for fulfillment evidence: newer items with matching keywords
      let evidenceFound = false;
      for (const kw of keywords) {
        if (kw.length < 4) continue;

        const matches = db.prepare(`
          SELECT k.id, k.title, k.summary, k.source, k.source_date
          FROM knowledge_primary k
          WHERE k.source_date > ?
            AND (k.title LIKE ? OR k.summary LIKE ?)
          ORDER BY k.source_date DESC LIMIT 5
        `).all(commitDate, `%${kw}%`, `%${kw}%`) as any[];

        // Check if any match contains completion signals
        for (const match of matches) {
          const text = ((match.title || '') + ' ' + (match.summary || '')).toLowerCase();
          const hasCompletion = completionWords.some(cw => text.includes(cw));

          // Also check if it's a sent email (outbound action = likely fulfillment)
          const isSentMail = match.source === 'gmail-sent';

          if (hasCompletion || isSentMail) {
            // Strong evidence: mark as fulfilled
            db.prepare(`
              UPDATE commitments SET state = 'done', state_changed_at = datetime('now'),
                fulfilled_evidence = ? WHERE id = ?
            `).run(
              `Cross-ref: ${match.source_date?.slice(0, 10)} [${match.source}] ${match.title?.slice(0, 80)}`,
              commit.id
            );
            crossRefFulfilled++;
            evidenceFound = true;
            break;
          }
        }
        if (evidenceFound) break;
      }

      // If overdue and no evidence at all, flag as genuinely overdue
      if (!evidenceFound && commit.state === 'overdue') {
        crossRefGenuineOverdue++;
      }
    }

    return {
      task: '11-claim-verification',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        commitments_checked: checked,
        commitments_still_overdue: verified,
        commitments_fulfilled: invalidated,
        replies_fixed: replyFixed,
        crossref_checked: crossRefChecked,
        crossref_fulfilled: crossRefFulfilled,
        crossref_genuine_overdue: crossRefGenuineOverdue,
      },
    };
  } catch (err: any) {
    return { task: '11-claim-verification', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 09: World Narrative Synthesis ───────────────────────
// LLM takes ALL the intelligence (entity profiles, project profiles, commitment
// verdicts, alerts) and produces a narrative that tells the STORY of the business.
// This replaces the SQL-generated world model with something that actually understands.

async function task09WorldNarrative(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Expire previous Task 09 staged actions (but NOT Task 18 strategic actions or Task 14 investigation actions)
    db.prepare("UPDATE staged_actions SET status = 'expired', acted_at = datetime('now') WHERE status = 'pending' AND source_task = 'world-narrative'").run();

    // Load yesterday's staged action outcomes for feedback loop
    const yesterdayOutcomes = db.prepare(`
      SELECT summary, status, type FROM staged_actions
      WHERE acted_at >= datetime('now', '-2 days') AND status != 'pending'
      ORDER BY acted_at DESC LIMIT 10
    `).all() as any[];

    // Build episodic understanding block (outside template to avoid nested backtick issues)
    let episodicBlock = '(no recent episodic moments)';
    try {
      const moments = db.prepare(
        "SELECT moment_type, what_happened, why_it_matters, consequence, preceded_by, enables, cascade, project, confidence FROM episodic_moments WHERE created_at >= datetime('now', '-7 days') ORDER BY confidence DESC LIMIT 15"
      ).all() as any[];
      if (moments.length > 0) {
        episodicBlock = moments.map((m: any) => {
          let line = `[${m.moment_type}] ${m.what_happened}`;
          line += `\n  WHY: ${m.why_it_matters}`;
          if (m.consequence) line += `\n  CONSEQUENCE: ${m.consequence}`;
          if (m.enables) line += `\n  ENABLES: ${m.enables}`;
          if (m.cascade) line += `\n  CASCADE: ${m.cascade}`;
          if (m.project) line += `\n  PROJECT: ${m.project}`;
          return line;
        }).join('\n\n');
      }
    } catch (_e) {}

    const feedbackBlock = yesterdayOutcomes.length > 0
      ? 'YESTERDAY\'S ACTION OUTCOMES (learn from what user approved vs rejected):\n' +
        yesterdayOutcomes.map((a: any) =>
          `- "${a.summary}" → ${a.status.toUpperCase()}`
        ).join('\n') +
        '\nOnly include explicitly REJECTED actions as negative signal. EXPIRED = no signal.'
      : '';

    // Gather all intelligence products
    const entityProfiles = db.prepare(`
      SELECT ep.*, e.canonical_name, e.email, e.domain
      FROM entity_profiles ep
      JOIN entities e ON ep.entity_id = e.id
      WHERE ep.alert_verdict = 'surface'
      ORDER BY ep.verdict_confidence DESC
    `).all() as any[];

    const projectProfiles = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'project_profiles'"
    ).get() as any)?.value;
    const projects = projectProfiles ? JSON.parse(projectProfiles) : [];

    const commitmentResults = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'commitment_verification'"
    ).get() as any)?.value;
    const commitments = commitmentResults ? JSON.parse(commitmentResults) : [];

    // Get today's calendar if available
    const today = new Date().toISOString().slice(0, 10);
    const calendarItems = db.prepare(`
      SELECT title, summary, source_date FROM knowledge_primary
      WHERE source = 'calendar' AND source_date >= ? AND source_date < datetime(?, '+1 day')
      ORDER BY source_date ASC
    `).all(today, today) as any[];

    // Load verified entity-project map (from task 10 consistency verification)
    const verifiedEPRaw = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'verified_entity_projects'"
    ).get() as any)?.value;
    const verifiedEP = verifiedEPRaw ? JSON.parse(verifiedEPRaw) : [];
    const entityProjectBlock = verifiedEP.map((ep: any) =>
      `${ep.canonical_name} → ${ep.project} (${ep.evidence_count} items)`
    ).join('\n');

    const surfaceAlerts = entityProfiles.map((ep: any) =>
      `${ep.canonical_name} [${ep.communication_nature}]: ${ep.verdict_reasoning} (${Math.round(ep.verdict_confidence * 100)}% confidence)`
    ).join('\n');

    const projectSummary = projects.map((p: any) =>
      `${p.project} [${p.status}]: ${p.status_reasoning}${p.next_action ? ' Next: ' + p.next_action : ''}`
    ).join('\n');

    const activeCommitments = commitments
      .filter((c: any) => c.current_state === 'active')
      .map((c: any) => `- ${c.text}: ${c.reasoning}${c.recommended_action ? ' → ' + c.recommended_action : ''}`)
      .join('\n');

    const calendarSummary = calendarItems.map((c: any) =>
      `${c.source_date?.slice(11, 16) || '?'} ${c.title}`
    ).join('\n');

    // Load user corrections as hard constraints for the narrative
    const userCorrections = db.prepare(`
      SELECT canonical_name, user_label, user_notes FROM entities
      WHERE user_label IS NOT NULL AND user_dismissed = 0
    `).all() as any[];
    const correctionBlock = userCorrections.map((e: any) =>
      `- ${e.canonical_name} = ${e.user_label}${e.user_notes ? ' (' + e.user_notes + ')' : ''}`
    ).join('\n');

    // Load the SQL world model as verified facts
    const worldModelPath = join(homedir(), '.prime', 'world.md');
    let verifiedFacts = '';
    try { verifiedFacts = readFileSync(worldModelPath, 'utf-8'); } catch (_e) {}

    const prompt = `You are the AI Chief of Staff synthesizing a daily intelligence briefing for Zach Stock, founder of Recapture Insurance (MGA/insurtech).

Write a concise narrative (not a data dump) that tells Zach what he needs to know TODAY. Write as if you are his most trusted advisor speaking directly to him. Be opinionated — prioritize, recommend, warn.

VERIFIED FACTS (from SQL world model — primary sources only, treat as TRUE):
${verifiedFacts.slice(0, 4000) || '(no world model available)'}

USER-VERIFIED CORRECTIONS (ABSOLUTE — NEVER contradict these):
${correctionBlock || '(none)'}

VERIFIED ENTITY-PROJECT ASSOCIATIONS (from primary sources — ONLY associate people with projects listed here):
${entityProjectBlock || '(no verified associations)'}
RULE: If a person does NOT appear next to a project in this list, do NOT associate them with that project. This is the ground truth.

ENTITY INTELLIGENCE (from dream analysis — useful but flag uncertainty):
${surfaceAlerts || '(none — all relationships healthy)'}

PROJECT INTELLIGENCE (from dream analysis):
${projectSummary || '(no project intelligence yet)'}

EPISODIC UNDERSTANDING (recent moments that shaped the business — use these for deep reasoning):
${episodicBlock}

CROSS-PROJECT CONNECTIONS (opportunities the user may not see):
${(() => {
  try {
    const cross = db.prepare("SELECT value FROM graph_state WHERE key = 'cross_project_synthesis'").get() as any;
    if (!cross) return '(not available)';
    const data = JSON.parse(cross.value);
    const parts: string[] = [];
    if (data.biggest_leverage) parts.push('BIGGEST LEVERAGE: ' + data.biggest_leverage);
    if (data.opportunities?.length) parts.push('OPPORTUNITIES:\n' + data.opportunities.map((o: any) => `- ${o.description} → ${o.action}`).join('\n'));
    if (data.conflicts?.length) parts.push('CONFLICTS:\n' + data.conflicts.map((c: any) => `- ${c.projects.join(' vs ')}: ${c.resource} → ${c.resolution}`).join('\n'));
    if (data.recommended_sequence?.length) parts.push('SEQUENCE:\n' + data.recommended_sequence.map((s: any, i: number) => `${i+1}. ${s}`).join('\n'));
    return parts.join('\n\n') || '(none)';
  } catch { return '(not available)'; }
})()}

ACTIVE COMMITMENTS (verified against source items):
${activeCommitments || '(none verified active)'}

DETECTED GAPS — THINGS FALLING THROUGH THE CRACKS (from Task 19 gap detection):
${(() => {
  try {
    const gapsRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'detected_gaps'").get() as any;
    if (!gapsRaw) return '(no gaps detected)';
    const gapsList = JSON.parse(gapsRaw.value) as any[];
    if (gapsList.length === 0) return '(no gaps — everything is covered)';
    return gapsList.slice(0, 15).map((g: any) =>
      '[' + g.severity.toUpperCase() + '] ' + g.type + ': ' + g.description
    ).join('\n');
  } catch { return '(gap data not available)'; }
})()}
RULE: If there are critical or high-severity gaps, they MUST appear in the briefing. These are dropped balls — the whole point of this system.

TODAY'S CALENDAR:
${calendarSummary || '(no calendar events)'}

MEETING PREP BRIEFS (generated for upcoming meetings):
${(() => {
  try {
    const preps = db.prepare("SELECT value FROM graph_state WHERE key = 'meeting_preps'").get() as any;
    if (!preps) return '(no upcoming meetings)';
    const data = JSON.parse(preps.value);
    return data.map((p: any) => `MEETING: ${p.meeting} (${new Date(p.time).toLocaleString()})\n${p.brief}`).join('\n\n---\n\n');
  } catch { return '(not available)'; }
})()}

${feedbackBlock}

${getCorrectionRules(db) || ''}
${getThreadContext(db) || ''}
${(() => {
  try {
    const acc = db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_accuracy'").get() as any;
    if (!acc) return '';
    const data = JSON.parse(acc.value);
    let block = `PREDICTION TRACK RECORD (use to calibrate confidence):\nOverall accuracy: ${Math.round(data.accuracy_rate * 100)}% (${data.total_verified} verified)`;
    const errors = db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_errors_latest'").get() as any;
    if (errors) {
      const errData = JSON.parse(errors.value).slice(0, 3);
      if (errData.length > 0) block += '\nRecent errors:\n' + errData.map((e: any) => `- PREDICTED: "${e.prediction}" → WRONG: ${e.evidence}`).join('\n');
    }
    return block;
  } catch { return ''; }
})()}

FORMAT:
1. **The One Thing** — the single most important item today (if nothing urgent, say so)
2. **People** — who needs attention and why (max 5, with specific recommended actions)
3. **Projects** — 1-sentence status on each active project, flag anything stalling
4. **Commitments** — only ones that are genuinely pending and matter
5. **Today** — calendar context if relevant
6. **This Week** — what to be thinking about for the rest of the week

RULES:
- Build your narrative from VERIFIED FACTS as the skeleton
- Add reasoning from entity/project intelligence but flag uncertainty
- Before associating any person with a project, VERIFY the association exists in VERIFIED FACTS
- NEVER contradict USER-VERIFIED CORRECTIONS
- If something is fine, don't mention it (selective silence)
- If you're uncertain, say so — "(inferred)" vs "(verified)"
- Write for someone with ADHD who will skim this in 60 seconds
- Think strategically: what are the 2nd and 3rd order implications? What connections should be made?

After the briefing text, include a PREPARED ACTIONS block as fenced JSON:

\`\`\`json
{"prepared_actions": [
  {"type": "email", "to": "recipient@email.com", "subject": "...", "body": "...", "reasoning": "why send this", "project": "..."},
  {"type": "calendar", "title": "...", "duration_min": 30, "description": "...", "reasoning": "why schedule this", "project": "..."},
  {"type": "reminder", "text": "...", "reasoning": "why remind", "project": "..."}
]}
\`\`\`

Include 2-5 prepared actions. Each should be a CONCRETE thing the user can approve with one click. Draft actual email bodies (not placeholders). Be specific.

After the prepared actions, include a PREDICTIONS block:

\`\`\`predictions
{"predictions": [
  {"domain": "project|entity|commitment|deal", "subject": "what this is about", "prediction": "specific falsifiable prediction", "confidence": 0.0-1.0, "check_by": "YYYY-MM-DD", "reasoning": "why, citing evidence"}
]}
\`\`\`

Include 3-7 predictions. They MUST be:
- SPECIFIC and FALSIFIABLE (not "things will be fine")
- TIME-BOUND (check_by = when to verify, 1-7 days out)
- CALIBRATED (use your track record above to adjust confidence — if you've been overconfident, lower your scores)
- IMPACTFUL (no trivial predictions like "email volume will be normal")
- VARIED (mix of project, entity, commitment, deal domains)`;

    const narrative = await callClaude(prompt, 180000);

    if (narrative && narrative.length > 100) {
      // Split narrative text from prepared actions JSON
      let narrativeText = narrative;
      let actionsStored = 0;

      // Extract fenced JSON block if present
      const jsonMatch = narrative.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        narrativeText = narrative.replace(/```json[\s\S]*?```/, '').trim();
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          const actions = parsed.prepared_actions || parsed;
          if (Array.isArray(actions)) {
            const expiresAt = new Date(Date.now() + 72 * 3600000).toISOString();
            for (const action of actions) {
              db.prepare(`
                INSERT INTO staged_actions (type, summary, payload, reasoning, project, source_task, expires_at)
                VALUES (?, ?, ?, ?, ?, 'dream-09', ?)
              `).run(
                action.type || 'reminder',
                action.subject || action.title || action.text || action.summary || 'Action',
                JSON.stringify(action),
                action.reasoning || '',
                action.project || null,
                expiresAt,
              );
              actionsStored++;
            }
          }
        } catch (err: any) {
          console.log(`    Prepared actions parse warning: ${err.message?.slice(0, 80)}`);
        }
      }

      // Extract predictions block
      let predictionsStored = 0;
      const predMatch = narrative.match(/```predictions\s*([\s\S]*?)```/);
      if (predMatch) {
        narrativeText = narrativeText.replace(/```predictions[\s\S]*?```/, '').trim();
        try {
          const predParsed = JSON.parse(predMatch[1]);
          const predictions = predParsed.predictions || predParsed;
          if (Array.isArray(predictions)) {
            const { v4: uuidv4 } = await import('uuid');
            for (const pred of predictions) {
              db.prepare(`
                INSERT INTO predictions (id, prediction_date, check_by, domain, subject,
                  prediction, confidence, reasoning, impact_weight, outcome, source_task, project)
                VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, 'pending', 'dream-09', ?)
              `).run(
                uuidv4(),
                pred.check_by || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
                pred.domain || 'project',
                pred.subject || '',
                pred.prediction || '',
                pred.confidence || 0.5,
                pred.reasoning || '',
                pred.confidence >= 0.7 ? 0.8 : 0.5, // high-confidence = high-impact
                pred.project || null,
              );
              predictionsStored++;
            }
          }
        } catch (err: any) {
          console.log(`    Predictions parse warning: ${err.message?.slice(0, 80)}`);
        }
      }

      // Save as world narrative (without the JSON/prediction blocks)
      const narrativePath = join(homedir(), '.prime', 'world-narrative.md');
      writeFileSync(narrativePath, `# Daily Intelligence Briefing\n_Generated: ${new Date().toLocaleString()}_\n\n${narrativeText}`);

      // Also store in graph_state for programmatic access
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('world_narrative', ?, datetime('now'))
      `).run(narrative);

      return {
        task: '09-world-narrative',
        status: 'success',
        duration_seconds: (Date.now() - start) / 1000,
        output: { length: narrativeText.length, actions_staged: actionsStored, predictions_stored: predictionsStored, saved_to: narrativePath },
      };
    }

    return { task: '09-world-narrative', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Empty narrative' };
  } catch (err: any) {
    return { task: '09-world-narrative', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 21: Strategic Question Generator ────────────────────
// Analyzes what the dream pipeline produced and surfaces questions
// that only Zach can answer — strategy, clarifications, prediction
// reviews, and priority calls. Runs AFTER world narrative, BEFORE self-audit.

async function task21QuestionGenerator(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Expire questions older than 7 days
    db.prepare("UPDATE prime_questions SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-7 days')").run();

    // Gather pipeline outputs for LLM context
    const gapsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'detected_gaps'").get() as any)?.value;
    const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
    const predsRaw = db.prepare("SELECT subject, prediction, confidence, outcome, error_analysis, project FROM predictions WHERE outcome != 'pending' ORDER BY updated_at DESC LIMIT 5").all() as any[];
    const investigationsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'investigation_results'").get() as any)?.value;
    const narrativeRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'world_narrative'").get() as any)?.value;

    const gaps = gapsRaw ? JSON.parse(gapsRaw).slice(0, 10) : [];
    const profiles = profilesRaw ? JSON.parse(profilesRaw) : [];
    const investigations = investigationsRaw ? JSON.parse(investigationsRaw) : [];
    const narrative = narrativeRaw ? narrativeRaw.slice(0, 2000) : '';

    // Check for existing pending questions to avoid duplicates
    const existingQs = db.prepare("SELECT question FROM prime_questions WHERE status = 'pending'").all() as any[];
    const existingSet = new Set(existingQs.map((q: any) => (q.question || '').toLowerCase().slice(0, 50)));

    const prompt = `You are the AI Chief of Staff analyzing dream pipeline outputs. Your job: identify 3-5 questions that ONLY Zach (the founder) can answer. These are things the data cannot resolve.

CATEGORIES:
- STRATEGIC: Business judgment calls (deal terms, partnership decisions, pricing strategy)
- CLARIFICATION: Ambiguous references in data the system can't resolve (mentioned frameworks, unnamed contacts, vague plans)
- PREDICTION_REVIEW: The system predicted wrong — what signal was missed? (only if predictions below show errors)
- PRIORITY: Competing demands that need Zach's prioritization call

DETECTED GAPS:
${gaps.length > 0 ? gaps.map((g: any) => `[${g.severity}] ${g.type}: ${g.description}`).join('\n') : '(none)'}

PROJECT PROFILES:
${profiles.length > 0 ? profiles.map((p: any) => `${p.project} [${p.status}]: ${p.status_reasoning || ''}${p.next_action ? ' Next: ' + p.next_action : ''}`).join('\n') : '(none)'}

RECENT PREDICTION OUTCOMES:
${predsRaw.length > 0 ? predsRaw.map((p: any) => `${p.subject}: predicted "${p.prediction}" (${Math.round(p.confidence * 100)}%) → ${p.outcome}${p.error_analysis ? ' | Error: ' + p.error_analysis : ''}`).join('\n') : '(no verified predictions yet)'}

INVESTIGATION RESULTS:
${investigations.length > 0 ? JSON.stringify(investigations).slice(0, 1500) : '(none)'}

WORLD NARRATIVE (excerpt):
${narrative || '(not available)'}

ALREADY PENDING (do NOT repeat these):
${existingQs.map((q: any) => q.question).join('\n') || '(none)'}

Respond ONLY with a JSON array. Each item: {"question": "...", "category": "strategic|clarification|prediction_review|priority", "project": "ProjectName or null", "entity": "PersonName or null", "context": "why you're asking — what data prompted this", "priority": "high|medium|low"}

Rules:
- 3-5 questions, no more
- Each must be specific and actionable — not vague
- Priority "high" only for questions blocking decisions
- Skip prediction_review if no errors in data
- If everything looks clear, return fewer questions`;

    const raw = await callClaude(prompt, 120000);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { task: '21-question-generator', status: 'skipped', duration_seconds: (Date.now() - start) / 1000, output: { reason: 'no valid JSON response' } };
    }

    const questions = JSON.parse(jsonMatch[0]);
    const { v4: uuidv4 } = await import('uuid');
    let stored = 0;

    for (const q of questions.slice(0, 5)) {
      if (!q.question || !q.category) continue;
      // Skip near-duplicates of existing pending questions
      if (existingSet.has((q.question || '').toLowerCase().slice(0, 50))) continue;

      db.prepare(`INSERT INTO prime_questions (id, question, category, project, entity, context, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(uuidv4(), q.question, q.category, q.project || null, q.entity || null, q.context || null, q.priority || 'medium');
      stored++;
    }

    // Store pending questions in graph_state for API
    const pending = db.prepare("SELECT id, question, category, project, entity, context, priority, created_at FROM prime_questions WHERE status = 'pending' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT 10").all();
    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('pending_questions', ?, datetime('now'))").run(JSON.stringify(pending));

    return { task: '21-question-generator', status: 'success', duration_seconds: (Date.now() - start) / 1000, output: { generated: stored, total_pending: pending.length } };
  } catch (err: any) {
    return { task: '21-question-generator', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 22: Memory Consolidation ─────────────────────────────
// KAIROS-inspired autoDream: fight context entropy by deduplicating,
// archiving stale noise, detecting contradictions, and promoting
// corroborated facts. Pure SQL — no LLM calls.

async function task22MemoryConsolidation(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // ── Step 1: Deduplicate ─────────────────────────────────────
    // Find TRUE duplicates: same source_ref (not just same title).
    // Same source_ref = same underlying content extracted multiple times.
    // Keep the one with the longest content.
    const dupes = db.prepare(`
      SELECT k1.id as keep_id, k2.id as dupe_id
      FROM knowledge k1
      JOIN knowledge k2 ON k1.id < k2.id
        AND k1.source_ref = k2.source_ref
      WHERE length(coalesce(k1.raw_content, k1.summary, '')) >= length(coalesce(k2.raw_content, k2.summary, ''))
    `).all() as { keep_id: string; dupe_id: string }[];

    let deduped = 0;
    for (const d of dupes) {
      // Remove associated mentions/thread_items first (FK cascade may not cover all)
      db.prepare('DELETE FROM entity_mentions WHERE knowledge_item_id = ?').run(d.dupe_id);
      db.prepare('DELETE FROM thread_items WHERE knowledge_item_id = ?').run(d.dupe_id);
      db.prepare('DELETE FROM knowledge WHERE id = ?').run(d.dupe_id);
      deduped++;
    }

    // ── Step 2: Stale item detection ────────────────────────────
    // Items older than 6 months, importance low/noise, never referenced anywhere,
    // no raw_content. Demote to 'archived' so they stop polluting search.
    const staleResult = db.prepare(`
      UPDATE knowledge SET importance = 'archived', updated_at = datetime('now')
      WHERE importance IN ('low', 'noise')
        AND source_date < datetime('now', '-6 months')
        AND raw_content IS NULL
        AND id NOT IN (SELECT knowledge_item_id FROM entity_mentions)
        AND id NOT IN (SELECT knowledge_item_id FROM thread_items)
    `).run();
    const archived = staleResult.changes;

    // ── Step 3: Contradiction detection ─────────────────────────
    // Find entities whose user_label was updated in the last 7 days.
    // Check if knowledge items still reference stale information about them.
    const recentlyUpdated = db.prepare(`
      SELECT e.id, e.canonical_name, e.user_label, e.relationship_type, e.updated_at
      FROM entities e
      WHERE e.updated_at > datetime('now', '-7 days')
        AND e.user_label IS NOT NULL
    `).all() as { id: string; canonical_name: string; user_label: string; relationship_type: string | null; updated_at: string }[];

    const contradictions: { entity: string; current_label: string; stale_item_count: number }[] = [];
    for (const ent of recentlyUpdated) {
      // Find knowledge items mentioning this entity with outdated info
      // If user_label changed, items from before the update may contain stale context
      const staleItems = db.prepare(`
        SELECT COUNT(*) as cnt FROM knowledge k
        JOIN entity_mentions em ON k.id = em.knowledge_item_id
        WHERE em.entity_id = ?
          AND k.source_date < ?
          AND k.importance NOT IN ('archived', 'noise')
          AND (k.summary LIKE '%' || ? || '%' OR k.title LIKE '%' || ? || '%')
      `).get(ent.id, ent.updated_at, ent.canonical_name, ent.canonical_name) as { cnt: number };

      if (staleItems.cnt > 0) {
        contradictions.push({
          entity: ent.canonical_name,
          current_label: ent.user_label,
          stale_item_count: staleItems.cnt,
        });
      }
    }

    // ── Step 3b: Project association conflicts ─────────────────
    // Same entity mentioned with different project associations within the same week.
    const projectConflicts = db.prepare(`
      SELECT e.canonical_name as entity,
        GROUP_CONCAT(DISTINCT k.project) as projects,
        COUNT(DISTINCT k.project) as project_count
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE k.source_date >= datetime('now', '-7 days')
        AND k.project IS NOT NULL
        AND e.user_dismissed = 0
      GROUP BY e.id
      HAVING project_count > 1
    `).all() as { entity: string; projects: string; project_count: number }[];

    for (const pc of projectConflicts) {
      contradictions.push({
        type: 'project_association_conflict',
        entity: pc.entity,
        detail: `Mentioned in ${pc.project_count} different projects this week: ${pc.projects}`,
        projects: pc.projects.split(','),
      } as any);
    }

    // ── Step 3c: Commitment state contradictions ────────────────
    // Commitments marked overdue but a sent email fulfilling them exists.
    const overdueWithEvidence = db.prepare(`
      SELECT c.id, c.text, c.owner, c.project, c.due_date,
        k.title as evidence_title, k.source_date as evidence_date
      FROM commitments c
      JOIN knowledge k ON k.source IN ('gmail', 'gmail-sent')
        AND k.source_date > c.detected_at
        AND (k.title LIKE '%' || SUBSTR(c.text, 1, 40) || '%'
          OR (c.assigned_to IS NOT NULL AND k.contacts LIKE '%' || c.assigned_to || '%'))
      WHERE c.state IN ('detected', 'overdue')
        AND c.due_date < datetime('now')
      LIMIT 20
    `).all() as any[];

    for (const oe of overdueWithEvidence) {
      contradictions.push({
        type: 'commitment_state_mismatch',
        entity: oe.owner || 'unknown',
        detail: `Commitment "${oe.text.slice(0, 80)}" marked overdue but possible fulfillment found: "${oe.evidence_title}"`,
        commitment_id: oe.id,
        evidence_date: oe.evidence_date,
      } as any);
    }

    // ── Step 3d: Entity relationship changes ────────────────────
    // Detect when an entity's relationship_type or user_label indicates a role change
    // that may affect other items (e.g., left company, changed role).
    const relationshipChanges = db.prepare(`
      SELECT e.canonical_name, e.user_label, e.relationship_type,
        COUNT(DISTINCT k.id) as affected_items,
        GROUP_CONCAT(DISTINCT k.project) as affected_projects
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE e.updated_at > datetime('now', '-7 days')
        AND e.user_label IS NOT NULL
        AND (e.user_label LIKE '%leaving%' OR e.user_label LIKE '%left%'
          OR e.user_label LIKE '%former%' OR e.user_label LIKE '%new role%'
          OR e.user_label LIKE '%transition%' OR e.user_label LIKE '%moving to%')
        AND k.source_date < e.updated_at
        AND k.importance NOT IN ('archived', 'noise')
      GROUP BY e.id
    `).all() as any[];

    for (const rc of relationshipChanges) {
      contradictions.push({
        type: 'entity_relationship_change',
        entity: rc.canonical_name,
        detail: `Status: "${rc.user_label}" — ${rc.affected_items} older items may reference stale role/affiliation`,
        affected_projects: rc.affected_projects ? rc.affected_projects.split(',') : [],
        recommended_action: `Review references to ${rc.canonical_name} in: ${rc.affected_projects || 'all projects'}`,
      } as any);
    }

    // Store contradictions in graph_state for downstream consumption
    if (contradictions.length > 0) {
      db.prepare(`
        INSERT OR REPLACE INTO graph_state (key, value, updated_at)
        VALUES ('detected_contradictions', ?, datetime('now'))
      `).run(JSON.stringify(contradictions));
    }

    // ── Step 4: Verified fact promotion ─────────────────────────
    // Find knowledge items corroborated by 3+ other items from different sources
    // (same entity + same project + within 30 days). Promote to importance='high'.
    const promotionCandidates = db.prepare(`
      SELECT k.id, k.title, k.project, k.source, COUNT(DISTINCT k2.source) as corroborating_sources
      FROM knowledge k
      JOIN entity_mentions em ON k.id = em.knowledge_item_id
      JOIN entity_mentions em2 ON em.entity_id = em2.entity_id AND em.knowledge_item_id != em2.knowledge_item_id
      JOIN knowledge k2 ON em2.knowledge_item_id = k2.id
        AND k2.source != k.source
        AND k.project IS NOT NULL AND k2.project = k.project
        AND abs(julianday(k.source_date) - julianday(k2.source_date)) < 30
      WHERE k.importance = 'normal'
      GROUP BY k.id
      HAVING corroborating_sources >= 3
    `).all() as { id: string }[];

    let promoted = 0;
    for (const c of promotionCandidates) {
      db.prepare("UPDATE knowledge SET importance = 'high', updated_at = datetime('now') WHERE id = ?").run(c.id);
      promoted++;
    }

    // ── Step 5: Context budget — cap high-priority items at 500 ──
    // Prevents context injection from growing unbounded — the dream
    // pipeline only loads critical+high items for prompts.
    let demoted = 0;
    const highCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE importance IN ('critical', 'high')").get() as any;
    if (highCount.c > 500) {
      const excess = highCount.c - 500;
      db.prepare(`
        UPDATE knowledge SET importance = 'normal', updated_at = datetime('now')
        WHERE id IN (
          SELECT id FROM knowledge
          WHERE importance = 'high'
          ORDER BY source_date ASC
          LIMIT ?
        )
      `).run(excess);
      demoted = excess;
      console.log(`    Context budget: demoted ${excess} oldest high-priority items to normal`);
    }

    // ── Step 6: Auto-expire stale staged actions ──
    // Staged actions older than 48h that are still pending → expire them
    // The intelligence cycle generates fresh actions every run
    const expiredActions = db.prepare(`
      UPDATE staged_actions SET status = 'expired', acted_at = datetime('now')
      WHERE status = 'pending' AND created_at < datetime('now', '-2 days')
    `).run();
    const actionsExpired = (expiredActions as any).changes || 0;
    if (actionsExpired > 0) {
      console.log(`    Auto-expired ${actionsExpired} stale staged actions (>48h old)`);
    }

    const stats = { deduped, archived, contradictions_found: contradictions.length, promoted, demoted, actions_expired: actionsExpired };

    return {
      task: '22-memory-consolidation',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: stats,
    };
  } catch (err: any) {
    return { task: '22-memory-consolidation', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 23: Cross-Project Pattern Detection ────────────────
// Detect patterns across projects that the user hasn't asked about:
// - Connector entities (same person in multiple projects)
// - Timeline overlaps (resource contention in the same week)
// - Commitment pile-ups (5+ commitments due in the same 3-day window)
// Pure SQL — no LLM calls.

async function task23CrossProjectPatterns(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    const patterns: any[] = [];

    // ── Pattern 1: Connector entities ─────────────────────────
    // Same entity appearing in 2+ active projects = potential connector or conflict.
    const connectors = db.prepare(`
      SELECT e.canonical_name as entity, e.user_label, e.relationship_type,
        GROUP_CONCAT(DISTINCT k.project) as projects,
        COUNT(DISTINCT k.project) as project_count,
        COUNT(DISTINCT k.id) as mention_count
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE k.project IS NOT NULL
        AND k.source_date >= datetime('now', '-30 days')
        AND k.importance NOT IN ('archived', 'noise')
        AND e.user_dismissed = 0
      GROUP BY e.id
      HAVING project_count >= 2
      ORDER BY project_count DESC, mention_count DESC
      LIMIT 15
    `).all() as any[];

    for (const c of connectors) {
      patterns.push({
        type: 'connector_entity',
        entity: c.entity,
        context: c.user_label || c.relationship_type,
        projects: c.projects.split(','),
        mention_count: c.mention_count,
        insight: `${c.entity} spans ${c.project_count} projects (${c.projects}). Decisions in one may affect the other.`,
      });
    }

    // ── Pattern 2: Timeline overlaps ──────────────────────────
    // Two or more projects with commitments/events in the same 7-day window.
    const timelineOverlaps = db.prepare(`
      SELECT c1.project as project_a, c2.project as project_b,
        c1.due_date as date_a, c2.due_date as date_b,
        c1.text as commitment_a, c2.text as commitment_b,
        c1.owner as owner_a, c2.owner as owner_b
      FROM commitments c1
      JOIN commitments c2 ON c1.id < c2.id
        AND c1.project != c2.project
        AND c1.project IS NOT NULL AND c2.project IS NOT NULL
        AND abs(julianday(c1.due_date) - julianday(c2.due_date)) <= 7
      WHERE c1.state NOT IN ('fulfilled', 'cancelled', 'archived')
        AND c2.state NOT IN ('fulfilled', 'cancelled', 'archived')
        AND c1.due_date >= datetime('now')
        AND c1.due_date <= datetime('now', '+30 days')
      ORDER BY c1.due_date ASC
      LIMIT 10
    `).all() as any[];

    const seenOverlaps = new Set<string>();
    for (const o of timelineOverlaps) {
      const key = [o.project_a, o.project_b].sort().join('|');
      if (seenOverlaps.has(key)) continue;
      seenOverlaps.add(key);
      patterns.push({
        type: 'timeline_overlap',
        projects: [o.project_a, o.project_b],
        window: `${o.date_a?.slice(0, 10)} to ${o.date_b?.slice(0, 10)}`,
        commitments: [
          { project: o.project_a, text: o.commitment_a?.slice(0, 80) },
          { project: o.project_b, text: o.commitment_b?.slice(0, 80) },
        ],
        insight: `${o.project_a} and ${o.project_b} both have deadlines in the same week. Risk of resource contention.`,
      });
    }

    // ── Pattern 3: Commitment pile-ups ────────────────────────
    // 5+ commitments due in any 3-day window in the next 30 days.
    const pileups = db.prepare(`
      SELECT DATE(c.due_date) as due_day, COUNT(*) as count,
        GROUP_CONCAT(DISTINCT c.project) as projects,
        GROUP_CONCAT(SUBSTR(c.text, 1, 50), ' | ') as commitments
      FROM commitments c
      WHERE c.state NOT IN ('fulfilled', 'cancelled', 'archived')
        AND c.due_date >= datetime('now')
        AND c.due_date <= datetime('now', '+30 days')
      GROUP BY DATE(c.due_date)
      HAVING count >= 3
      ORDER BY due_day ASC
    `).all() as any[];

    // Roll up adjacent days into windows
    let windowStart: string | null = null;
    let windowCount = 0;
    let windowProjects: Set<string> = new Set();
    let windowDays: string[] = [];

    for (const p of pileups) {
      if (!windowStart || (new Date(p.due_day).getTime() - new Date(windowDays[windowDays.length - 1]).getTime()) <= 3 * 86400000) {
        if (!windowStart) windowStart = p.due_day;
        windowCount += p.count;
        windowDays.push(p.due_day);
        for (const proj of (p.projects || '').split(',')) {
          if (proj) windowProjects.add(proj);
        }
      } else {
        if (windowCount >= 5) {
          patterns.push({
            type: 'commitment_pileup',
            window: `${windowStart} to ${windowDays[windowDays.length - 1]}`,
            count: windowCount,
            projects: Array.from(windowProjects),
            insight: `${windowCount} commitments due in ${windowDays.length} day(s). Consider rescheduling or delegating.`,
          });
        }
        windowStart = p.due_day;
        windowCount = p.count;
        windowProjects = new Set((p.projects || '').split(',').filter(Boolean));
        windowDays = [p.due_day];
      }
    }
    // Flush last window
    if (windowCount >= 5 && windowStart) {
      patterns.push({
        type: 'commitment_pileup',
        window: `${windowStart} to ${windowDays[windowDays.length - 1]}`,
        count: windowCount,
        projects: Array.from(windowProjects),
        insight: `${windowCount} commitments due in ${windowDays.length} day(s). Consider rescheduling or delegating.`,
      });
    }

    // Store in graph_state
    if (patterns.length > 0) {
      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('cross_project_patterns', ?, datetime('now'))"
      ).run(JSON.stringify(patterns));
    }

    return {
      task: '23-cross-project-patterns',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        connectors: connectors.length,
        timeline_overlaps: seenOverlaps.size,
        commitment_pileups: patterns.filter(p => p.type === 'commitment_pileup').length,
        total_patterns: patterns.length,
      },
    };
  } catch (err: any) {
    return { task: '23-cross-project-patterns', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Zero-Latency COS Brief Builder ──────────────────────────
// Runs at END of dream pipeline. Assembles a pre-built brief so the COS
// can present it instantly when the user opens Claude Desktop.
// Stored in graph_state key 'cos_ready_brief'.

async function buildCosReadyBrief(db: Database.Database): Promise<void> {
  try {
    // Primary source: intelligence cycle output (Task 24)
    const intelRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
    const actionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;

    // Calendar context
    const today = new Date().toISOString().slice(0, 10);
    const calendarItems = db.prepare(`
      SELECT title, summary, source_date FROM knowledge_primary
      WHERE source = 'calendar' AND source_date >= ? AND source_date < datetime(?, '+7 days')
      ORDER BY source_date ASC LIMIT 5
    `).all(today, today) as any[];

    const calendarNext = calendarItems.length > 0
      ? calendarItems.map((c: any) => `${c.source_date?.slice(0, 16)} — ${c.title}`).join('\n')
      : null;

    // Active decisions to respect
    const decisions = db.prepare(
      "SELECT decision, entity_name, project FROM decisions WHERE active = 1 ORDER BY created_at DESC LIMIT 5"
    ).all() as any[];

    // Assemble the brief from intelligence cycle output
    const intel = intelRaw ? JSON.parse(intelRaw) : null;
    const actions = actionsRaw ? JSON.parse(actionsRaw) : [];

    const brief = {
      generated_at: new Date().toISOString(),
      // From intelligence cycle
      headline: intel?.headline || 'Intelligence cycle has not run yet',
      the_one_thing: intel?.the_one_thing || 'Run the dream pipeline to generate intelligence',
      actions: actions.slice(0, 5), // Prioritized actions with drafts
      top_hypotheses: (intel?.hypotheses || []).slice(0, 3).map((h: any) => ({
        claim: h.claim,
        confidence: h.confidence,
        action: h.action,
      })),
      contradictions: (intel?.contradictions || []).slice(0, 3),
      // Context
      calendar_next: calendarNext,
      decisions_to_respect: decisions.map((d: any) => {
        const tag = d.entity_name ? `[${d.entity_name}]` : d.project ? `[${d.project}]` : '';
        return `${tag} ${d.decision}`.trim();
      }),
      generated_by: 'intelligence-cycle-' + new Date().toISOString().slice(0, 10),
    };

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('cos_ready_brief', ?, datetime('now'))"
    ).run(JSON.stringify(brief));

    console.log(`  COS brief: "${brief.headline.slice(0, 70)}" — ${actions.length} actions`);
  } catch (err: any) {
    console.error(`  COS brief generation failed: ${err.message?.slice(0, 100)}`);
  }
}

// ── Pipeline Runner ─────────────────────────────────────────

export async function runDreamPipeline(
  options: { quick?: boolean } = {}
): Promise<{ tasks: TaskResult[]; total_duration: number }> {
  ensureDirs();
  const db = getDb();

  // ── Three-gate trigger: prevent unnecessary dream runs ──────
  const lastDreamRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'last_dream_completed'").get() as any;
  const lastDream = lastDreamRaw ? new Date(JSON.parse(lastDreamRaw.value)) : new Date(0);
  const hoursSinceLastDream = (Date.now() - lastDream.getTime()) / 3600000;

  // Gate 1: At least 4 hours since last dream
  if (hoursSinceLastDream < 4) {
    console.log(`⏭ Dream skipped: only ${hoursSinceLastDream.toFixed(1)}h since last run (need 4h)`);
    return { tasks: [], total_duration: 0 };
  }

  // Gate 2: At least 10 new items since last dream
  const newItemCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE created_at > ?").get(lastDream.toISOString()) as any;
  if (false && newItemCount.c < 10) {
    console.log(`⏭ Dream skipped: only ${newItemCount.c} new items since last run (need 10)`);
    return { tasks: [], total_duration: 0 };
  }

  // Gate 3: Not already running (lock)
  const lockRaw = db.prepare("SELECT value FROM graph_state WHERE key = 'dream_lock'").get() as any;
  if (lockRaw) {
    const lockTime = new Date(JSON.parse(lockRaw.value));
    if (Date.now() - lockTime.getTime() < 3600000) { // Lock valid for 1 hour
      console.log('⏭ Dream skipped: another run is in progress');
      return { tasks: [], total_duration: 0 };
    }
  }

  // Acquire lock
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('dream_lock', ?, datetime('now'))").run(JSON.stringify(new Date().toISOString()));

  const start = Date.now();
  const results: TaskResult[] = [];
  const dateStr = new Date().toISOString().slice(0, 10);
  const resultsDir = join(RESULTS_DIR, dateStr);
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  console.log(`\n⚡ DREAM PIPELINE — ${new Date().toLocaleString()}\n`);

  // ── CORRECTION PROPAGATION (runs first, before anything else) ──
  console.log('  Corrections: Propagating pending corrections...');
  const corrResult = await propagatePendingCorrections(db);
  if (corrResult.propagated > 0 || corrResult.failed > 0) {
    console.log(`    ✓ Propagated ${corrResult.propagated}, failed ${corrResult.failed}`);
  } else {
    console.log(`    ○ No pending corrections`);
  }

  // ── RECURSIVE INTELLIGENCE LOOP (runs first, before data changes) ──
  console.log('  Task 15: Prediction verification (DeepSeek)...');
  const r15 = await task15PredictionVerification(db);
  results.push(r15);
  console.log(`    ${r15.status === 'success' ? '✓' : r15.status === 'skipped' ? '○' : '✗'} ${r15.status} (${r15.duration_seconds.toFixed(1)}s)${r15.output ? ` — ${JSON.stringify(r15.output).slice(0, 120)}` : ''}`);

  console.log('  Task 16: Strategic reflection (Claude)...');
  const r16 = await task16StrategicReflection(db);
  results.push(r16);
  console.log(`    ${r16.status === 'success' ? '✓' : r16.status === 'skipped' ? '○' : '✗'} ${r16.status} (${r16.duration_seconds.toFixed(1)}s)${r16.output ? ` — ${JSON.stringify(r16.output).slice(0, 120)}` : ''}`);

  // Task 01: Consolidate
  console.log('  Task 01: Consolidate new signals...');
  const r01 = await task01Consolidate(db);
  results.push(r01);
  console.log(`    ${r01.status === 'success' ? '✓' : r01.status === 'skipped' ? '○' : '✗'} ${r01.status} (${r01.duration_seconds.toFixed(1)}s)${r01.output ? ` — ${JSON.stringify(r01.output).slice(0, 100)}` : ''}`);

  // Task 02: SKIPPED — replaced by Task 06 (deep entity understanding)
  // Task 02 was shallow (stats only). Task 06 sends full context + extracted intelligence.

  // Task 03: Commitment check
  console.log('  Task 03: Check commitments...');
  const r03 = await task03CommitmentCheck(db);
  results.push(r03);
  console.log(`    ${r03.status === 'success' ? '✓' : '✗'} ${r03.status} (${r03.duration_seconds.toFixed(1)}s)${r03.output ? ` — ${JSON.stringify(r03.output).slice(0, 100)}` : ''}`);

  // Task 12: Meeting prep (skip in quick mode — wiki agents handle this)
  console.log('  Task 12: Meeting prep...');
  const r12 = options.quick
    ? { task: '12-meeting-prep', status: 'skipped' as const, duration_seconds: 0, output: { reason: 'quick mode' } }
    : await task12MeetingPrep(db);
  results.push(r12);
  console.log(`    ${r12.status === 'success' ? '✓' : r12.status === 'skipped' ? '○' : '✗'} ${r12.status} (${r12.duration_seconds.toFixed(1)}s)${r12.output ? ` — ${JSON.stringify(r12.output).slice(0, 100)}` : ''}`);

  // Task 13: Episodic extraction (skip in quick mode — wiki agents do this)
  console.log('  Task 13: Episodic memory extraction (LLM)...');
  const r13 = options.quick
    ? { task: '13-episodic', status: 'skipped' as const, duration_seconds: 0, output: { reason: 'quick mode' } }
    : await task13EpisodicExtraction(db);
  results.push(r13);
  console.log(`    ${r13.status === 'success' ? '✓' : r13.status === 'skipped' ? '○' : '✗'} ${r13.status} (${r13.duration_seconds.toFixed(1)}s)${r13.output ? ` — ${JSON.stringify(r13.output).slice(0, 100)}` : ''}`);

  // Task 17: Narrative Thread Builder (cross-source threading)
  console.log('  Task 17: Narrative thread builder (DeepSeek + Claude)...');
  const r17 = await task17ThreadBuilder(db);
  results.push(r17);
  console.log(`    ${r17.status === 'success' ? '✓' : r17.status === 'skipped' ? '○' : '✗'} ${r17.status} (${r17.duration_seconds.toFixed(1)}s)${r17.output ? ` — ${JSON.stringify(r17.output).slice(0, 120)}` : ''}`);

  // ── INTELLIGENCE LAYER (LLM-powered, skip in quick mode) ──────
  if (!options.quick) {
    // Task 06: Entity Understanding — WHO matters and WHY
    console.log('  Task 06: Entity understanding (LLM)...');
    const r06 = await task06EntityUnderstanding(db);
    results.push(r06);
    console.log(`    ${r06.status === 'success' ? '✓' : r06.status === 'skipped' ? '○' : '✗'} ${r06.status} (${r06.duration_seconds.toFixed(1)}s)${r06.output ? ` — ${JSON.stringify(r06.output).slice(0, 100)}` : ''}`);

    // Task 07: Project Understanding — WHAT's happening and WHERE it's going
    console.log('  Task 07: Project understanding (LLM)...');
    const r07 = await task07ProjectUnderstanding(db);
    results.push(r07);
    console.log(`    ${r07.status === 'success' ? '✓' : r07.status === 'skipped' ? '○' : '✗'} ${r07.status} (${r07.duration_seconds.toFixed(1)}s)${r07.output ? ` — ${JSON.stringify(r07.output).slice(0, 150)}` : ''}`);

    // Task 14: Strategic Investigation — deep dive on stalling projects
    console.log('  Task 14: Strategic investigation (LLM)...');
    const r14 = await task14Investigation(db);
    results.push(r14);
    console.log(`    ${r14.status === 'success' ? '✓' : r14.status === 'skipped' ? '○' : '✗'} ${r14.status} (${r14.duration_seconds.toFixed(1)}s)${r14.output ? ` — ${JSON.stringify(r14.output).slice(0, 150)}` : ''}`);

    // Task 18: Strategic Action Generator — what WORK should Zach do?
    // Unlike Task 14 (stalling investigation), this generates PROACTIVE work items
    // for ALL active projects: deliverables, outreach, documents, prep work.
    console.log('  Task 18: Strategic action generation (DeepSeek)...');
    const r18 = await task18StrategicActions(db);
    results.push(r18);
    console.log(`    ${r18.status === 'success' ? '✓' : r18.status === 'skipped' ? '○' : '✗'} ${r18.status} (${r18.duration_seconds.toFixed(1)}s)${r18.output ? ` — ${JSON.stringify(r18.output).slice(0, 150)}` : ''}`);

    // Task 08: Commitment Verification — WHAT's real vs stale
    console.log('  Task 08: Commitment verification (LLM)...');
    const r08 = await task08CommitmentVerification(db);
    results.push(r08);
    console.log(`    ${r08.status === 'success' ? '✓' : r08.status === 'skipped' ? '○' : '✗'} ${r08.status} (${r08.duration_seconds.toFixed(1)}s)${r08.output ? ` — ${JSON.stringify(r08.output).slice(0, 100)}` : ''}`);
  }

  // Task 10: Consistency verification (runs BEFORE world rebuild to fix derived data)
  console.log('  Task 10: Consistency verification...');
  const r10 = await task10ConsistencyVerification(db);
  results.push(r10);
  console.log(`    ${r10.status === 'success' ? '✓' : '✗'} ${r10.status} (${r10.duration_seconds.toFixed(1)}s)${r10.output ? ` — ${JSON.stringify(r10.output).slice(0, 150)}` : ''}`);

  // Task 11: Claim verification — doubt every assertion, check against reality
  console.log('  Task 11: Claim verification (LLM + search)...');
  const r11 = await task11ClaimVerification(db);
  results.push(r11);
  console.log(`    ${r11.status === 'success' ? '✓' : '✗'} ${r11.status} (${r11.duration_seconds.toFixed(1)}s)${r11.output ? ` — ${JSON.stringify(r11.output).slice(0, 150)}` : ''}`);

  // Task 19: Gap Detection — find what's MISSING (pure SQL, no LLM)
  console.log('  Task 19: Gap detection (SQL)...');
  const r19 = await task19GapDetection(db);
  results.push(r19);
  console.log(`    ${r19.status === 'success' ? '✓' : '✗'} ${r19.status} (${r19.duration_seconds.toFixed(1)}s)${r19.output ? ` — ${JSON.stringify(r19.output).slice(0, 150)}` : ''}`);

  // Task 22: Memory Consolidation — deduplicate, archive stale, detect contradictions, promote facts (pure SQL, no LLM)
  console.log('  Task 22: Memory consolidation (SQL)...');
  const r22 = await task22MemoryConsolidation(db);
  results.push(r22);
  console.log(`    ${r22.status === 'success' ? '✓' : '✗'} ${r22.status} (${r22.duration_seconds.toFixed(1)}s)${r22.output ? ` — ${JSON.stringify(r22.output).slice(0, 150)}` : ''}`);

  // Task 23: Cross-Project Pattern Detection — connector entities, timeline overlaps, commitment pileups (pure SQL, no LLM)
  console.log('  Task 23: Cross-project pattern detection (SQL)...');
  const r23 = await task23CrossProjectPatterns(db);
  results.push(r23);
  console.log(`    ${r23.status === 'success' ? '✓' : '✗'} ${r23.status} (${r23.duration_seconds.toFixed(1)}s)${r23.output ? ` — ${JSON.stringify(r23.output).slice(0, 150)}` : ''}`);

  // Task 04: Structured world rebuild (AFTER all verification — data is now clean)
  console.log('  Task 04: Rebuild structured world model...');
  const r04 = await task04WorldRebuild(db);
  results.push(r04);
  console.log(`    ${r04.status === 'success' ? '✓' : '✗'} ${r04.status} (${r04.duration_seconds.toFixed(1)}s)${r04.output ? ` — ${JSON.stringify(r04.output).slice(0, 100)}` : ''}`);

  // Relationship Momentum — SQL-only velocity scoring (no LLM)
  console.log('  Relationship momentum scoring...');
  try {
    const momentum = computeRelationshipMomentum(db);
    const accel = momentum.filter(m => m.trend === 'accelerating').length;
    const cold = momentum.filter(m => m.trend === 'cold').length;
    console.log(`    ✓ ${momentum.length} entities scored — ${accel} accelerating, ${cold} went cold`);
  } catch (err: any) {
    console.log(`    ✗ Momentum scoring failed: ${err.message?.slice(0, 100)}`);
  }

  // ── SYNTHESIS LAYER (LLM-powered, skip in quick mode) ──────
  if (!options.quick) {
    // Task 09: World Narrative — the STORY, not the data
    console.log('  Task 09: Synthesize world narrative (LLM)...');
    const r09 = await task09WorldNarrative(db);
    results.push(r09);
    console.log(`    ${r09.status === 'success' ? '✓' : '✗'} ${r09.status} (${r09.duration_seconds.toFixed(1)}s)${r09.output ? ` — ${JSON.stringify(r09.output).slice(0, 100)}` : ''}`);

    // Task 21: Strategic Question Generator — what can't the system determine alone?
    console.log('  Task 21: Strategic question generator (LLM)...');
    const r21 = await task21QuestionGenerator(db);
    results.push(r21);
    console.log(`    ${r21.status === 'success' ? '✓' : r21.status === 'skipped' ? '○' : '✗'} ${r21.status} (${r21.duration_seconds.toFixed(1)}s)${r21.output ? ` — ${JSON.stringify(r21.output).slice(0, 120)}` : ''}`);

    // Task 05: Self-audit — grade OUR OWN work
    console.log('  Task 05: Self-audit...');
    const r05 = await task05SelfAudit(db);
    results.push(r05);
    console.log(`    ${r05.status === 'success' ? '✓' : r05.status === 'skipped' ? '○' : '✗'} ${r05.status} (${r05.duration_seconds.toFixed(1)}s)${r05.output?.overall_accuracy !== undefined ? ` — accuracy: ${(r05.output.overall_accuracy * 100).toFixed(0)}%` : ''}`);
  }

  // Task 20: Deep Session Trigger — auto-launch deep sessions for stalling projects
  if (!options.quick) {
    console.log('  Task 20: Deep session trigger...');
    const r20 = await task20DeepSessionTrigger(db);
    results.push(r20);
    console.log(`    ${r20.status === 'success' ? '✓' : r20.status === 'skipped' ? '○' : '✗'} ${r20.status} (${r20.duration_seconds.toFixed(1)}s)${r20.output ? ` — ${JSON.stringify(r20.output).slice(0, 150)}` : ''}`);
  }

  // ── INTELLIGENCE CYCLE — strategic reasoning engine ──────
  // Runs AFTER all data tasks complete. Takes ALL outputs and REASONS about them.
  // This is the difference between a librarian and a strategist.
  if (!options.quick) {
    console.log('  Task 24: Intelligence cycle (situation modeling + hypothesis generation + red team)...');
    const r24 = await runIntelligenceCycle(db);
    results.push(r24);
    const r24out = r24.output || {};
    console.log(`    ${r24.status === 'success' ? '✓' : r24.status === 'skipped' ? '○' : '✗'} ${r24.status} (${r24.duration_seconds.toFixed(1)}s)`);
    if (r24.status === 'success') {
      console.log(`      Situations: ${r24out.situations} | Hypotheses: ${r24out.hypotheses_surviving}/${r24out.hypotheses_generated} survive red team`);
      console.log(`      Weak signals: ${r24out.weak_signals} | Contradictions: ${r24out.contradictions}`);
      console.log(`      Top: ${r24out.top_hypothesis}`);
      console.log(`      >>> ${r24out.the_one_thing}`);
    }
  }

  // ── AUTONOMOUS RESEARCH — the system hunts for what it needs ──
  if (!options.quick) {
    console.log('  Task 25: Autonomous research (web search for knowledge gaps)...');
    try {
      const { runAutonomousResearch } = await import('./research.js');
      const r25 = await runAutonomousResearch(db);
      results.push(r25);
      console.log(`    ${r25.status === 'success' ? '✓' : r25.status === 'skipped' ? '○' : '✗'} ${r25.status} (${r25.duration_seconds.toFixed(1)}s)`);
      if (r25.status === 'success' && r25.output) {
        console.log(`      Researched ${r25.output.questions_researched}/${r25.output.total_in_queue} questions`);
        for (const f of r25.output.findings || []) {
          console.log(`      📚 ${f.question} → ${f.confidence} confidence`);
        }
      }
    } catch (err: any) {
      console.log(`    ✗ Research failed: ${err.message?.slice(0, 100)}`);
    }
  }

  // ── PLAYBOOK EXTRACTION — distill reusable patterns from experience ──
  if (!options.quick) {
    console.log('  Task 26: Playbook extraction (distill patterns from corrections + decisions)...');
    try {
      const { extractPlaybooks } = await import('./playbooks.js');
      const r26 = await extractPlaybooks(db);
      results.push(r26);
      console.log(`    ${r26.status === 'success' ? '✓' : r26.status === 'skipped' ? '○' : '✗'} ${r26.status} (${r26.duration_seconds.toFixed(1)}s)`);
      if (r26.status === 'success' && r26.output?.titles) {
        console.log(`      📋 ${r26.output.playbooks_extracted} playbooks: ${r26.output.titles.join(', ')}`);
      }
    } catch (err: any) {
      console.log(`    ✗ Playbook extraction failed: ${err.message?.slice(0, 100)}`);
    }
  }

  // Update last dream run timestamp
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_dream_run', ?, datetime('now'))")
    .run(new Date().toISOString());

  const totalDuration = (Date.now() - start) / 1000;

  // Save results
  const summary = {
    date: dateStr,
    mode: options.quick ? 'quick' : 'full',
    total_duration_seconds: totalDuration,
    tasks: results,
    health: {
      succeeded: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    },
  };

  writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n  ────────────────────────────────────`);
  console.log(`  ✓ Dream pipeline complete: ${summary.health.succeeded}/${results.length} tasks (${totalDuration.toFixed(1)}s)`);
  if (summary.health.failed > 0) console.log(`  ⚠ ${summary.health.failed} tasks failed`);

  // ── Generate fresh briefing document ──────────────────
  try {
    console.log('  Generating briefing document...');
    const briefingPath = generateBriefingDoc(db);
    console.log(`  ✓ Briefing: ${briefingPath}`);
  } catch (err: any) {
    console.error(`  ✗ Briefing generation failed: ${err.message?.slice(0, 100)}`);
  }

  // ── Build zero-latency COS brief ──────────────────────────
  try {
    console.log('  Building COS ready brief...');
    await buildCosReadyBrief(db);
  } catch (err: any) {
    console.error(`  ✗ COS brief failed: ${err.message?.slice(0, 100)}`);
  }

  // ── Auto-execute low-risk actions (reminders, calendar blocks) ──
  try {
    const autoResults = await autoExecuteLowRisk(db);
    if (autoResults.length > 0) {
      const succeeded = autoResults.filter(r => r.success).length;
      console.log(`  ✓ Auto-executed ${succeeded}/${autoResults.length} low-risk actions (reminders, calendar)`);
      for (const r of autoResults) {
        console.log(`    ${r.success ? '✓' : '✗'} ${r.message}`);
      }
    }
  } catch (err: any) {
    console.error(`  ✗ Auto-execute failed: ${err.message?.slice(0, 100)}`);
  }

  // ── iMessage notifications DISABLED — use COS instead ──
  console.log('  ○ iMessage notifications disabled (use COS for action review)');

  // ── Release dream lock and record completion ──────────────
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_dream_completed', ?, datetime('now'))").run(JSON.stringify(new Date().toISOString()));
  db.prepare("DELETE FROM graph_state WHERE key = 'dream_lock'").run();

  // ── Clean up Terminal windows left by callClaude GUI wrapper ──
  try {
    const { execSync } = await import('child_process');
    execSync("osascript -e 'tell application \"Terminal\" to close every window' 2>/dev/null", { timeout: 5000 });
    console.log('  ✓ Terminal windows cleaned up');
  } catch (_e) {}

  console.log('');

  return { tasks: results, total_duration: totalDuration };
}
