import type Database from 'better-sqlite3';
import { getConfig } from './db.js';

// ============================================================
// Intelligence Cycle v2 — Full Context Opus 1M Reasoning
//
// Instead of making an agent search for data with tools,
// load EVERYTHING into a single Opus 1M prompt and let it REASON.
// 
// Context budget: ~200K chars easily fits in 1M context.
// No tool calls. No proxy flakiness. One deep reasoning call.
// ============================================================

interface IntelResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output: any;
}

export async function runIntelligenceCycleV2(db: Database.Database): Promise<IntelResult> {
  const start = Date.now();

  try {
    // ── LOAD EVERYTHING ──

    // 0. Previous cycle state (Quinn's persistent working memory)
    let previousFocus = '';
    try {
      const { readFileSync } = await import('fs');
      previousFocus = readFileSync((process.env.HOME || '') + '/.prime/FOCUS.md', 'utf-8');
    } catch (_e) { /* first run — no prior state */ }

    // 1. Wiki pages (compiled by research agents — source-verified)
    const pages = db.prepare(
      "SELECT page_type, subject_id, content FROM compiled_pages WHERE length(content) > 50 ORDER BY compiled_at DESC"
    ).all() as any[];
    const wikiText = pages.map((p: any) =>
      `### ${p.page_type}: ${p.subject_id}\n${p.content}`
    ).join('\n\n---\n\n');

    // 2. Corrections (absolute truth)
    const corrections = db.prepare(
      "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 30"
    ).all() as any[];

    // 3. CEO statements (from Quinn chat — primary intelligence)
    const ceoStatements = db.prepare(
      "SELECT title, summary, source_date FROM knowledge WHERE source = 'user-feedback' AND provenance = 'primary' ORDER BY source_date DESC LIMIT 20"
    ).all() as any[];

    // 4. Calendar next 7 days
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const calendar = db.prepare(
      "SELECT title, source_date FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+7 days') ORDER BY source_date ASC"
    ).all() as any[];
    const calendarText = calendar.map((c: any) => {
      const d = new Date(c.source_date);
      return `- ${dayNames[d.getDay()]} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${c.title}`;
    }).join('\n');

    // 5. PM concerns
    const pmConcerns = db.prepare(
      "SELECT subject_id, concerns FROM agent_state WHERE agent_type = 'pm' AND concerns IS NOT NULL AND length(concerns) > 10"
    ).all() as any[];

    // 6. Quinn's memory and concerns
    const cosState = db.prepare(
      "SELECT memory, concerns FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
    ).get() as any;

    // 7. Commitments (active + overdue)
    const commitments = db.prepare(
      "SELECT text, state, due_date, owner, project FROM commitments WHERE state IN ('active', 'overdue') ORDER BY due_date ASC LIMIT 20"
    ).all() as any[];

    // 8. Narrative threads
    const threads = db.prepare(
      "SELECT title, current_state, next_action FROM narrative_threads WHERE status = 'active' LIMIT 10"
    ).all() as any[];

    // 9. Cross-project patterns
    const patterns = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'cross_project_patterns'"
    ).get() as any)?.value;

    // 10. Correction rules (what the system has learned)
    const lessons = db.prepare(
      "SELECT lesson, correction_rule, domain FROM strategic_lessons WHERE superseded_by IS NULL AND correction_rule IS NOT NULL ORDER BY created_at DESC LIMIT 15"
    ).all() as any[];

    // 11. Recent fresh items (last 48h)
    const freshItems = db.prepare(
      "SELECT title, source, source_date, project FROM knowledge WHERE provenance = 'primary' AND source_date >= datetime('now', '-48 hours') ORDER BY source_date DESC LIMIT 30"
    ).all() as any[];

    // 12. Detected gaps
    const gaps = (db.prepare(
      "SELECT value FROM graph_state WHERE key = 'detected_gaps'"
    ).get() as any)?.value;

    // ── BUILD THE PROMPT ──

    const now = new Date();
    const dayName = dayNames[now.getDay()];
    const dateStr = `${dayName}, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    const contextSize = [wikiText, JSON.stringify(ceoStatements), calendarText, JSON.stringify(commitments)].join('').length;
    console.log(`    Context: ${Math.round(contextSize / 1000)}K chars loaded into prompt`);

    const prompt = [
      `You are Quinn Parker, AI Chief of Staff to Zach Stock at Recapture Insurance.`,
      `TODAY IS: ${dateStr}`,
      ``,
      `You have COMPLETE visibility into the business. Below is EVERYTHING the system knows — wiki pages, CEO statements, calendar, commitments, PM concerns, narrative threads, and recent activity. Your job is to REASON about what this data implies that it doesn't state.`,
      ``,
      `## VERIFIED CORRECTIONS (these override everything)`,
      corrections.length > 0
        ? corrections.map((c: any) => `- ${c.title}`).join('\n')
        : '(none)',
      ``,
      `## QUINN'S FOCUS (your working state from last cycle)`,
      previousFocus || '(first cycle — no prior state)',
      ``,
      `## CEO STATEMENTS (Zach's direct input — primary source)`,
      ceoStatements.length > 0
        ? ceoStatements.map((s: any) => `[${(s.source_date || '').slice(0, 10)}] ${s.summary?.slice(0, 300)}`).join('\n')
        : '(none recently)',
      ``,
      `## CALENDAR (next 7 days)`,
      calendarText || '(nothing scheduled)',
      ``,
      `## ACTIVE COMMITMENTS`,
      commitments.length > 0
        ? commitments.map((c: any) => `- [${c.state}] ${c.text}${c.due_date ? ' (due: ' + c.due_date + ')' : ''}${c.owner ? ' — ' + c.owner : ''}`).join('\n')
        : '(none)',
      ``,
      // ── MIDDLE ZONE (lower attention — reference material, large volume) ──
      `## COMPILED WIKI PAGES (source-verified by research agents)`,
      wikiText || '(no wiki pages compiled)',
      ``,
      `## CROSS-PROJECT PATTERNS`,
      patterns ? JSON.parse(patterns).slice(0, 5).map((p: any) => `- ${JSON.stringify(p).slice(0, 200)}`).join('\n') : '(none)',
      ``,
      `## SYSTEM LESSONS (what the system learned from past mistakes)`,
      lessons.length > 0
        ? lessons.map((l: any) => `- [${l.domain}] ${l.correction_rule}`).join('\n')
        : '(none)',
      ``,
      `## DETECTED GAPS`,
      gaps ? JSON.parse(gaps).slice(0, 5).map((g: any) => `- [${g.severity}] ${g.type}: ${g.description?.slice(0, 150)}`).join('\n') : '(none)',
      ``,
      // ── END ZONE (high attention — actionable, time-sensitive) ──
      `## PM CONCERNS`,
      pmConcerns.length > 0
        ? pmConcerns.map((pm: any) => `[${pm.subject_id} PM]:\n${pm.concerns}`).join('\n\n')
        : '(none)',
      ``,
      `## RECENT ACTIVITY (last 48 hours)`,
      freshItems.length > 0
        ? freshItems.map((i: any) => `- [${i.source}] ${(i.source_date || '').slice(0, 10)} ${i.title}`).join('\n')
        : '(nothing new)',
      ``,
      `## QUINN'S MEMORY (your accumulated learnings)`,
      cosState?.memory ? cosState.memory.slice(0, 5000) : '(first cycle)',
      ``,
      `## QUINN'S CONCERNS (what you were watching)`,
      cosState?.concerns || '(none)',
      ``,
      `## NARRATIVE THREADS`,
      threads.length > 0
        ? threads.map((t: any) => `- "${t.title}" — ${t.current_state?.slice(0, 150)}`).join('\n')
        : '(none)',
      ``,
      `## YOUR TASK`,
      ``,
      `Analyze ALL of the above and produce a strategic intelligence brief. Return ONLY this JSON:`,
      ``,
      `{`,
      `  "headline": "One factual sentence — what matters most today",`,
      `  "the_one_thing": "The single highest-leverage action. Specific person, specific ask, specific deadline.",`,
      `  "hypotheses": [`,
      `    {`,
      `      "claim": "A specific, falsifiable prediction based on the data",`,
      `      "type": "prediction|threat|opportunity|connection|theory_of_mind",`,
      `      "confidence": 0-100,`,
      `      "evidence": "What in the data supports this",`,
      `      "key_assumption": "The ONE thing that if wrong kills this hypothesis"`,
      `    }`,
      `  ],`,
      `  "theories_of_mind": [`,
      `    {`,
      `      "entity": "Person name",`,
      `      "behavior_hypothesis": "Why they're acting the way they are based on communication patterns"`,
      `    }`,
      `  ],`,
      `  "contradictions": [`,
      `    {`,
      `      "tension": "Fact A says X but Fact B says Y",`,
      `      "source_a": "Where Fact A comes from",`,
      `      "source_b": "Where Fact B comes from",`,
      `      "resolution": "How to resolve this — who to ask, what to check"`,
      `    }`,
      `  ],`,
      `  "weak_signals": [`,
      `    {`,
      `      "signal": "Something subtle in the data that could be important",`,
      `      "why_it_matters": "What this could mean if the signal is real"`,
      `    }`,
      `  ],`,
      `  "actions": [`,
      `    {`,
      `      "title": "Specific action",`,
      `      "lens": "YOUR_ACTION|ALREADY_HANDLED|NEEDS_YOUR_INPUT|WATCH|DELEGATE",`,
      `      "target_person": "Name — role",`,
      `      "rationale": "Why this matters today, citing specific evidence"`,
      `    }`,
      `  ],`,
      `  "project_updates": [`,
      `    {"project": "Name", "status": "RED/YELLOW/GREEN + one phrase", "key_fact": "Most important thing"}`,
      `  ]`,
      `}`,
      ``,
      `REQUIREMENTS:`,
      `- You MUST produce at least 2 hypotheses and 1 weak signal. These are the primary intelligence outputs.`,
      `- Contradictions: find places where the DATA conflicts (not just stale entities). If email says X but PM report says Y, that's a real contradiction.`,
      `- Theories of mind: who is behaving unexpectedly and why? Based on communication patterns, not speculation.`,
      `- Maximum 3 actions. Every action must cite specific evidence from the data above.`,
      `- Use correct day-of-week for ALL dates.`,
      `- Use CALM language. "Worth checking:" not "CRITICAL RISK."`,
    ].filter(Boolean).join('\n');

    console.log(`    Phase 3: Opus 1M reasoning (single call, no tools, ${Math.round(prompt.length / 1000)}K prompt)...`);

    // One deep Opus call with full context
    // Use runClaude from claude-spawn — handles the proxy's 64KB limit
    // via curl fallback for large prompts
    const { runClaude } = await import('./utils/claude-spawn.js');
    const response = await runClaude(prompt, {
      maxTurns: 1,
      timeout: 300000,
    });

    // Save full cycle output for audit trail
    try {
      const { writeFileSync, mkdirSync } = await import('fs');
      const cycleDir = (process.env.HOME || '') + '/.prime/cycles';
      mkdirSync(cycleDir, { recursive: true });
      const ts = new Date().toISOString().slice(0, 13).replace(/[T:]/g, '-');
      writeFileSync(`${cycleDir}/${ts}.md`, `# Intelligence Cycle — ${dateStr}\n\n${response}`);
    } catch (_e) {}

    // Parse JSON from response
    console.log('    Phase 4: Parsing and storing results...');
    let brief: any = {};
    const jsonStart = response.indexOf('{');
    if (jsonStart === -1) throw new Error('No JSON found in response');

    for (let end = response.length; end > jsonStart; end--) {
      if (response[end - 1] !== '}') continue;
      try {
        brief = JSON.parse(response.slice(jsonStart, end));
        break;
      } catch (_e) { /* try shorter */ }
    }

    if (!brief.headline) throw new Error('Parsed JSON has no headline');

    // Store results
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
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('detected_contradictions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.contradictions || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('weak_signals', ?, datetime('now'))"
    ).run(JSON.stringify(brief.weak_signals || []));

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
    ).run(JSON.stringify(brief.actions || []));

    // Write FOCUS.md — Quinn's persistent working state
    try {
      const { writeFileSync, readFileSync: readFs } = await import('fs');
      const focusPath = (process.env.HOME || '') + '/.prime/FOCUS.md';

      // Preserve cycle log from previous FOCUS.md
      let prevLog: string[] = [];
      try {
        const prev = readFs(focusPath, 'utf-8');
        const logMatch = prev.match(/## Cycle Log[\s\S]*$/);
        if (logMatch) {
          prevLog = logMatch[0].split('\n').filter((l: string) => l.startsWith('- ')).slice(0, 4);
        }
      } catch (_e) {}

      const focusContent = [
        `# Quinn's Working State`,
        `Updated: ${new Date().toISOString()}`,
        ``,
        `## The One Thing`,
        brief.the_one_thing || '(none identified)',
        ``,
        `## Headline`,
        brief.headline || '',
        ``,
        `## Actions`,
        (brief.actions || []).map((a: any) => `- [${a.lens}] ${a.title}${a.target_person ? ' — ' + a.target_person : ''}`).join('\n') || '(none)',
        ``,
        `## Hypotheses`,
        (brief.hypotheses || []).map((h: any) => `- [${h.confidence}%] ${h.claim}`).join('\n') || '(none)',
        ``,
        `## Weak Signals`,
        (brief.weak_signals || []).map((s: any) => `- ${s.signal}`).join('\n') || '(none)',
        ``,
        `## Project Status`,
        (brief.project_updates || []).map((p: any) => `- ${p.project}: ${p.status}`).join('\n') || '(none)',
        ``,
        `## Cycle Log (last 5)`,
        `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')}: ${brief.headline || 'cycle complete'}`,
        ...prevLog,
      ].join('\n');

      writeFileSync(focusPath, focusContent);
      console.log('    ✓ FOCUS.md updated');
    } catch (err: any) {
      console.log(`    ! FOCUS.md write failed: ${err.message?.slice(0, 100)}`);
    }

    const stats = {
      hypotheses: (brief.hypotheses || []).length,
      theories_of_mind: (brief.theories_of_mind || []).length,
      contradictions: (brief.contradictions || []).length,
      weak_signals: (brief.weak_signals || []).length,
      actions: (brief.actions || []).length,
      projects: (brief.project_updates || []).length,
      prompt_chars: prompt.length,
    };

    console.log(`    ✓ Intelligence: ${stats.hypotheses} hypotheses, ${stats.weak_signals} weak signals, ${stats.contradictions} contradictions, ${stats.actions} actions`);

    return {
      task: '24-intelligence-v2',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: stats,
    };

  } catch (err: any) {
    console.log(`    ✗ Intelligence failed: ${err.message?.slice(0, 100)}`);
    return {
      task: '24-intelligence-v2',
      status: 'failed',
      duration_seconds: (Date.now() - start) / 1000,
      output: { error: err.message?.slice(0, 200) },
    };
  }
}
