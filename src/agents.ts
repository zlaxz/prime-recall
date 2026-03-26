import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, getConfig, setConfig, type KnowledgeItem } from './db.js';
import { notify, type NotifyUrgency } from './notify.js';

const execFileAsync = promisify(execFile);

// ============================================================
// Agent Definitions
// ============================================================

export interface AgentDefinition {
  name: string;
  role: string;
  systemPrompt: string;
  schedule?: string;         // cron expression for persistent agents
  notifyThreshold: NotifyUrgency;  // minimum urgency to push notifications
  project?: string;          // project scope (null = all)
}

const AGENT_BASE_PROMPT = `You are a Prime Recall agent. You have access to the user's complete business knowledge base via MCP tools.

TOOLS AVAILABLE:
- prime_search: Search all knowledge (emails, conversations, meetings, files)
- prime_ask: AI-powered question answering with cited sources
- prime_prep: Intelligence dossier on a person or topic
- prime_deal: Project/deal intelligence brief
- prime_alerts: Current alerts (dropped balls, overdue commitments, cold relationships)
- prime_relationships: Contact health dashboard
- prime_remember: Save your findings and reports
- prime_notify: Send notification to the user (use sparingly, only for HIGH/CRITICAL items)

WORKFLOW:
1. Check for tasks assigned to you: prime_search("agent:{AGENT_NAME} status:pending")
2. Use prime_search/prime_deal/prime_prep to gather context
3. Do your work
4. Save your report via prime_remember with tags ['agent:{AGENT_NAME}', 'agent-report']
5. If the user needs to act, use prime_notify with appropriate urgency

RULES:
- Be thorough but concise in reports
- Cite specific sources (email threads, conversations) when referencing information
- Only use prime_notify for genuinely important items — don't cry wolf
- If you draft something (email, document), save it with tags ['agent:{AGENT_NAME}', 'draft']
- Include "ACTION NEEDED:" section if the user must do something`;

export const BUILT_IN_AGENTS: Record<string, AgentDefinition> = {
  cos: {
    name: 'cos',
    role: 'Chief of Staff',
    notifyThreshold: 'high',
    systemPrompt: `${AGENT_BASE_PROMPT.replace(/{AGENT_NAME}/g, 'cos')}

YOUR ROLE: Chief of Staff
You orchestrate the user's business life. Every run:
1. Call prime_alerts to get all current alerts
2. Call prime_relationships to check who's going cold
3. Review any pending tasks from other agents
4. Produce a prioritized briefing
5. Flag anything CRITICAL or HIGH via prime_notify

Your briefing should be actionable: "Do this first, then this, then this."
Not a summary — a plan of attack for the day.`,
  },

  'follow-up': {
    name: 'follow-up',
    role: 'Follow-up Manager',
    notifyThreshold: 'high',
    systemPrompt: `${AGENT_BASE_PROMPT.replace(/{AGENT_NAME}/g, 'follow-up')}

YOUR ROLE: Follow-up Manager
You track dropped balls — people waiting on the user's reply.
1. Call prime_alerts and filter for dropped_ball type
2. For each dropped ball older than 7 days, draft a follow-up email
3. Save each draft with tags ['agent:follow-up', 'draft', 'email-draft']
4. If any ball is 14+ days old, notify the user via prime_notify (HIGH urgency)
5. If any ball is 21+ days old, notify as CRITICAL

The user will review and approve/edit your drafts.`,
  },
};

// ============================================================
// Agent Spawner
// ============================================================

/**
 * Spawn a one-time agent that runs in the background.
 * Uses `claude -p` with Prime Recall MCP access.
 */
export async function spawnAgent(
  db: Database.Database,
  options: {
    task: string;
    agent?: string;        // Agent name (use built-in definition) or custom
    systemPrompt?: string; // Custom system prompt (overrides agent definition)
    project?: string;
    urgency?: NotifyUrgency;
    background?: boolean;  // Default true — run async
  }
): Promise<{ taskId: string; status: 'spawned' | 'completed' | 'error'; result?: string }> {
  const taskId = uuid();
  const agentName = options.agent || 'research';
  const background = options.background !== false;

  // Get agent definition or build custom
  const agentDef = BUILT_IN_AGENTS[agentName];
  const systemPrompt = options.systemPrompt || agentDef?.systemPrompt ||
    AGENT_BASE_PROMPT.replace(/{AGENT_NAME}/g, agentName);

  // Save the task to Prime Recall
  const taskItem: KnowledgeItem = {
    id: taskId,
    title: `Task: ${options.task}`,
    summary: options.task,
    source: 'task',
    source_ref: `task:${taskId}`,
    source_date: new Date().toISOString(),
    tags: ['task', `agent:${agentName}`, 'status:pending'],
    project: options.project,
    importance: options.urgency || 'normal',
    metadata: {
      task_id: taskId,
      agent: agentName,
      status: 'pending',
      spawned_at: new Date().toISOString(),
    },
  };
  insertKnowledge(db, taskItem);

  // Build the agent prompt
  const prompt = `${systemPrompt}

YOUR TASK:
${options.task}

Task ID: ${taskId}
${options.project ? `Project: ${options.project}` : ''}

Start by searching Prime Recall for relevant context, then complete the task.
When done, save your report using prime_remember with these exact tags: ['agent:${agentName}', 'agent-report', 'task:${taskId}']`;

  // Check if claude CLI is available
  let claudePath = 'claude';
  try {
    await execFileAsync('which', ['claude'], { timeout: 3000 });
  } catch {
    return { taskId, status: 'error', result: 'Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code' };
  }

  if (background) {
    // Spawn in background — don't wait for result
    const child = spawn(claudePath, ['-p', prompt, '--allowedTools', 'mcp__prime-recall__*'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: process.env.HOME || '',
        PATH: process.env.PATH || '',
      },
    });
    child.unref();

    console.log(`  Agent "${agentName}" spawned (task: ${taskId.slice(0, 8)}...)`);
    return { taskId, status: 'spawned' };
  } else {
    // Run synchronously — wait for result
    try {
      const { stdout } = await execFileAsync(claudePath, ['-p', prompt, '--allowedTools', 'mcp__prime-recall__*'], {
        timeout: 300000, // 5 min max
        env: {
          ...process.env,
          HOME: process.env.HOME || '',
          PATH: process.env.PATH || '',
        },
      });
      return { taskId, status: 'completed', result: stdout };
    } catch (err: any) {
      return { taskId, status: 'error', result: err.message?.slice(0, 500) };
    }
  }
}

/**
 * List recent agent activity from Prime Recall.
 */
export function getAgentActivity(db: Database.Database, options: { agent?: string; limit?: number } = {}): any[] {
  const limit = options.limit || 20;

  let sql = `SELECT * FROM knowledge WHERE (source = 'agent-notification' OR source = 'task' OR tags LIKE '%agent-report%') ORDER BY source_date DESC LIMIT ?`;
  const params: any[] = [limit];

  if (options.agent) {
    sql = `SELECT * FROM knowledge WHERE (source = 'agent-notification' OR source = 'task' OR tags LIKE '%agent-report%') AND tags LIKE ? ORDER BY source_date DESC LIMIT ?`;
    params.unshift(`%agent:${options.agent}%`);
  }

  const rows = db.prepare(sql).all(...params) as any[];

  for (const row of rows) {
    for (const field of ['tags', 'metadata', 'contacts', 'commitments', 'decisions']) {
      if (row[field] && typeof row[field] === 'string') {
        try { row[field] = JSON.parse(row[field]); } catch {}
      }
    }
  }

  return rows;
}
