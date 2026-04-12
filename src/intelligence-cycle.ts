import type Database from 'better-sqlite3';
import { getConfig, searchByFTS } from './db.js';
import { callClaude } from './dream.js';
import { retrieveDeepContext } from './source-retrieval.js';
import { getWikiContext } from './wiki-agents.js';
import { syncAll } from './connectors/index.js';

// ============================================================
// Intelligence Cycle — Strategic Reasoning Engine
//
// Architecture: SQL context assembly + ONE deep Claude call
//
// 1. SQL: Assemble ALL pipeline outputs into a single context document
// 2. SQL: Detect anomalies, contradictions, weak signals (free, fast)
// 3. Claude (Opus via callClaude): Reason about everything holistically
// 4. SQL: Parse and store structured output
//
// This uses Claude (via Max subscription, $0) not gpt-4.1-nano.
// The entire intelligence layer is one deep reasoning call.
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

// ── Phase 1: SQL Context Assembly ────────────────────────────
// Gathers ALL outputs from the dream pipeline's perception tasks
// into one structured context document for Claude to reason about.

async function assembleContext(db: Database.Database): Promise<string> {
  const sections: string[] = [];

  // 0. USER CORRECTIONS — ABSOLUTE TRUTH (must be at top of context so LLM can't miss them)
  const corrections = db.prepare(`
    SELECT title, summary FROM knowledge
    WHERE source IN ('correction', 'manual', 'training')
    AND (title LIKE '%CORRECTION%' OR title LIKE '%TRAINING%' OR source = 'correction')
    ORDER BY source_date DESC LIMIT 20
  `).all() as any[];

  if (corrections.length > 0) {
    sections.push('## VERIFIED CORRECTIONS (ABSOLUTE — never contradict these)\n');
    for (const c of corrections) {
      sections.push('- ' + (c.title || '').slice(0, 200));
      if (c.summary && !c.summary.startsWith(c.title)) {
        sections.push('  ' + c.summary.slice(0, 300));
      }
    }
    sections.push('');
  }

  // Also load manual/training items as high-priority context
  const manualItems = db.prepare(`
    SELECT title, summary FROM knowledge
    WHERE source = 'manual' AND title NOT LIKE '%CORRECTION%' AND title NOT LIKE '%TRAINING%'
    ORDER BY source_date DESC LIMIT 10
  `).all() as any[];

  if (manualItems.length > 0) {
    sections.push('## USER-PROVIDED CONTEXT (Zach entered these directly — treat as authoritative)\n');
    for (const m of manualItems) {
      sections.push('- ' + (m.title || '').slice(0, 200));
    }
    sections.push('');
  }


  // 1. Project profiles (from Task 07)
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const profiles = JSON.parse(profilesRaw);
    sections.push('## ACTIVE PROJECTS\n');
    for (const p of profiles) {
      if (p.status === 'archived' || p.status === 'completed') continue;
      sections.push(`### ${p.project}`);
      sections.push(`Status: ${p.status} | ${p.status_reasoning || ''}`);
      sections.push(`Next action: ${p.next_action || 'none identified'}`);
      sections.push('');
    }
  }


  // 1b. GO TO THE SHELF — retrieve actual source content for active projects
  // Index cards tell us what's relevant. The shelf has the actual content.
  try {
    const activeProjects = profilesRaw ? JSON.parse(profilesRaw)
      .filter((p: any) => p.status !== 'archived' && p.status !== 'dead')
      .slice(0, 5) : [];

    for (const project of activeProjects) {
      const recentItems = db.prepare(
        'SELECT title, source, source_ref, source_date, metadata FROM knowledge WHERE project = ? AND source IN (\'gmail\', \'gmail-sent\', \'otter\', \'fireflies\') ORDER BY source_date DESC LIMIT 5'
      ).all(project.project) as any[];

      if (recentItems.length > 0) {
        const deepContent = await retrieveDeepContext(db, recentItems, 3);
        if (deepContent && deepContent.length > 100) {
          sections.push('## ACTUAL SOURCE MATERIAL: ' + project.project + '\n');
          sections.push(deepContent.slice(0, 8000));
          sections.push('');
        }
      }
    }
  } catch (err: any) {
    // Source retrieval is best-effort — don't fail the cycle
    console.log('    Source retrieval warning: ' + (err.message || '').slice(0, 80));
  }

  // 2. Entity profiles (from Task 06)
  const topEntities = db.prepare(`
    SELECT e.canonical_name, e.user_label, e.relationship_type,
      ep.communication_nature, ep.reply_expectation,
      COUNT(DISTINCT k.id) as recent_mentions,
      MAX(k.source_date) as last_seen,
      GROUP_CONCAT(DISTINCT k.project) as projects
    FROM entities e
    LEFT JOIN entity_profiles ep ON e.id = ep.entity_id
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE e.user_dismissed = 0
      AND e.canonical_name NOT LIKE '%Zach%Stock%'
      AND k.source_date >= datetime('now', '-30 days')
      AND e.user_label IS NOT NULL
      AND e.user_label NOT IN ('dismissed', 'noise', 'solicitation')
    GROUP BY e.id
    ORDER BY recent_mentions DESC
    LIMIT 20
  `).all() as any[];

  if (topEntities.length > 0) {
    sections.push('## KEY PEOPLE\n');
    for (const e of topEntities) {
      sections.push(`- **${e.canonical_name}** (${e.user_label || e.relationship_type || 'unknown'}) — ${e.recent_mentions} mentions, last seen ${e.last_seen?.slice(0, 10) || 'unknown'}, projects: ${e.projects || 'none'}`);
      if (e.communication_nature) sections.push(`  Communication: ${e.communication_nature}, reply expectation: ${e.reply_expectation || 'unknown'}`);
    }
    sections.push('');
  }

  // 3. Active commitments
  const commitments = db.prepare(`
    SELECT text, owner, project, due_date, state, assigned_to
    FROM commitments
    WHERE state NOT IN ('fulfilled', 'cancelled', 'archived')
    ORDER BY
      CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END,
      due_date ASC
    LIMIT 30
  `).all() as any[];

  if (commitments.length > 0) {
    sections.push('## OPEN COMMITMENTS\n');
    for (const c of commitments) {
      const due = c.due_date ? ` (due: ${c.due_date.slice(0, 10)})` : '';
      sections.push(`- [${c.state}] ${c.owner}: ${c.text}${due} — project: ${c.project || 'unassigned'}`);
    }
    sections.push('');
  }

  // 3b. TEAM ACTIVITY — what team members are doing (from their email/calendar)
  const teamMembers = db.prepare(
    "SELECT email, name, role FROM team_members WHERE active = 1 AND relationship_to_ceo != 'self'"
  ).all() as any[];

  if (teamMembers.length > 0) {
    sections.push('## TEAM ACTIVITY\n');
    for (const member of teamMembers) {
      const memberItems = db.prepare(`
        SELECT title, summary, source_date, project, source
        FROM knowledge
        WHERE source_account = ? AND source_date >= datetime('now', '-7 days')
        ORDER BY source_date DESC LIMIT 10
      `).all(member.email) as any[];

      const memberCommitments = db.prepare(`
        SELECT text, project, due_date, state FROM commitments
        WHERE owner LIKE ? AND state NOT IN ('fulfilled', 'cancelled', 'archived')
      `).all(`%${member.name.split(' ')[0]}%`) as any[];

      if (memberItems.length > 0 || memberCommitments.length > 0) {
        sections.push(`### ${member.name} (${member.role})`);
        sections.push(`Recent activity: ${memberItems.length} items in last 7 days`);
        for (const item of memberItems.slice(0, 5)) {
          sections.push(`  - ${item.source_date?.slice(0, 10) || '?'} [${item.source}] ${item.title?.slice(0, 100)}`);
        }
        if (memberCommitments.length > 0) {
          sections.push(`Open commitments:`);
          for (const c of memberCommitments) {
            sections.push(`  - [${c.state}] ${c.text}${c.due_date ? ' (due: ' + c.due_date.slice(0, 10) + ')' : ''}`);
          }
        }
        sections.push('');
      }
    }
  }

    // 4. World narrative (from Task 09)
  const narrativeRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'world_narrative'").get() as any)?.value;
  if (narrativeRaw) {
    sections.push('## WORLD NARRATIVE\n');
    sections.push(narrativeRaw.slice(0, 3000));
    sections.push('');
  }

  // 5. Cross-project patterns (from Task 23)
  const patternsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'cross_project_patterns'").get() as any)?.value;
  if (patternsRaw) {
    const patterns = JSON.parse(patternsRaw);
    if (patterns.length > 0) {
      sections.push('## CROSS-PROJECT PATTERNS\n');
      for (const p of patterns) {
        sections.push(`- [${p.type}] ${p.insight}`);
      }
      sections.push('');
    }
  }

  // 6. Narrative threads (from Task 17)
  const threads = db.prepare(`
    SELECT title, summary, status, item_count, updated_at
    FROM narrative_threads
    WHERE status = 'active' AND updated_at >= datetime('now', '-14 days')
    ORDER BY updated_at DESC LIMIT 15
  `).all() as any[];

  if (threads.length > 0) {
    sections.push('## ACTIVE NARRATIVE THREADS\n');
    for (const t of threads) {
      sections.push(`- **${t.title}** (${t.item_count} items, updated ${t.updated_at?.slice(0, 10)}): ${t.summary?.slice(0, 150) || ''}`);
    }
    sections.push('');
  }

  // 7. Recent staged actions (from Task 18)
  const actions = db.prepare(`
    SELECT summary, reasoning, type, source_task, status
    FROM staged_actions
    WHERE created_at >= datetime('now', '-3 days')
    ORDER BY created_at DESC LIMIT 10
  `).all() as any[];

  if (actions.length > 0) {
    sections.push('## RECENT STAGED ACTIONS\n');
    for (const a of actions) {
      sections.push(`- [${a.type}/${a.status}] ${a.summary}: ${a.reasoning?.slice(0, 100) || ''}`);
    }
    sections.push('');
  }

  // 8. Investigation results (from Task 14, stored in graph_state)
  const investigationRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'investigation_results'").get() as any)?.value;
  if (investigationRaw) {
    sections.push('## STRATEGIC INVESTIGATION RESULTS\n');
    sections.push(investigationRaw.slice(0, 3000));
    sections.push('');
  }

  // 8b. Active playbooks (reusable patterns extracted from experience)
  const playbooks = db.prepare(
    "SELECT title, summary FROM knowledge WHERE source = 'playbook' ORDER BY source_date DESC LIMIT 10"
  ).all() as any[];
  if (playbooks.length > 0) {
    sections.push('## ACTIVE PLAYBOOKS (reusable patterns — apply when situations match)\n');
    for (const pb of playbooks) {
      sections.push(`- **${pb.title}**: ${pb.summary?.slice(0, 150) || ''}`);
    }
    sections.push('');
  }

  // 9. TODAY's items — raw, unprocessed, ALL of them (not just high-importance)
  // This is critical: pipeline perception tasks may not have run yet, but the
  // intelligence cycle must see today's emails/messages regardless of classification
  const todayItems = db.prepare(`
    SELECT title, summary, source, source_date, project, raw_content
    FROM knowledge
    WHERE source_date >= datetime('now', '-24 hours')
      AND source NOT IN ('agent-notification', 'agent-report', 'briefing', 'directive')
    ORDER BY source_date DESC LIMIT 30
  `).all() as any[];

  if (todayItems.length > 0) {
    sections.push('## TODAY\'S ITEMS (LAST 24 HOURS — FRESHEST DATA, MAY NOT BE IN PIPELINE YET)\n');
    for (const item of todayItems) {
      const content = item.raw_content
        ? item.raw_content.slice(0, 500)
        : item.summary?.slice(0, 200) || '';
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 16)}] ${item.title}`);
      sections.push(`  ${content}`);
    }
    sections.push('');
  }

  // 10. Recent high-importance items (last 7 days, excluding today which is above)
  const recentItems = db.prepare(`
    SELECT title, summary, source, source_date, project
    FROM knowledge_primary
    WHERE source_date >= datetime('now', '-7 days')
      AND source_date < datetime('now', '-24 hours')
      AND importance IN ('critical', 'high')
    ORDER BY source_date DESC LIMIT 20
  `).all() as any[];

  if (recentItems.length > 0) {
    sections.push('## HIGH-IMPORTANCE ITEMS (PAST 7 DAYS)\n');
    for (const item of recentItems) {
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 10)}] ${item.title}: ${item.summary?.slice(0, 150) || ''}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Phase 2: SQL Anomaly Detection ──────────────────────────
// Pure SQL — finds weak signals, contradictions, anomalies

function detectAnomalies(db: Database.Database): string {
  const sections: string[] = [];

  // Communication anomalies — entities whose frequency changed significantly
  const anomalies = db.prepare(`
    WITH recent AS (
      SELECT e.canonical_name,
        COUNT(CASE WHEN k.source_date >= datetime('now', '-7 days') THEN 1 END) as last_week,
        COUNT(CASE WHEN k.source_date >= datetime('now', '-30 days') AND k.source_date < datetime('now', '-7 days') THEN 1 END) as prev_3weeks
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN knowledge k ON em.knowledge_item_id = k.id
      WHERE e.user_dismissed = 0
        AND e.canonical_name NOT LIKE '%Zach%Stock%'
        AND k.source_date >= datetime('now', '-30 days')
      GROUP BY e.id
      HAVING prev_3weeks >= 3
    )
    SELECT canonical_name, last_week, prev_3weeks
    FROM recent
    WHERE last_week = 0 OR CAST(last_week AS FLOAT) / (prev_3weeks / 3.0) >= 3.0
    ORDER BY ABS(CAST(last_week AS FLOAT) / NULLIF(prev_3weeks / 3.0, 0) - 1.0) DESC
    LIMIT 10
  `).all() as any[];

  if (anomalies.length > 0) {
    sections.push('## COMMUNICATION ANOMALIES\n');
    for (const a of anomalies) {
      const pattern = a.last_week === 0 ? 'WENT SILENT' : `surged ${(a.last_week / (a.prev_3weeks / 3.0)).toFixed(1)}x`;
      sections.push(`- ${a.canonical_name}: ${pattern} (${a.last_week} mentions last week vs ${a.prev_3weeks} in prior 3 weeks)`);
    }
    sections.push('');
  }

  // Commitment contradictions — active commitments from silent entities
  const contradictions = db.prepare(`
    SELECT c.text, c.owner, c.project, c.state, c.due_date,
      MAX(k.source_date) as last_comm
    FROM commitments c
    JOIN entities e ON c.owner LIKE '%' || e.canonical_name || '%'
    JOIN entity_mentions em ON e.id = em.entity_id
    JOIN knowledge k ON em.knowledge_item_id = k.id
    WHERE c.state IN ('active', 'overdue')
      AND e.user_dismissed = 0
    GROUP BY c.id
    HAVING julianday('now') - julianday(MAX(k.source_date)) > 7
    ORDER BY last_comm ASC
    LIMIT 10
  `).all() as any[];

  if (contradictions.length > 0) {
    sections.push('## CONTRADICTIONS: ACTIVE COMMITMENTS FROM SILENT ENTITIES\n');
    for (const c of contradictions) {
      const daysSilent = Math.round((Date.now() - new Date(c.last_comm).getTime()) / 86400000);
      sections.push(`- ${c.owner}: "${c.text}" (${c.state}) — but last communication was ${daysSilent} days ago`);
    }
    sections.push('');
  }

  // Stale project status — marked active but no recent items
  const profilesRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any)?.value;
  if (profilesRaw) {
    const stale: string[] = [];
    for (const p of JSON.parse(profilesRaw)) {
      if (p.status === 'accelerating' || p.status === 'active') {
        const recentCount = (db.prepare(
          "SELECT COUNT(*) as c FROM knowledge WHERE project = ? AND source_date >= datetime('now', '-7 days')"
        ).get(p.project) as any)?.c || 0;
        if (recentCount === 0) {
          stale.push(`- ${p.project}: marked "${p.status}" but 0 items in last 7 days`);
        }
      }
    }
    if (stale.length > 0) {
      sections.push('## STALE STATUS: ACTIVE PROJECTS WITH NO RECENT ACTIVITY\n');
      sections.push(...stale);
      sections.push('');
    }
  }

  // Unthreaded strategic items — potential weak signals
  const unthreaded = db.prepare(`
    SELECT title, summary, source, source_date FROM knowledge_primary
    WHERE source_date >= datetime('now', '-7 days')
      AND id NOT IN (SELECT knowledge_item_id FROM thread_items)
      AND source NOT IN ('calendar', 'agent-notification', 'agent-report', 'briefing', 'directive')
      AND (summary LIKE '%acqui%' OR summary LIKE '%restructur%' OR summary LIKE '%regulat%'
        OR summary LIKE '%confidential%' OR summary LIKE '%opportunity%' OR summary LIKE '%compet%'
        OR summary LIKE '%leaving%' OR summary LIKE '%joining%' OR summary LIKE '%pivot%')
    ORDER BY source_date DESC LIMIT 10
  `).all() as any[];

  if (unthreaded.length > 0) {
    sections.push('## POTENTIAL WEAK SIGNALS (unthreaded items with strategic keywords)\n');
    for (const item of unthreaded) {
      sections.push(`- [${item.source} ${item.source_date?.slice(0, 10)}] ${item.title}: ${item.summary?.slice(0, 150)}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Phase 3: One Deep Claude Call ────────────────────────────

const INTELLIGENCE_PROMPT = `You are a strategic intelligence analyst with COMPLETE visibility into all of Zach Stock's business operations. You have been given every signal the system has collected — project status, entity profiles, commitments, narrative threads, cross-project patterns, investigation results, communication anomalies, and contradictions.

Your job is not to summarize. Your job is to REASON. Find what the data implies that it doesn't state. Generate knowledge that doesn't exist in any individual item.

Analyze everything and produce a strategic intelligence brief. Return ONLY valid JSON:

{
  "headline": "One sentence — the single most important thing Zach needs to know RIGHT NOW",
  "the_one_thing": "The ONE specific action with the highest leverage this week. Not vague. Specific person, specific ask, specific deadline.",
  "hypotheses": [
    {
      "claim": "Clear statement of what you believe is happening",
      "type": "connection|opportunity|threat|prediction|theory_of_mind",
      "confidence": 65,
      "projects_involved": ["project names"],
      "evidence_for": ["specific evidence from the data above"],
      "evidence_against": ["what contradicts this or suggests alternatives"],
      "key_assumption": "The ONE thing that if wrong, kills this hypothesis",
      "time_sensitivity": "urgent|this_week|this_month|none",
      "action": "What to do about it",
      "verification": "How to test if this is true"
    }
  ],
  "theories_of_mind": [
    {
      "entity": "Person name",
      "knows": ["what they likely know about Zach's position"],
      "wants": ["their motivations"],
      "constraints": ["what limits them"],
      "behavior_hypothesis": "Why they're acting the way they are",
      "likely_next_move": "What they'll probably do next"
    }
  ],
  "implication_chains": [
    {
      "hypothesis": "Which hypothesis this traces",
      "first_order": "Immediate consequence",
      "second_order": "What that leads to",
      "third_order": "Strategic endgame",
      "risk": "What could break the chain",
      "critical_action": "The one thing to do if true"
    }
  ],
  "contradictions": [
    {
      "tension": "What conflicts with what",
      "resolution": "What should be done to resolve it"
    }
  ],
  "weak_signals": [
    {
      "signal": "What was detected",
      "why_it_matters": "Strategic significance"
    }
  ],
  "actions": [
    {
      "priority": 1,
      "title": "Short action title",
      "type": "call|email|prepare|decide|investigate|wait",
      "target_person": "Name or null",
      "deadline": "today|tomorrow|this_week|this_month",
      "rationale": "Why this action, why this priority, what it unlocks",
      "draft": "If type is email: full draft text in Zach's voice (direct, confident, no corporate-speak). If type is call: talking points. If type is prepare: outline of what to prepare. Otherwise null.",
      "depends_on": "What must be true or done first, or null"
    }
  ],
  "research_queue": []
}

Requirements:
GROUND RULES (read these FIRST):
- You are a REPORTER, not a strategist. Report what the DATA shows. Do not speculate.
- If you don't have evidence for something, don't say it. Silence > manufactured insight.
- Do NOT present generic industry knowledge as a discovery. If you learned it from a web search, it's background context, not breaking news.
- Research findings are LOW CONFIDENCE unless verified against Zach's actual situation. Never build an 80%+ hypothesis on a Google search result.
- Fewer, better outputs. 2 solid hypotheses > 5 speculative ones. 2 clear actions > 5 dramatic ones.
- Use CALM language. "Worth checking:" not "CRITICAL RISK." "Consider:" not "Act NOW."
- Never lecture Zach's own contacts about things they obviously know (e.g., don't tell a Lloyd's broker about Lloyd's rules).

WHAT TO PRODUCE:
- 2-4 hypotheses based on EVIDENCE IN THE DATA. Confidence must reflect actual evidence strength. No filler hypotheses.
- "The one thing" must be genuinely the highest-leverage action, not the scariest scenario.
- 2-3 ACTIONS max. Each concrete with a person and deadline. For emails, draft in Zach's voice — direct, peer-to-peer, never lecturing.
- 0-2 research questions ONLY if genuinely useful. Do NOT generate research questions just to fill the field.
- Skip implication chains, weak signals, and contradictions unless they're genuinely surprising. Empty arrays are fine.`;

// ── Main Entry Point ────────────────────────────────────────

export async function runIntelligenceCycle(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Phase 0: Force data refresh — intelligence must reason on FRESH data
    console.log('    Phase 0: Syncing all data sources (Gmail, Calendar, Claude, Cowork)...');
    try {
      const syncResults = await syncAll(db);
      const totalSynced = syncResults.reduce((s, r) => s + r.items, 0);
      console.log(`      Synced ${totalSynced} items from ${syncResults.filter(r => r.items > 0).length} sources`);
    } catch (syncErr: any) {
      console.log(`      Sync warning: ${syncErr.message?.slice(0, 100)} (continuing with existing data)`);
    }

    // Phase 1: Detect anomalies (pure SQL — grounded, fast)
    console.log('    Phase 1: Anomaly detection (SQL)...');
    const anomalyContext = detectAnomalies(db);
    console.log('      ' + anomalyContext.length + ' chars of anomaly signals');

    // Phase 2: Load corrections (absolute truth)
    const corrections = db.prepare(
      "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
    ).all() as any[];
    const correctionText = corrections.map((c: any) => '- ' + (c.title || '').slice(0, 200)).join('\n');

    // Phase 3: Build COS agent prompt — focused instructions, NOT data dump
    // The agent uses MCP tools to retrieve what it needs
    const now = new Date();
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
    const dateStr = dayName + ', ' + now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });

        // Load compiled wiki pages — these are authoritative, source-verified
    const wikiContext = getWikiContext(db);
    const hasWiki = wikiContext.length > 100 && !wikiContext.includes('No wiki pages');

const cosPrompt = [
      'You are Prime, Zach Stock\'s AI Chief of Staff at Recapture Insurance.',
      'TODAY IS: ' + dateStr + '. Use the correct day of week for ALL dates.',
      '',
      'YOUR JOB: Produce a grounded morning intelligence brief. You have tools — USE THEM.',
      '',
      'PROCESS:',
      hasWiki ? 'IMPORTANT: Wiki pages have been compiled by research agents who already read actual source material. Start by reading these — they are your primary context. Use tools only for follow-up questions or to verify changes since the wiki was last updated.' : 'No wiki pages available — use tools to research directly.',
      '',
      hasWiki ? wikiContext : '',
      '',
      '1. Call prime_get_projects to see active projects and their status',
      '2. For the top 2-3 most important projects, call prime_search to find recent activity',
      '3. For critical items, call prime_retrieve to read ACTUAL source material (emails, documents)',
      '4. Call prime_get_commitments to check what\'s overdue or due soon',
      '5. For key people involved, call prime_entity to understand the relationship',
      '6. Synthesize into a brief',
      '',
      'RULES (CRITICAL — read these):',
      '- ONLY state facts you verified by reading source material via tools',
      '- If you did not retrieve and read the actual email/document, do NOT claim to know what it says',
      '- Use MEASURED language. "Consider:" not "You MUST." "Worth noting:" not "CRITICAL RISK."',
      '- Maximum 3 actions. Fewer is better.',
      '- Tag each action: YOUR_ACTION / ALREADY_HANDLED / NEEDS_YOUR_INPUT / WATCH / DELEGATE',
      '- Include day-of-week for ALL dates (e.g., "Tuesday April 7" not just "April 7")',
      '- Do NOT speculate. Do NOT manufacture urgency. Report what IS.',
      '- Never lecture Zach\'s contacts about things they obviously know',
      '',
      corrections.length > 0 ? 'VERIFIED CORRECTIONS (ABSOLUTE — never contradict these):\n' + correctionText + '\n' : '',
      anomalyContext.length > 100 ? 'SQL-DETECTED SIGNALS (investigate these with tools):\n' + anomalyContext + '\n' : '',
      '',
      'OUTPUT FORMAT: Return ONLY this JSON at the end of your response:',
      '{',
      '  "headline": "One sentence — factual, grounded, what matters TODAY",',
      '  "the_one_thing": "The single highest-leverage action this week. Specific person, ask, deadline.",',
      '  "actions": [{"title":"...","lens":"YOUR_ACTION|ALREADY_HANDLED|NEEDS_YOUR_INPUT|WATCH|DELEGATE","target_person":"...","rationale":"...","source_verified":true}],',
      '  "project_updates": [{"project":"...","status":"what the data shows","key_fact":"..."}]',
      '}',
    ].filter(Boolean).join('\n');

    console.log('    Phase 3: COS agent reasoning (Opus with MCP tools, up to 20 turns)...');

    // Call Claude via runClaude (proxy → fallback to direct)
    const { runClaude } = await import('./utils/claude-spawn.js');
    const response = await runClaude(cosPrompt, {
      maxTurns: 20,
      timeout: 600000,
    });

    // Agent manages its own tool-use sessions

    // Phase 4: Parse and store
    console.log('    Phase 4: Parsing and storing results...');

    // Extract JSON from response — Claude may wrap in markdown, have trailing text,
    // or the token escalation may have appended continuation text after the JSON
    let brief: any;
    const jsonStart = response.indexOf('{');
    if (jsonStart === -1) throw new Error('No JSON found in response');

    // Try progressively shorter substrings from the first { to find valid JSON
    let parsed = false;
    for (let end = response.length; end > jsonStart; end--) {
      if (response[end - 1] !== '}') continue;
      try {
        brief = JSON.parse(response.slice(jsonStart, end));
        parsed = true;
        break;
      } catch (_e) {}
    }
    if (!parsed) {
      // Last resort: greedy match
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) brief = JSON.parse(jsonMatch[0]);
      else throw new Error('Could not parse JSON from response');
    }

    // ── Phase 4.5: Quality Gate — catch obvious failures before storing ──
    console.log('    Phase 4.5: Quality gate...');
    let qualityIssues: string[] = [];

    // Check 1: Actions recommending contact with someone who already responded today
    if (brief.actions) {
      const recentSenders = db.prepare(`
        SELECT DISTINCT json_extract(metadata, '$.last_from') as sender
        FROM knowledge WHERE source = 'gmail' AND source_date >= datetime('now', '-24 hours')
        AND json_extract(metadata, '$.last_from') IS NOT NULL
      `).all().map((r: any) => r.sender?.toLowerCase() || '');

      brief.actions = brief.actions.filter((a: any) => {
        if (!a.target_person) return true;
        const target = a.target_person.toLowerCase();
        // Check if this person already sent us something today
        const alreadyResponded = recentSenders.some((s: string) => s.includes(target) || target.includes(s.split(' ')[0]?.toLowerCase()));
        if (alreadyResponded && (a.type === 'email' || a.title?.toLowerCase().includes('follow up'))) {
          qualityIssues.push(`Removed "${a.title}" — ${a.target_person} already communicated today`);
          return false;
        }
        return true;
      });
    }

    // Check 2: Actions about dismissed entities
    if (brief.actions) {
      brief.actions = brief.actions.filter((a: any) => {
        if (!a.target_person) return true;
        const dismissed = db.prepare(
          "SELECT 1 FROM entities WHERE canonical_name LIKE ? AND user_dismissed = 1"
        ).get(`%${a.target_person}%`) as any;
        if (dismissed) {
          qualityIssues.push(`Removed "${a.title}" — ${a.target_person} is dismissed`);
          return false;
        }
        return true;
      });
    }

    // Check 3: Empty or malformed output
    if (!brief.headline || brief.headline.length < 10) {
      qualityIssues.push('Headline missing or too short — keeping previous');
      const prevBrief = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_brief'").get() as any)?.value;
      if (prevBrief) {
        const prev = JSON.parse(prevBrief);
        brief.headline = prev.headline;
        brief.the_one_thing = brief.the_one_thing || prev.the_one_thing;
      }
    }

    // Check 4: Duplicate actions (same title as previous cycle)
    if (brief.actions) {
      const prevActionsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'intelligence_actions'").get() as any)?.value;
      if (prevActionsRaw) {
        const prevTitles = new Set(JSON.parse(prevActionsRaw).map((a: any) => a.title?.toLowerCase()));
        const beforeCount = brief.actions.length;
        // Don't remove — just flag. Same recommendation twice might be intentional.
        for (const a of brief.actions) {
          if (prevTitles.has(a.title?.toLowerCase())) {
            qualityIssues.push(`Repeated action: "${a.title}" (was in previous cycle too)`);
          }
        }
      }
    }

    if (qualityIssues.length > 0) {
      console.log(`      Quality gate: ${qualityIssues.length} issues caught`);
      for (const issue of qualityIssues) console.log(`        - ${issue}`);
    } else {
      console.log('      Quality gate: passed');
    }

    // Store quality issues for UI display
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_quality', ?, datetime('now'))"
    ).run(JSON.stringify({ issues: qualityIssues, checked_at: new Date().toISOString() }));

    // Store everything
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
    ).run(JSON.stringify(brief));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_hypotheses', ?, datetime('now'))"
    ).run(JSON.stringify(brief.hypotheses || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('theories_of_mind', ?, datetime('now'))"
    ).run(JSON.stringify(brief.theories_of_mind || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('implication_chains', ?, datetime('now'))"
    ).run(JSON.stringify(brief.implication_chains || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('weak_signals', ?, datetime('now'))"
    ).run(JSON.stringify(brief.weak_signals || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('detected_contradictions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.contradictions || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.actions || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('research_queue', ?, datetime('now'))"
    ).run(JSON.stringify(brief.research_queue || []));

    // Track hypotheses for meta-learning
    const historyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'hypothesis_history'").get() as any)?.value;
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    for (const h of (brief.hypotheses || [])) {
      history.push({
        ...h,
        generated_at: new Date().toISOString(),
        verified: null,
      });
    }
    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('hypothesis_history', ?, datetime('now'))"
    ).run(JSON.stringify(history.slice(-100)));

    const hypCount = brief.hypotheses?.length || 0;
    const tomCount = brief.theories_of_mind?.length || 0;

    return {
      task: '24-intelligence-cycle',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: {
        context_chars: cosPrompt.length + anomalyContext.length,
        hypotheses: hypCount,
        theories_of_mind: tomCount,
        implication_chains: brief.implication_chains?.length || 0,
        contradictions: brief.contradictions?.length || 0,
        weak_signals: brief.weak_signals?.length || 0,
        headline: brief.headline,
        the_one_thing: brief.the_one_thing,
        top_hypothesis: brief.hypotheses?.[0] ? `${brief.hypotheses[0].claim} (${brief.hypotheses[0].confidence}%)` : 'none',
      },
    };
  } catch (err: any) {
    return {
      task: '24-intelligence-cycle',
      status: 'failed',
      duration_seconds: (Date.now() - start) / 1000,
      error: err.message,
    };
  }
}
