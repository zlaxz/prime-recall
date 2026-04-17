import type Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Quinn Agent — A persistent, tool-using Chief of Staff
 *
 * Unlike the intelligence cycle (single prompt → JSON brief),
 * Quinn is a claude -p --resume session who:
 * 1. Reads FOCUS.md (what she already knows)
 * 2. Searches for what's new since last cycle
 * 3. Follows threads that interest her
 * 4. Goes to the shelf (prime_retrieve) to read actual emails
 * 5. Updates FOCUS.md with what she learned
 * 6. Produces a brief for Zach
 *
 * She accumulates context across cycles via --resume.
 * She decides what to investigate, not the pipeline.
 */

// Generate a fresh session ID for each cycle for now.
// TODO: Switch to persistent --resume once we verify tool calls work reliably.
const QUINN_SESSION_ID = undefined; // Fresh session each cycle

interface QuinnResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output: any;
}

export async function runQuinnAgent(db: Database.Database): Promise<QuinnResult> {
  const start = Date.now();
  const homedir = process.env.HOME || '';

  try {
    // Load Quinn's persistent state
    let focus = '';
    try { focus = readFileSync(join(homedir, '.prime', 'FOCUS.md'), 'utf-8'); } catch {}

    // Load corrections (absolute truth)
    const corrections = db.prepare(
      "SELECT title FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
    ).all() as any[];

    // Load Quinn's identity
    let soul = '';
    try { soul = readFileSync(join(homedir, '.prime', 'agents', 'cos', 'SOUL.md'), 'utf-8'); } catch {}

    // What's new since last cycle? Count by source
    const lastCycle = focus.match(/Updated: (.+)/)?.[1] || new Date(Date.now() - 4 * 3600000).toISOString();
    const newItems = db.prepare(`
      SELECT source, COUNT(*) as c FROM knowledge
      WHERE source_date > ? AND source IN ('gmail', 'gmail-sent', 'calendar', 'claude', 'cowork')
      GROUP BY source
    `).all(lastCycle) as any[];
    const newSummary = newItems.map((n: any) => `${n.source}: ${n.c} new`).join(', ') || 'nothing new';

    // Build Quinn's prompt — NOT a data dump. Instructions + state + tools.
    const now = new Date();
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];
    const dateStr = `${dayName}, ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" })}`;

    const prompt = [
      soul ? soul.slice(0, 3000) : 'You are Quinn Parker, AI Chief of Staff to Zach Stock at Recapture Insurance.',
      '',
      `TODAY IS: ${dateStr}`,
      '',
      '## YOUR WORKING STATE',
      focus || '(First cycle — no prior state)',
      '',
      `## WHAT'S NEW SINCE LAST CYCLE`,
      newSummary,
      '',
      corrections.length > 0 ? `## CORRECTIONS (absolute truth)\n${corrections.map((c: any) => `- ${c.title}`).join('\n')}` : '',
      '',
      '## YOUR TASK',
      '',
      'You are starting your work cycle. You have tools to investigate:',
      '- prime_search: find items about a topic, person, or project',
      '- prime_retrieve: go to the SHELF and read the actual email/document (not a summary)',
      '- prime_entity: get a person\'s full profile',
      '- prime_get_commitments: check overdue/active commitments',
      '- prime_get_projects: list active projects',
      '- prime_alerts: check for urgent items',
      '',
      'YOUR PROCESS:',
      '',
      'PHASE 1 — INVESTIGATE:',
      '1. Read your working state above. What were you tracking? What needs follow-up?',
      '2. Check what\'s new. Search for items related to your active concerns.',
      '3. When something looks important, RETRIEVE THE ACTUAL EMAIL and read it. Do not reason from summaries.',
      '4. Follow threads. If Forrest emailed about rates, find out who he sent them to and what happened.',
      '5. Think strategically. Connect dots across projects and people.',
      '',
      'PHASE 2 — CHALLENGE YOUR OWN THINKING:',
      'Before producing any output, stop and interrogate every conclusion you are about to present:',
      '',
      'For each action or claim, ask yourself:',
      '- WHO actually owns this? Search for the direct communications. If I say "Forrest should do X," have I verified that Forrest is the one communicating with that person? Or is Zach handling it directly?',
      '- WHAT is the evidence chain? Can I trace this claim to a specific email I retrieved and read? If I only read a summary or PM report, I do NOT have evidence — I have hearsay.',
      '- WHERE did this assumption come from? Am I repeating what a previous cycle\'s FOCUS.md said, or did I verify it fresh? Prior cycles could be wrong.',
      '- WHEN was the last actual communication? If I\'m flagging something as urgent but the last email was 3 weeks ago, is it really urgent or am I manufacturing urgency?',
      '- WHY would this be true? Does my conclusion make logical sense given what I know about the relationships? If Person A has been talking directly to Person B, why would I assign the task to Person C?',
      '',
      'The most dangerous errors are ATTRIBUTION errors — assigning actions to the wrong person because a PM report mentioned them in the same paragraph. Go to the shelf and check WHO is actually in the email thread before assigning ownership.',
      '',
      'If you cannot trace a claim to a specific email you retrieved, DELETE the claim. Silence is better than confident bullshit.',
      '',
      'PHASE 3 — OUTPUT:',
      'Only after challenging your thinking, produce your brief.',
      '',
      'OUTPUT: At the end, output TWO things:',
      '',
      '1. FOCUS_UPDATE: (this will be written to FOCUS.md)',
      '```focus',
      '# Quinn\'s Working State',
      'Updated: [now]',
      '',
      '## The One Thing',
      '[highest leverage action]',
      '',
      '## What I Found This Cycle (VERIFIED — I read the actual email)',
      '[Only things you retrieved and read via prime_retrieve. Each item must have [thread:ID].]',
      '',
      '## What I Think But Haven\'t Verified',
      '[Inferences, assumptions, things from prior cycles or summaries you did NOT verify this cycle. Be explicit about uncertainty. "I THINK X because Y, but I haven\'t read the actual thread."]',
      '',
      '## Active Concerns',
      '[ranked, with what you KNOW (verified) vs what you ASSUME (unverified)]',
      '',
      '## Threads I\'m Following',
      '[specific threads/topics you want to investigate next cycle]',
      '',
      '## Cycle Log',
      '[one line: what this cycle produced]',
      '```',
      '',
      '2. BRIEF: (JSON for the system)',
      '```json',
      '{"headline":"...","the_one_thing":"...","actions":[{"title":"...","lens":"...","rationale":"..."}],"project_updates":[{"project":"...","status":"..."}]}',
      '```',
      '',
      'RULES:',
      '- Go to the shelf. Read actual emails via prime_retrieve. Do not reason from summaries.',
      '- Follow threads. If you see something interesting, search deeper.',
      '- Measured language. Report what IS, not what might be.',
      '- Maximum 3 actions. Fewer is better. Zero is fine if nothing is genuinely actionable.',
      '- Be curious. You are a strategic partner, not a report generator.',
      '- VERIFY OWNERSHIP: Before saying "Person X should do Y," search for emails between X and the relevant party. If Zach has been handling it directly, it\'s Zach\'s item, not a delegation.',
      '- KILL YOUR DARLINGS: If Phase 2 reveals a claim is ungrounded, remove it entirely. Do not soften it with "possibly" or "likely." Remove it.',
      '- CITE OR DELETE: Every factual claim in your output must trace to a specific email you retrieved. [thread:ID] or similar. No citation = delete the claim.',
    ].filter(Boolean).join('\n');

    console.log(`    Quinn agent starting (${Math.round(prompt.length / 1000)}K prompt, persistent session)...`);

    // Run as persistent session with unlimited turns
    const { runClaude } = await import('./utils/claude-spawn.js');
    const response = await runClaude(prompt, {
      model: 'claude-opus-4-7', // Strategic reasoning — best model available
      sessionId: QUINN_SESSION_ID,
      maxTurns: 200,
      timeout: 900000, // 15 minutes
    });

    // Save cycle output
    const cycleDir = join(homedir, '.prime', 'cycles');
    mkdirSync(cycleDir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 13).replace(/[T:]/g, '-');
    writeFileSync(join(cycleDir, `quinn-${ts}.md`), `# Quinn Agent Cycle — ${dateStr}\n\n${response}`);

    // Extract FOCUS_UPDATE and write to FOCUS.md
    const focusMatch = response.match(/```focus\n([\s\S]*?)```/);
    if (focusMatch) {
      writeFileSync(join(homedir, '.prime', 'FOCUS.md'), focusMatch[1].trim());
      console.log('    ✓ FOCUS.md updated by Quinn');
    }

    // Extract JSON brief
    let brief: any = {};
    const jsonMatch = response.match(/```json\n([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        brief = JSON.parse(jsonMatch[1]);
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
        ).run(JSON.stringify(brief));
        console.log('    ✓ Brief stored');
      } catch {}
    }

    const duration = (Date.now() - start) / 1000;
    console.log(`    ✓ Quinn cycle complete (${duration.toFixed(0)}s)`);

    return {
      task: 'quinn-agent',
      status: 'success',
      duration_seconds: duration,
      output: {
        headline: brief.headline || '',
        actions: (brief.actions || []).length,
        focus_updated: !!focusMatch,
        response_length: response.length,
      },
    };

  } catch (err: any) {
    console.log(`    ✗ Quinn agent failed: ${err.message?.slice(0, 100)}`);
    return {
      task: 'quinn-agent',
      status: 'failed',
      duration_seconds: (Date.now() - start) / 1000,
      output: { error: err.message?.slice(0, 200) },
    };
  }
}
