import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type Database from 'better-sqlite3';
import { OpenAI } from 'openai';
import { getConfig } from './db.js';

// ============================================================
// DeepSeek Tool-Calling Agent
//
// A reusable agent class that uses DeepSeek's function calling to:
// 1. Search the knowledge base (find relevant items)
// 2. Read actual source material (Gmail, Claude conversations, docs)
// 3. Produce structured output based on what it ACTUALLY READ
//
// Used by: wiki agents (research assistants), atom extraction,
// verification audits, ad-hoc research tasks
// ============================================================

export interface AgentOptions {
  model?: 'deepseek-chat' | 'deepseek-reasoner';
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  toolResultLimit?: number;  // max chars per tool result
}

export interface AgentResult {
  content: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  sourceRefsRead: string[];
}

const DEFAULT_OPTIONS: Required<AgentOptions> = {
  model: 'deepseek-reasoner',
  maxTurns: 100,
  maxTokens: 16000,
  temperature: 0.5,
  toolResultLimit: 12000,
};

// ── Tool Definitions ──

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search the knowledge base for items matching a query. Returns titles, summaries, dates, and source_refs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          project: { type: 'string', description: 'Filter by project name (optional)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_source_content',
      description: 'Retrieve content from a source (email thread, Claude conversation, document, cowork session). Supports modes: "full" returns full content, "summary" returns a concise summary, "search" finds relevant passages matching a query within the source. Use summary first for large sources, then search for specific sections.',
      parameters: {
        type: 'object',
        properties: {
          source_ref: { type: 'string', description: 'The source_ref from a knowledge item (e.g., "thread:abc123", "claude-artifact:xyz")' },
          mode: { type: 'string', enum: ['full', 'summary', 'search'], description: 'Retrieval mode. Default: full.' },
          search_query: { type: 'string', description: 'When mode=search, find passages matching this query.' },
          offset: { type: 'number', description: 'Start from this character position (for paginating)' },
          limit: { type: 'number', description: 'Max characters to return (default 8000)' },
        },
        required: ['source_ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_commitments',
      description: 'Get open commitments for a project or person.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project' },
          person: { type: 'string', description: 'Filter by person name' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description: 'Get upcoming calendar events.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'How many days ahead (default 7)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_entity_profile',
      description: 'Get a person\'s profile — relationship to Zach, communication patterns, projects involved in.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Person name to look up' },
        },
        required: ['name'],
      },
    },
  },
];

// ── Tool Executor ──

async function executeTool(db: Database.Database, name: string, args: any): Promise<string> {
  switch (name) {
    case 'search_knowledge': {
      const limit = args.limit || 10;
      try {
        const ftsResults = db.prepare(`
          SELECT k.title, substr(k.summary, 1, 300) as summary, k.source, k.source_date, k.source_ref, k.source_account
          FROM knowledge_fts fts
          JOIN knowledge k ON k.rowid = fts.rowid
          WHERE k.source NOT IN ('agent-report', 'agent-notification', 'briefing', 'playbook', 'cos-insight', 'verification', 'quinn-response')
          ${args.project ? "AND k.project = '" + args.project.replace(/'/g, "''") + "'" : ''}
          AND knowledge_fts MATCH ?
          ORDER BY fts.rank LIMIT ?
        `).all(args.query, limit) as any[];
        if (ftsResults.length > 0) return JSON.stringify(ftsResults);
      } catch (_e) {}
      // Fallback to LIKE
      const projectWhere = args.project ? `AND project = '${args.project.replace(/'/g, "''")}'` : '';
      const likeResults = db.prepare(`
        SELECT title, substr(summary, 1, 300) as summary, source, source_date, source_ref, source_account, provenance
        FROM knowledge
        WHERE (title LIKE ? OR summary LIKE ? OR contacts LIKE ?) ${projectWhere}
        AND source NOT IN ('agent-report', 'agent-notification', 'briefing', 'playbook', 'cos-insight', 'verification')
        ORDER BY CASE WHEN source IN ('correction', 'manual', 'training') THEN 0 WHEN provenance = 'primary' THEN 1 ELSE 2 END, source_date DESC LIMIT ?
      `).all('%' + args.query + '%', '%' + args.query + '%', '%' + args.query + '%', limit) as any[];
      return JSON.stringify(likeResults);
    }

    case 'get_source_content': {
      const ref = args.source_ref;
      const mode = args.mode || 'full';
      const offset = args.offset || 0;
      const limit = args.limit || 8000;

      let fullContent = '';

      if (ref.startsWith('thread:')) {
        try {
          const { retrieveSourceContent } = await import('./source-retrieval.js');
          const item = db.prepare('SELECT * FROM knowledge WHERE source_ref = ? LIMIT 1').get(ref) as any;
          if (!item) return 'Source not found in knowledge base.';
          const result = await retrieveSourceContent(db, item);
          if (result) fullContent = result.content;
          else return 'Could not retrieve from API.';
        } catch (e: any) {
          return 'Retrieval error: ' + (e.message || '').slice(0, 200);
        }
      } else {
        const item = db.prepare('SELECT title, summary, raw_content FROM knowledge WHERE source_ref = ?').get(ref) as any;
        if (!item) return 'Source not found.';
        fullContent = item.raw_content || item.summary || '';
      }

      if (!fullContent) return 'No content available for this source.';

      if (mode === 'summary') {
        if (fullContent.length <= 1500) return fullContent;
        return 'SOURCE SUMMARY (' + fullContent.length + ' total chars):\n\n' +
          'BEGINNING:\n' + fullContent.slice(0, 800) +
          '\n\n...[' + (fullContent.length - 1600) + ' chars omitted]...\n\n' +
          'END:\n' + fullContent.slice(-800);
      }

      if (mode === 'search' && args.search_query) {
        const query = args.search_query.toLowerCase();
        const passages: string[] = [];
        let searchIdx = 0;
        while (searchIdx < fullContent.length && passages.length < 5) {
          const found = fullContent.toLowerCase().indexOf(query, searchIdx);
          if (found === -1) break;
          const start = Math.max(0, found - 250);
          const end = Math.min(fullContent.length, found + query.length + 250);
          passages.push('...' + fullContent.slice(start, end) + '...');
          searchIdx = found + query.length;
        }
        if (passages.length === 0) return 'No passages matching "' + args.search_query + '" found (' + fullContent.length + ' chars).';
        return 'SEARCH: "' + args.search_query + '" (' + passages.length + ' found):\n\n' + passages.join('\n\n---\n\n');
      }

      if (offset > 0 || fullContent.length > limit) {
        const chunk = fullContent.slice(offset, offset + limit);
        return 'CONTENT (chars ' + offset + '-' + (offset + chunk.length) + ' of ' + fullContent.length + '):\n\n' + chunk;
      }

      return fullContent.slice(0, limit);
    }

    case 'get_commitments': {
      const where: string[] = ["state NOT IN ('fulfilled', 'cancelled', 'archived')"];
      if (args.project) where.push(`project = '${args.project.replace(/'/g, "''")}'`);
      if (args.person) where.push(`(owner LIKE '%${args.person}%' OR assigned_to LIKE '%${args.person}%')`);
      const results = db.prepare(`SELECT text, owner, state, due_date, project FROM commitments WHERE ${where.join(' AND ')} LIMIT 20`).all();
      return JSON.stringify(results);
    }

    case 'get_calendar': {
      const days = args.days || 7;
      const results = db.prepare(`
        SELECT title, summary, source_date FROM knowledge
        WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+' || ? || ' days')
        ORDER BY source_date ASC
      `).all(days) as any[];
      // Add explicit day-of-week to prevent LLM date errors
      const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const enriched = results.map((r: any) => {
        const d = new Date(r.source_date);
        return { ...r, day_of_week: dayNames[d.getDay()] };
      });
      return JSON.stringify(enriched);
    }

    case 'get_entity_profile': {
      const entity = db.prepare(`
        SELECT e.canonical_name, e.email, e.user_label, e.relationship_type,
          ep.communication_nature, ep.reply_expectation, ep.importance_to_business,
          COUNT(DISTINCT k.id) as mention_count,
          MAX(k.source_date) as last_seen,
          GROUP_CONCAT(DISTINCT k.project) as projects
        FROM entities e
        LEFT JOIN entity_profiles ep ON e.id = ep.entity_id
        LEFT JOIN entity_mentions em ON e.id = em.entity_id
        LEFT JOIN knowledge k ON em.knowledge_item_id = k.id
        WHERE e.canonical_name LIKE ?
        GROUP BY e.id
        LIMIT 1
      `).get('%' + args.name + '%') as any;
      if (!entity) return 'Entity not found: ' + args.name;
      return JSON.stringify(entity);
    }

    default:
      return 'Unknown tool: ' + name;
  }
}

// ── The Agent Class ──

export class DeepSeekAgent {
  private db: Database.Database;
  private client: OpenAI;
  private options: Required<AgentOptions>;

  constructor(db: Database.Database, options?: AgentOptions) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    const apiKey = process.env.DEEPSEEK_API_KEY || getConfig(db, 'deepseek_api_key');
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async run(prompt: string): Promise<AgentResult> {
    const start = Date.now();
    const sourceRefsRead: string[] = [];
    let toolCallCount = 0;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'user', content: prompt },
    ];

    for (let turn = 0; turn < this.options.maxTurns; turn++) {
      const response = await this.client.chat.completions.create({
        model: this.options.model,
        messages,
        tools: TOOLS,
        temperature: this.options.temperature,
        max_tokens: this.options.maxTokens,
      });

      const msg = response.choices[0].message;
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return {
          content: msg.content || '',
          turns: turn + 1,
          toolCalls: toolCallCount,
          durationMs: Date.now() - start,
          sourceRefsRead,
        };
      }

      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        toolCallCount++;

        // Track source_refs read
        if (tc.function.name === 'get_source_content' && args.source_ref) {
          if (!sourceRefsRead.includes(args.source_ref)) {
            sourceRefsRead.push(args.source_ref);
          }
        }

        const result = await executeTool(this.db, tc.function.name, args);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.slice(0, this.options.toolResultLimit),
        });
      }
    }

    // Hit max turns — return last content
    const lastMsg = messages.filter(m => (m as any).content && (m as any).role === 'assistant').pop();
    return {
      content: (lastMsg as any)?.content || 'Agent reached max turns.',
      turns: this.options.maxTurns,
      toolCalls: toolCallCount,
      durationMs: Date.now() - start,
      sourceRefsRead,
    };
  }
}

// ── Convenience: compile a wiki page for a project ──

export async function compileProjectWiki(
  db: Database.Database,
  projectName: string,
  options?: AgentOptions & { previousPage?: string; memory?: string; soul?: string }
): Promise<AgentResult> {
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  // Load corrections for this project
  const corrections = db.prepare(
    "SELECT title FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 10"
  ).all('%' + projectName + '%', '%' + projectName + '%') as any[];

  // Load research agent identity preamble
  let preamble = '';
  try {
    
    const homedir = process.env.HOME || '/Users/zachstock';
    preamble = readFileSync(homedir + '/.prime/agents/research/IDENTITY.md', 'utf-8');
  } catch (_e) {}

  const parts: string[] = [];

  if (preamble) {
    parts.push(preamble);
    parts.push('');
  }

  if (options?.soul) {
    parts.push(options.soul);
    parts.push('');
  }

  if (options?.memory) {
    parts.push('WHAT I REMEMBER FROM PREVIOUS CYCLES:');
    parts.push(options.memory);
    parts.push('');
  }

  parts.push(`Your current assignment: compile a wiki page for ${projectName}.`);
  parts.push(`TODAY IS: ${dateStr}`);
  parts.push('');
  parts.push('=== REQUIRED OUTPUT FORMAT (you MUST follow this exactly) ===');
  parts.push('Your final response MUST contain exactly TWO sections separated by the marker ---AGENT_MEMORY---');
  parts.push('');
  parts.push('SECTION 1: The wiki page (Status, Situation, Key People, Timeline, Open Items, What Zach Should Know)');
  parts.push('');
  parts.push('---AGENT_MEMORY---');
  parts.push('');
  parts.push('SECTION 2: 5-10 bullet points about what you learned researching this project:');
  parts.push('- Which search terms found the best results');
  parts.push('- Which sources were most informative');
  parts.push('- Key people and their communication patterns');
  parts.push('- Anything that surprised you or was hard to find');
  parts.push('');
  parts.push('You MUST include both sections. Do NOT stop after the wiki page. The ---AGENT_MEMORY--- section is required.');
  parts.push('=== END OUTPUT FORMAT ===');
  parts.push('');

  if (corrections.length > 0) {
    parts.push('VERIFIED CORRECTIONS (absolute truth):');
    corrections.forEach((c: any) => parts.push('- ' + c.title));
    parts.push('');
  }

  if (options?.previousPage) {
    parts.push('YOUR PREVIOUS WIKI PAGE (update it, don\'t rewrite from scratch):');
    parts.push(options.previousPage);
    parts.push('');
  }

  parts.push('You have tools to search and READ actual source material. Do NOT rely on summaries.');
  parts.push('');
  parts.push('INVESTIGATE: Search for relevant items, then READ the actual emails/documents/conversations.');
  parts.push('After investigating, compile a wiki page with: Status, Situation, Key People, Timeline (day-of-week), Open Items, What Zach Should Know.');
  parts.push('Every claim must be based on something you actually retrieved and read.');
  parts.push('Stay focused on ' + projectName + '. When you have enough information, WRITE THE PAGE.');
  parts.push('');
  parts.push('REMINDER: After the wiki page, you MUST include ---AGENT_MEMORY--- followed by your research notes. Do not end without it.');

  const agent = new DeepSeekAgent(db, options);
  return agent.run(parts.join('\n'));
}

// ── Convenience: compile a wiki page for an entity ──

export async function compileEntityWiki(
  db: Database.Database,
  entityName: string,
  options?: AgentOptions & { previousPage?: string; memory?: string }
): Promise<AgentResult> {
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const corrections = db.prepare(
    "SELECT title FROM knowledge WHERE source IN ('correction', 'manual') AND (summary LIKE ? OR title LIKE ?) ORDER BY source_date DESC LIMIT 5"
  ).all('%' + entityName + '%', '%' + entityName + '%') as any[];

  // Load research agent identity preamble
  let preamble = '';
  try {
    
    const homedir = process.env.HOME || '/Users/zachstock';
    preamble = readFileSync(homedir + '/.prime/agents/research/IDENTITY.md', 'utf-8');
  } catch (_e) {}

  const parts: string[] = [];
  if (preamble) {
    parts.push(preamble);
    parts.push('');
  }
  parts.push(`Your current assignment: compile a wiki page for the entity ${entityName}.`);
  parts.push(`TODAY IS: ${dateStr}`);
  parts.push('');
  parts.push('=== REQUIRED OUTPUT FORMAT (you MUST follow this exactly) ===');
  parts.push('Your final response MUST contain exactly TWO sections separated by the marker ---AGENT_MEMORY---');
  parts.push('');
  parts.push('SECTION 1: The wiki page (Role, Relationship to Zach, Current State, Key Facts, Recent Communication, Open Items)');
  parts.push('');
  parts.push('---AGENT_MEMORY---');
  parts.push('');
  parts.push('SECTION 2: 5-10 bullet points about what you learned researching this entity:');
  parts.push('- Which search terms found the best results');
  parts.push('- Which sources were most informative');
  parts.push('- Key communication patterns you noticed');
  parts.push('- Anything that surprised you or was hard to find');
  parts.push('');
  parts.push('You MUST include both sections. Do NOT stop after the wiki page. The ---AGENT_MEMORY--- section is required.');
  parts.push('=== END OUTPUT FORMAT ===');
  parts.push('');

  if (corrections.length > 0) {
    parts.push('VERIFIED CORRECTIONS:');
    corrections.forEach((c: any) => parts.push('- ' + c.title));
    parts.push('');
  }

  if (options?.memory) {
    parts.push('WHAT I REMEMBER FROM PREVIOUS CYCLES:');
    parts.push(options.memory);
    parts.push('');
  }

  if (options?.previousPage) {
    parts.push('YOUR PREVIOUS PAGE:');
    parts.push(options.previousPage);
    parts.push('');
  }

  parts.push('Use tools to investigate. Read actual source material. Compile a wiki page with:');
  parts.push('Role, Relationship to Zach, Current State, Key Facts, Recent Communication, Open Items.');
  parts.push('');
  parts.push('REMINDER: After the wiki page, you MUST include ---AGENT_MEMORY--- followed by your research notes. Do not end without it.');

  const agent = new DeepSeekAgent(db, { maxTurns: 50, ...options });
  return agent.run(parts.join('\n'));
}
