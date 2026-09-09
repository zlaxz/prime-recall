import type Database from 'better-sqlite3';
import { OpenAI } from 'openai';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getConfig } from './db.js';
import { resolveDeepseekKey } from './ai/providers.js';

// ============================================================
// SOUL.md Mutation Pipeline
//
// When a user correction comes in, automatically update the
// relevant agent's identity file with:
// 1. A new incident log entry
// 2. A NEVER rule (if the correction implies one)
//
// Uses DeepSeek Chat (cheap, fast) to generate the patch.
// ============================================================

const AGENTS_DIR = join(homedir(), '.prime', 'agents');

const PROJECT_TO_AGENT: Record<string, string> = {
  'carefront': 'carefront-pm',
  'foresite': 'foresite-pm',
  'research': 'research',
};

interface Correction {
  claim: string;
  correction: string;
  project?: string | null;
}

interface MutationResult {
  timestamp: string;
  agent: string;
  soulPath: string;
  incident: string;
  rule: string | null;
  correction: Correction;
}

/**
 * Resolve the SOUL/IDENTITY file path for an agent.
 * Research agent uses IDENTITY.md, others use SOUL.md.
 */
function getSoulPath(agentDir: string): string {
  const identity = join(agentDir, 'IDENTITY.md');
  if (existsSync(identity)) return identity;
  return join(agentDir, 'SOUL.md');
}

/**
 * Map a correction's project field to agent directory names.
 * Always includes 'cos' (Quinn) since she reads all wiki pages.
 */
function getTargetAgents(project?: string | null): string[] {
  const agents = new Set<string>();
  agents.add('cos'); // Quinn always gets corrections

  if (project) {
    const normalized = project.toLowerCase().trim();
    for (const [key, agent] of Object.entries(PROJECT_TO_AGENT)) {
      if (normalized.includes(key)) {
        agents.add(agent);
      }
    }
  }

  return Array.from(agents);
}

/**
 * Call DeepSeek Chat to generate an incident log entry and optional NEVER rule.
 */
async function generatePatch(
  client: OpenAI,
  correction: Correction,
  existingIncidents: string
): Promise<{ incident: string; rule: string | null }> {
  const today = new Date().toISOString().split('T')[0];

  const response = await client.chat.completions.create({
    model: 'deepseek-chat',
    temperature: 0.3,
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `You are updating an AI agent's identity file based on a user correction. Be concise and precise.

Generate TWO things:
1. INCIDENT: A one-line incident log entry. Format: (${today}) What happened -- lesson learned.
2. RULE: A behavioral NEVER rule if appropriate, or "NONE" if the correction is purely factual.

The incident should capture what went wrong and why. The rule should prevent recurrence.

Respond in EXACTLY this format:
INCIDENT: (${today}) ...
RULE: ... (or RULE: NONE)`,
      },
      {
        role: 'user',
        content: `CORRECTION:
Claim: ${correction.claim}
Correction: ${correction.correction}
Project: ${correction.project || 'general'}

CURRENT INCIDENT LOG:
${existingIncidents || '(empty)'}`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content || '';

  // Parse the response
  const incidentMatch = text.match(/INCIDENT:\s*(.+)/);
  const ruleMatch = text.match(/RULE:\s*(.+)/);

  const incident = incidentMatch?.[1]?.trim() || `(${today}) Correction: ${correction.correction.slice(0, 100)}`;
  const ruleRaw = ruleMatch?.[1]?.trim();
  const rule = ruleRaw && ruleRaw !== 'NONE' ? ruleRaw : null;

  return { incident, rule };
}

/**
 * Extract the incident log section from a SOUL/IDENTITY file.
 */
function extractIncidentLog(content: string): string {
  const match = content.match(/## 8\. Incident Log\s*\n([\s\S]*?)(?=\n## |\n---|\Z)/);
  return match?.[1]?.trim() || '';
}

/**
 * Apply the incident + rule to a SOUL/IDENTITY file.
 */
function applySoulPatch(
  filePath: string,
  incident: string,
  rule: string | null
): void {
  let content = readFileSync(filePath, 'utf-8');

  // Append incident to Incident Log section
  const incidentLogPattern = /(## 8\. Incident Log\s*\n)([\s\S]*?)(\n## |\n---|$)/;
  const incidentLogMatch = content.match(incidentLogPattern);

  if (incidentLogMatch) {
    const [fullMatch, header, body, next] = incidentLogMatch;
    const newBody = body.trimEnd() + '\n- ' + incident + '\n';
    content = content.replace(fullMatch, header + newBody + next);
  } else {
    // No incident log section found -- append one at the end
    content = content.trimEnd() + '\n\n## 8. Incident Log\n\n- ' + incident + '\n';
  }

  // Append NEVER rule if generated
  if (rule) {
    const neverPattern = /(### NEVER\s*\n)([\s\S]*?)(\n### |\n## |\n---|$)/;
    const neverMatch = content.match(neverPattern);

    if (neverMatch) {
      const [fullMatch, header, body, next] = neverMatch;
      const newBody = body.trimEnd() + '\n- ' + rule + '\n';
      content = content.replace(fullMatch, header + newBody + next);
    } else {
      // No NEVER section -- insert before incident log
      const incidentIdx = content.indexOf('## 8. Incident Log');
      if (incidentIdx > -1) {
        content = content.slice(0, incidentIdx) + '### NEVER\n\n- ' + rule + '\n\n' + content.slice(incidentIdx);
      } else {
        content = content.trimEnd() + '\n\n### NEVER\n\n- ' + rule + '\n';
      }
    }
  }

  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Log the mutation to graph_state for observability.
 */
function logMutation(db: Database.Database, result: MutationResult): void {
  const raw = (db.prepare(
    "SELECT value FROM graph_state WHERE key = 'soul_mutations'"
  ).get() as any)?.value;

  const mutations: MutationResult[] = raw ? JSON.parse(raw) : [];
  mutations.push(result);

  // Keep last 100 mutations
  const trimmed = mutations.slice(-100);

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('soul_mutations', ?, datetime('now'))"
  ).run(JSON.stringify(trimmed));
}

/**
 * Main entry point: mutate SOUL.md files based on a user correction.
 *
 * 1. Maps correction to target agents
 * 2. Generates patch via DeepSeek Chat
 * 3. Applies patch to each agent's identity file
 * 4. Logs the mutation
 */
export async function mutateSoulFromCorrection(
  db: Database.Database,
  correction: Correction
): Promise<MutationResult[]> {
  const apiKey = resolveDeepseekKey() || getConfig(db, 'deepseek_api_key');
  if (!apiKey) {
    console.warn('[soul-mutation] No DEEPSEEK_API_KEY -- skipping SOUL mutation');
    return [];
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
  });

  const targetAgents = getTargetAgents(correction.project);
  const results: MutationResult[] = [];

  for (const agentName of targetAgents) {
    const agentDir = join(AGENTS_DIR, agentName);
    const soulPath = getSoulPath(agentDir);

    if (!existsSync(soulPath)) {
      console.warn(`[soul-mutation] No identity file at ${soulPath} -- skipping`);
      continue;
    }

    const content = readFileSync(soulPath, 'utf-8');
    const existingIncidents = extractIncidentLog(content);

    // Generate patch via DeepSeek
    const { incident, rule } = await generatePatch(client, correction, existingIncidents);

    // Apply the patch
    applySoulPatch(soulPath, incident, rule);

    const result: MutationResult = {
      timestamp: new Date().toISOString(),
      agent: agentName,
      soulPath,
      incident,
      rule,
      correction,
    };

    logMutation(db, result);
    results.push(result);

    console.log(`[soul-mutation] Updated ${agentName}: ${incident}${rule ? ' | RULE: ' + rule : ''}`);
  }

  return results;
}
