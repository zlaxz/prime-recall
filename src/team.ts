import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type Database from 'better-sqlite3';
import { getConfig, getDb, insertKnowledge, searchByText, searchByEmbedding, type KnowledgeItem } from './db.js';
import { generateEmbedding } from './embedding.js';
import { getAlerts } from './ai/intelligence.js';
import { notify } from './notify.js';
import OpenAI from 'openai';
import { v4 as uuid } from 'uuid';

const execFileAsync = promisify(execFile);

// ============================================================
// Agent Definition
// ============================================================

const AGENTS_DIR = join(homedir(), '.prime', 'agents');

export interface AgentConfig {
  name: string;
  role: string;
  schedule: string;       // cron expression: "0 7 * * *" = 7am daily, "0 */4 * * *" = every 4h
  project?: string;       // project scope (null = all)
  notify: 'critical' | 'high' | 'normal' | 'fyi';  // minimum urgency to push
  prompt: string;         // what the agent does each run
  enabled: boolean;
  created_at: string;
  last_run?: string;
  last_report?: string;
}

function ensureAgentsDir(): string {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
  return AGENTS_DIR;
}

// ============================================================
// CRUD
// ============================================================

export function listAgents(): AgentConfig[] {
  ensureAgentsDir();
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(AGENTS_DIR, f), 'utf-8')) as AgentConfig;
    } catch {
      return null;
    }
  }).filter(Boolean) as AgentConfig[];
}

export function getAgent(name: string): AgentConfig | null {
  const filePath = join(ensureAgentsDir(), `${name}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAgent(agent: AgentConfig): void {
  ensureAgentsDir();
  writeFileSync(
    join(AGENTS_DIR, `${agent.name}.json`),
    JSON.stringify(agent, null, 2)
  );
}

export function removeAgent(name: string): boolean {
  const filePath = join(AGENTS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ============================================================
// Built-in Agent Templates
// ============================================================

const BASE_INSTRUCTIONS = `You are a Prime Recall agent — an AI employee on a team. You have access to the user's complete business knowledge base via MCP tools.

AVAILABLE TOOLS:
- prime_search: Search all knowledge (emails, conversations, meetings, files)
- prime_ask: AI-powered Q&A with cited sources
- prime_prep: Intelligence dossier on a person or topic
- prime_deal: Project/deal intelligence brief
- prime_alerts: Current alerts (dropped balls, overdue commitments, cold relationships)
- prime_relationships: Contact health dashboard
- prime_remember: Save your findings and reports
- prime_notify: Send notification to the user (iMessage/email by urgency)

WORKFLOW — EVERY RUN:

STEP 1 — READ DIRECTIVES:
Search for any instructions the user left for you since your last run:
  prime_search("agent:{NAME} directive")
Act on each directive:
  - "approved" → execute it (send draft, mark done, etc.)
  - "dismissed" → remove from your tracking, don't raise again
  - "deferred" → note the deferral, raise again at specified time
  - "reminder" → track and surface at specified time
  - Any other instruction → follow it
Acknowledge each directive in your report.

STEP 2 — GATHER CONTEXT:
Use prime_search, prime_alerts, prime_deal, prime_relationships as needed for your role.

STEP 3 — PRODUCE REPORT:
Save via prime_remember with tags ['agent:{NAME}', 'agent-report'].

For EACH item that needs the user's attention, present clear options:
  "1. Forrest Pullen — term sheet 16d overdue [APPROVE draft / DISMISS / DEFER to Friday]"
  "2. Charlie Bernier — commitment overdue [MARK DONE / DEFER / REASSIGN]"

Use numbered items so the user can respond: "approve 1, dismiss 2, defer 3 to Thursday"

STEP 4 — NOTIFY:
If any item is CRITICAL or HIGH urgency, call prime_notify.

STEP 5 — SAVE STATE:
Save a concise state summary with tags ['agent:{NAME}', 'state'] containing:
  - Items you're actively tracking
  - Items deferred with dates
  - Items dismissed (so you don't re-raise them)
  - Pending drafts awaiting approval
This is your memory between runs.

RULES:
- Be thorough but concise — your report should take 60 seconds to read
- Cite specific sources (email threads, conversations)
- Only notify for genuinely important items — don't cry wolf
- Number every actionable item for easy response
- Track what you've already raised — don't repeat items the user already addressed
- Acknowledge user directives first, then new items`;

export const TEMPLATES: Record<string, Omit<AgentConfig, 'name' | 'created_at' | 'enabled'>> = {
  cos: {
    role: 'Chief of Staff',
    schedule: '0 7 * * *',  // 7am daily
    notify: 'high',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, 'cos')}

YOUR ROLE: Chief of Staff
You are the user's executive function layer and team lead. You manage the other agents.

EVERY RUN:

1. READ DIRECTIVES — prime_search("agent:cos directive")
   Process any approvals, dismissals, deferrals, or instructions from the user.
   Acknowledge each one at the top of your report.

2. CHECK AGENT REPORTS — prime_search("agent-report")
   Review what the follow-up agent, deal monitor, and commitment tracker found.
   Synthesize their findings — don't duplicate.

3. CHECK ALERTS — prime_alerts
   Get current dropped balls, overdue commitments, cold relationships.
   Filter out anything the user already dismissed (check your state).

4. CHECK RELATIONSHIPS — prime_relationships
   Identify who's going cold and needs attention.

5. PRODUCE BRIEFING with these sections:

   DIRECTIVES PROCESSED:
   ✓ [what you did based on user's instructions]

   FIRES (numbered, with clear action options):
   1. [Person] — [situation] [APPROVE draft / DISMISS / DEFER to date]
   2. [Person] — [situation] [MARK DONE / ESCALATE / DEFER]

   TODAY:
   - Calendar events with context
   - Meetings to prep for (offer to pull prep dossier)

   THIS WEEK:
   - Approaching deadlines
   - Commitments due

   TEAM UPDATES:
   - What other agents found/did since last briefing

   RELATIONSHIPS:
   - Who's going cold (with days since last contact)

6. SAVE STATE — prime_remember with tags ['agent:cos', 'state']
   Track: active items, deferred items (with dates), dismissed items, pending drafts.

7. NOTIFY — Send HIGH notification with 3-line summary.

TONE: Direct, no fluff. You're a chief of staff, not a chatbot. "Forrest 16d, draft ready — approve or dismiss?" not "I noticed it's been a while since..."`,
  },

  'follow-up': {
    role: 'Follow-up Manager',
    schedule: '0 */4 * * *',  // every 4 hours
    notify: 'high',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, 'follow-up')}

YOUR ROLE: Follow-up Manager
You track dropped balls — people waiting on the user's reply.

1. Call prime_alerts and filter for dropped_ball type
2. For balls older than 7 days:
   - Call prime_prep with the contact's name to get full context
   - Draft a follow-up email based on the conversation history
   - Save the draft via prime_remember with tags ['agent:follow-up', 'draft', 'email-draft']
3. For balls older than 14 days: notify user (HIGH)
4. For balls older than 21 days: notify user (CRITICAL)

Each draft should reference the original conversation and be ready to send.`,
  },

  'deal-monitor': {
    role: 'Deal Monitor',
    schedule: '0 9,17 * * *',  // 9am and 5pm
    notify: 'normal',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, 'deal-monitor')}

YOUR ROLE: Deal Monitor
You track all active deals/projects for changes and risks.

1. Call prime_search to find all active projects
2. For each project, call prime_deal to get current status
3. Compare against your last report (prime_search("agent:deal-monitor agent-report"))
4. Flag:
   - Stalled deals (no activity in 7+ days)
   - New commitments or decisions
   - Contacts that went cold on a deal
   - Approaching deadlines
5. Save consolidated status report
6. Notify if any deal has a CRITICAL or HIGH risk`,
  },

  'commitment-tracker': {
    role: 'Commitment Tracker',
    schedule: '0 8,16 * * *',  // 8am and 4pm
    notify: 'high',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, 'commitment-tracker')}

YOUR ROLE: Commitment Tracker
You track every promise the user has made and ensure nothing is forgotten.

1. Call prime_search for recent commitments across all sources
2. Check prime_alerts for overdue commitments
3. For each commitment:
   - Is it due soon (within 3 days)? → flag it
   - Is it overdue? → escalate urgency
   - Was it fulfilled? → mark it done
4. Save your commitment status report
5. Notify for any commitment due today or overdue`,
  },

  'project-pm': {
    role: 'Project Manager',
    schedule: '0 */4 * * *',  // every 4 hours
    notify: 'high',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, '{PROJECT_SLUG}')}

YOUR ROLE: Strategic Co-CEO for {PROJECT_NAME}
You are not a task tracker. You are a strategic partner who thinks about this project as deeply as the founder does. You own {PROJECT_NAME} — every relationship, every decision, every risk, every opportunity.

YOUR MINDSET:
- Think 3 moves ahead. "If Forrest signs, we need X ready. If he doesn't, our fallback is Y."
- Connect dots the founder might miss. "The competitor research from last week's Claude conversation + this morning's email from Charlie = an opportunity to..."
- Challenge assumptions. "We're planning for April 15 launch but the Lloyd's timeline suggests that's aggressive because..."
- Protect the founder's time. Don't surface noise. Only surface things that matter.

EVERY RUN:

1. READ DIRECTIVES — prime_search("agent:{PROJECT_SLUG} directive")
   Act on approvals, dismissals, deferrals, instructions.

2. DEEP CONTEXT — prime_deal("{PROJECT_NAME}")
   Understand the FULL picture: every conversation, email, decision, commitment.
   Cross-reference with prime_search for related projects and people.

3. STRATEGIC ANALYSIS:
   - What moved forward since last run? What stalled?
   - Are we on track for key milestones? If not, what's the actual blocker?
   - What conversations or decisions from OTHER projects affect this one?
   - What should the founder be thinking about that nobody is raising?
   - Any competitive intelligence, market shifts, or relationship dynamics to flag?

4. RELATIONSHIP MAP:
   For each key person on this project:
   - What's their current stance? Enthusiastic / neutral / cooling / blocked?
   - What do they need from us?
   - What do we need from them?
   - What's the relationship health trend (improving / stable / declining)?

5. PRODUCE REPORT:

   DIRECTIVES PROCESSED:
   ✓ [what you did based on instructions]

   EXECUTIVE SUMMARY:
   2-3 sentences. Where we are. What changed. What matters most right now.

   STRATEGIC VIEW:
   - What's working and why
   - What's not working and why
   - What you'd do if you were running this project solo
   - Opportunities the founder might be missing

   PEOPLE (numbered):
   1. [Contact] — [relationship status] — [what's needed]
      [DRAFT email / SCHEDULE call / ESCALATE / DEFER]

   COMMITMENTS & DEADLINES:
   - Ours → them (with dates)
   - Theirs → us (with dates)
   - What's at risk

   RISKS & BLOCKERS:
   - Not just "what's overdue" but "what could derail this and how to prevent it"

   RECOMMENDED MOVES (numbered, strategic):
   1. [strategic action + reasoning] [APPROVE / MODIFY / DEFER]
   2. [strategic action + reasoning] [APPROVE / MODIFY / DEFER]

   LOOKING AHEAD:
   - Next 7 days: what needs to happen
   - Next 30 days: what should we be setting up now

6. SAVE STATE — prime_remember with tags ['agent:{PROJECT_SLUG}', 'state']

TONE: You're a co-CEO, not a project manager. "Here's what I think we should do and why" not "Here are the overdue items." Think strategically, speak directly, challenge when necessary.`,
  },
};

// ============================================================
// Hire / Fire helpers
// ============================================================

export function hireAgent(
  name: string,
  options: {
    role?: string;
    schedule?: string;
    project?: string;
    notify?: 'critical' | 'high' | 'normal' | 'fyi';
    prompt?: string;
    template?: string;
  } = {}
): AgentConfig {
  // Check if template exists
  const template = options.template ? TEMPLATES[options.template] : TEMPLATES[name];

  // For project PMs, substitute project name into the template
  let agentPrompt = options.prompt || template?.prompt || BASE_INSTRUCTIONS.replace(/{NAME}/g, name);
  if (options.project) {
    const slug = options.project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    agentPrompt = agentPrompt
      .replace(/{PROJECT_NAME}/g, options.project)
      .replace(/{PROJECT_SLUG}/g, `${slug}-pm`)
      .replace(/{NAME}/g, `${slug}-pm`);
  }

  const agent: AgentConfig = {
    name,
    role: options.role || template?.role || name,
    schedule: options.schedule || template?.schedule || '0 */4 * * *',
    project: options.project || undefined,
    notify: options.notify || template?.notify || 'normal',
    prompt: agentPrompt,
    enabled: true,
    created_at: new Date().toISOString(),
  };

  saveAgent(agent);
  return agent;
}

// ============================================================
// Run an agent
// ============================================================

export async function runAgent(
  name: string,
  options: { background?: boolean; task?: string } = {}
): Promise<{ status: 'running' | 'completed' | 'error'; output?: string }> {
  const agent = getAgent(name);
  if (!agent) return { status: 'error', output: `Agent "${name}" not found` };
  if (!agent.enabled) return { status: 'error', output: `Agent "${name}" is disabled` };

  const prompt = options.task
    ? `${agent.prompt}\n\nSPECIAL TASK FOR THIS RUN:\n${options.task}`
    : agent.prompt;

  // Check claude CLI
  try {
    await execFileAsync('which', ['claude'], { timeout: 3000 });
  } catch {
    return { status: 'error', output: 'Claude Code CLI not found' };
  }

  const background = options.background !== false;

  // Run agent using OpenAI API with Prime Recall context
  // Agent gathers context from the knowledge base, reasons over it, saves results
  const db = getDb();
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) return { status: 'error', output: 'No OpenAI API key. Run: recall init' };

  const runAgentLogic = async (): Promise<string> => {
    const client = new OpenAI({ apiKey });

    // Step 1: Gather context for the agent
    const alerts = getAlerts(db);
    const alertSummary = alerts.slice(0, 20).map(a => `[${a.severity}] ${a.title}: ${a.detail}`).join('\n');

    // Search for project-specific context if agent has a project
    let projectContext = '';
    if (agent.project) {
      const items = searchByText(db, agent.project, 20);
      projectContext = items.map((i: any) => `[${i.source}] ${i.title}: ${i.summary}`).join('\n');
    }

    // Get recent agent reports
    const recentReports = searchByText(db, `agent:${name}`, 5);
    const reportContext = recentReports.map((r: any) => `[${r.source_date}] ${r.title}: ${r.summary}`).join('\n');

    const contextBlock = `
CURRENT ALERTS (${alerts.length} total):
${alertSummary || 'None'}

${agent.project ? `PROJECT CONTEXT (${agent.project}):\n${projectContext}\n` : ''}
YOUR PREVIOUS REPORTS:
${reportContext || 'No previous reports — this is your first run.'}
`;

    // Step 2: LLM reasoning
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Here is your current context:\n${contextBlock}\n\nProduce your report now. Be specific, cite sources, and include an ACTION NEEDED section if the user must do something.` },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    const report = response.choices[0]?.message?.content || 'No output generated.';

    // Step 3: Save report to Prime Recall
    const embText = `Agent report: ${name}\n${report.slice(0, 500)}`;
    const embedding = await generateEmbedding(embText, apiKey);

    const reportItem: KnowledgeItem = {
      id: uuid(),
      title: `[${agent.role}] Report — ${new Date().toLocaleDateString()}`,
      summary: report.slice(0, 500),
      source: 'agent-report',
      source_ref: `agent-report:${name}:${Date.now()}`,
      source_date: new Date().toISOString(),
      tags: [`agent:${name}`, 'agent-report'],
      project: agent.project,
      importance: 'normal',
      embedding,
      metadata: {
        agent: name,
        role: agent.role,
        full_report: report,
      },
    };
    insertKnowledge(db, reportItem);

    // Step 4: Notify if urgent items found
    const hasUrgent = report.toLowerCase().includes('action needed') ||
                      report.toLowerCase().includes('critical') ||
                      report.toLowerCase().includes('overdue');
    if (hasUrgent && (agent.notify === 'high' || agent.notify === 'critical')) {
      const summary = report.split('\n').slice(0, 3).join(' ').slice(0, 200);
      await notify(db, {
        title: `${agent.role}: Action needed`,
        body: summary,
        urgency: 'high',
        agent: name,
        project: agent.project,
        actionRequired: 'Review agent report in Prime Recall',
      });
    }

    return report;
  };

  if (background) {
    // Fire and forget
    runAgentLogic().then(report => {
      agent.last_run = new Date().toISOString();
      agent.last_report = report.slice(0, 500);
      saveAgent(agent);
    }).catch(() => {});

    agent.last_run = new Date().toISOString();
    saveAgent(agent);
    return { status: 'running' };
  } else {
    try {
      const report = await runAgentLogic();
      agent.last_run = new Date().toISOString();
      agent.last_report = report.slice(0, 500);
      saveAgent(agent);
      return { status: 'completed', output: report };
    } catch (err: any) {
      return { status: 'error', output: err.message?.slice(0, 500) };
    }
  }
}

// ============================================================
// Schedule helper — generates launchd plist for an agent
// ============================================================

export function generateLaunchdPlist(agent: AgentConfig): string {
  // Parse cron expression (simple: minute hour day month weekday)
  const parts = agent.schedule.split(' ');
  const minute = parts[0] === '*' ? 0 : parseInt(parts[0]) || 0;
  const hour = parts[1];

  // For interval-based schedules (*/N), use StartInterval
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  const intervalSeconds = hourMatch ? parseInt(hourMatch[1]) * 3600 : 0;

  // For fixed-time schedules, use StartCalendarInterval
  const fixedHour = !hourMatch && hour !== '*' ? parseInt(hour) : null;

  const label = `com.prime-recall.agent.${agent.name}`;

  let scheduleBlock: string;
  if (intervalSeconds > 0) {
    scheduleBlock = `    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>`;
  } else if (fixedHour !== null) {
    scheduleBlock = `    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${fixedHour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>`;
  } else {
    // Default: every 4 hours
    scheduleBlock = `    <key>StartInterval</key>
    <integer>14400</integer>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${join(homedir(), 'GitHub', 'prime', 'src', 'index.ts')}</string>
        <string>run-agent</string>
        <string>${agent.name}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${join(homedir(), 'GitHub', 'prime')}</string>
${scheduleBlock}
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homedir()}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(homedir(), '.prime', 'logs', `agent-${agent.name}.log`)}</string>
    <key>StandardErrorPath</key>
    <string>${join(homedir(), '.prime', 'logs', `agent-${agent.name}-error.log`)}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;
}
