import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type Database from 'better-sqlite3';
import { getConfig } from './db.js';

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

const BASE_INSTRUCTIONS = `You are a Prime Recall agent. You have access to the user's complete business knowledge base via MCP tools.

AVAILABLE TOOLS:
- prime_search: Search all knowledge (emails, conversations, meetings, files)
- prime_ask: AI-powered Q&A with cited sources
- prime_prep: Intelligence dossier on a person or topic
- prime_deal: Project/deal intelligence brief
- prime_alerts: Current alerts (dropped balls, overdue commitments, cold relationships)
- prime_relationships: Contact health dashboard
- prime_remember: Save your findings and reports
- prime_notify: Send notification to the user (iMessage/email by urgency)

WORKFLOW:
1. Start by gathering context with prime_search, prime_alerts, or prime_deal
2. Analyze what you find
3. Save your report via prime_remember with tags ['agent:{NAME}', 'agent-report']
4. If the user needs to act, call prime_notify with appropriate urgency
5. If you draft something, save with tags ['agent:{NAME}', 'draft']

RULES:
- Be thorough but concise
- Cite specific sources (email threads, conversations)
- Only notify for genuinely important items
- End your report with a clear "ACTION NEEDED" section if applicable`;

export const TEMPLATES: Record<string, Omit<AgentConfig, 'name' | 'created_at' | 'enabled'>> = {
  cos: {
    role: 'Chief of Staff',
    schedule: '0 7 * * *',  // 7am daily
    notify: 'high',
    prompt: `${BASE_INSTRUCTIONS.replace(/{NAME}/g, 'cos')}

YOUR ROLE: Chief of Staff
You are the user's executive function layer. Every morning:

1. Call prime_alerts — get all current alerts
2. Call prime_relationships — check who's going cold
3. Call prime_search("agent-report") — review what other agents did overnight
4. Produce a prioritized morning briefing:
   - FIRES: What needs immediate attention (overdue commitments, angry people)
   - TODAY: What's on the calendar, who to prep for
   - THIS WEEK: Upcoming deadlines and commitments
   - RELATIONSHIPS: Who needs a follow-up
   - AGENT UPDATES: What your team did since last briefing
5. Notify the user (HIGH) with a 3-line summary + "Full briefing saved to Prime Recall"`,
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

  const agent: AgentConfig = {
    name,
    role: options.role || template?.role || name,
    schedule: options.schedule || template?.schedule || '0 */4 * * *',
    project: options.project || undefined,
    notify: options.notify || template?.notify || 'normal',
    prompt: options.prompt || template?.prompt || BASE_INSTRUCTIONS.replace(/{NAME}/g, name),
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

  // Write prompt to temp file (too long for CLI args)
  const { writeFileSync, unlinkSync: unlinkTmp } = await import('fs');
  const { tmpdir } = await import('os');
  const promptPath = join(tmpdir(), `prime-agent-${name}-${Date.now()}.txt`);
  writeFileSync(promptPath, prompt);

  const claudeArgs = ['-p', `$(cat "${promptPath}")`, '--allowedTools', 'mcp__prime-recall__*'];

  if (background) {
    // Use shell to expand the cat command
    const child = spawn('sh', ['-c', `claude -p "$(cat '${promptPath}')" --allowedTools 'mcp__prime-recall__*' && rm -f '${promptPath}'`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    agent.last_run = new Date().toISOString();
    saveAgent(agent);

    return { status: 'running' };
  } else {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', `claude -p "$(cat '${promptPath}')" --allowedTools 'mcp__prime-recall__*'`], {
        timeout: 300000,
        env: { ...process.env },
      });

      agent.last_run = new Date().toISOString();
      agent.last_report = stdout.slice(0, 500);
      saveAgent(agent);

      try { unlinkTmp(promptPath); } catch {}
      return { status: 'completed', output: stdout };
    } catch (err: any) {
      try { unlinkTmp(promptPath); } catch {}
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
