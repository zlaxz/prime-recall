import type Database from 'better-sqlite3';
import { request as httpRequest } from 'http';
import { v4 as uuid } from 'uuid';

// ============================================================
// COS Agent — Quinn Parker, AI Chief of Staff
//
// Quinn IS the COS. One agent, one persistent session.
// Reads PM-enriched wiki pages, calendar, corrections,
// fresh items, PM concerns. Produces:
//   1. JSON brief (for web UI + graph_state)
//   2. Email letter (for morning send)
//   3. Memory update (append-only learnings)
//   4. Concerns update (active watchlist)
//   5. KB insights (facts for other agents)
// ============================================================

interface COSResult {
  headline: string;
  the_one_thing: string;
  actions: any[];
  project_updates: any[];
  email_body: string;
  raw_response: string;
  durationMs: number;
  sessionId: string;
  memoryUpdate: string;
  concernsUpdate: string;
  kbInsightsCount: number;
}

function callProxy(prompt: string, sessionId?: string, timeoutSec = 300): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: timeoutSec,
      args: sessionId
        ? ['--resume', sessionId]
        : [],
    });
    const req = httpRequest('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutSec + 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve({ result: parsed.result || '', sessionId: parsed.session_id || '' });
          } catch { resolve({ result: data, sessionId: '' }); }
        } else {
          reject(new Error('Proxy: ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('COS timeout')); });
    req.write(body);
    req.end();
  });
}

export async function runCOS(db: Database.Database): Promise<COSResult> {
  const start = Date.now();

  // 1. Read all compiled wiki pages
  const pages = db.prepare(
    "SELECT page_type, subject_name, content, compiled_at FROM compiled_pages ORDER BY compiled_at DESC"
  ).all() as any[];

  if (pages.length === 0) {
    return {
      headline: 'No wiki pages compiled yet.',
      the_one_thing: 'Run the wiki compilation pipeline.',
      actions: [], project_updates: [], email_body: '',
      raw_response: '', durationMs: Date.now() - start, sessionId: '',
      memoryUpdate: '', concernsUpdate: '', kbInsightsCount: 0,
    };
  }

  // 2. Build wiki context
  const wikiContext = pages.map((p: any) => p.content).join('\n\n---\n\n');

  // 3. Load corrections (absolute truth)
  const corrections = db.prepare(
    "SELECT title FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 20"
  ).all() as any[];
  const correctionText = corrections.length > 0
    ? 'VERIFIED CORRECTIONS (these override everything):\n' + corrections.map((c: any) => '- ' + c.title).join('\n')
    : '';

  // 4. Calendar next 7 days
  const calendar = db.prepare(
    "SELECT title, source_date FROM knowledge WHERE source = 'calendar' AND source_date >= datetime('now') AND source_date <= datetime('now', '+7 days') ORDER BY source_date ASC"
  ).all() as any[];
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const calendarText = calendar.length > 0
    ? 'UPCOMING CALENDAR:\n' + calendar.map((c: any) => {
        const d = new Date(c.source_date);
        const day = dayNames[d.getDay()];
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const time = c.source_date?.includes('T') ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }) : '';
        return '- ' + day + ' ' + dateStr + (time ? ' ' + time : '') + ' -- ' + c.title;
      }).join('\n')
    : '';

  // 5. PM concerns (from project managers)
  const pmConcerns = db.prepare(
    "SELECT subject_id, concerns FROM agent_state WHERE agent_type = 'pm' AND concerns IS NOT NULL"
  ).all() as any[];
  const concernsText = pmConcerns.length > 0
    ? 'PM CONCERNS:\n' + pmConcerns.map((pm: any) => '[' + pm.subject_id + ' PM]: ' + pm.concerns.slice(0, 500)).join('\n\n')
    : '';

  // 6. Fresh items since last COS run
  const lastRun = db.prepare(
    "SELECT last_run_at FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const freshItems = db.prepare(
    "SELECT title, source, source_date FROM knowledge WHERE source_date > ? AND provenance = 'primary' ORDER BY source_date DESC LIMIT 15"
  ).all(lastRun?.last_run_at || '2000-01-01') as any[];
  const freshText = freshItems.length > 0
    ? 'NEW SINCE LAST CYCLE:\n' + freshItems.map((i: any) => '- [' + i.source + '] ' + i.title).join('\n')
    : '';

  // 6b. Load Quinn's memory and concerns from agent_state
  const quinnState = db.prepare(
    "SELECT memory, concerns FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const quinnMemory = quinnState?.memory || '';
  const quinnConcerns = quinnState?.concerns || '';

  // 6c. Load Quinn's SOUL.md identity
  let quinnSoul = '';
  try {
    const { readFileSync } = await import('fs');
    const homedir = process.env.HOME || '/Users/zachstock';
    quinnSoul = readFileSync(homedir + '/.prime/agents/cos/SOUL.md', 'utf-8');
  } catch (_e) {}

  // 7. Build COS prompt
  const now = new Date();
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const dateStr = dayName + ', ' + now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const cosState = db.prepare(
    "SELECT session_id FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const sessionId = cosState?.session_id || undefined;

  const promptParts: string[] = [];

  // Load identity if available
  if (quinnSoul) {
    promptParts.push(quinnSoul);
    promptParts.push('');
  } else {
    promptParts.push("You are Quinn Parker, Zach Stock's AI Chief of Staff at Recapture Insurance.");
    promptParts.push("You are NOT summarizing someone else's work. YOU are the COS. This is YOUR intelligence, YOUR analysis, YOUR recommendations.");
  }

  promptParts.push(
    'TODAY IS: ' + dateStr,
    '',
  );

  if (sessionId) {
    promptParts.push('This is a continuing conversation. You remember what you said in previous emails. Focus on what is NEW or CHANGED. Do not repeat yourself.');
    promptParts.push('');
  }

  // Inject Quinn's persistent memory and concerns
  if (quinnMemory) {
    promptParts.push('## WHAT I REMEMBER');
    promptParts.push(quinnMemory.slice(0, 4000));
    promptParts.push('');
  }
  if (quinnConcerns) {
    promptParts.push("## WHAT I'M WATCHING");
    promptParts.push(quinnConcerns.slice(0, 2000));
    promptParts.push('');
  }

  promptParts.push(
    correctionText, '',
    lessonsText ? '## ACTIVE LESSONS (from past cycles)\n' + lessonsText : '', '',
    calendarText, '',
    concernsText, '',
    freshText, '',
    '## YOUR INTELLIGENCE (compiled by your research team)',
    wikiContext.slice(0, 30000),
    '',
    'Produce FIVE outputs separated by these exact markers:',
    '',
    'FIRST: A JSON brief for the web dashboard:',
    '```json',
    '{',
    '  "headline": "One sentence -- what matters most today",',
    '  "the_one_thing": "The highest leverage action. Specific person, specific ask, specific deadline.",',
    '  "actions": [{"title":"...","lens":"YOUR_ACTION|ALREADY_HANDLED|NEEDS_YOUR_INPUT|WATCH|DELEGATE","target_person":"Name -- role/org","rationale":"Why this matters today, not tomorrow"}],',
    '  "project_updates": [{"project":"...","status":"RED/YELLOW/GREEN + one phrase","key_fact":"Most important thing to know right now"}]',
    '}',
    '```',
    '',
    '---EMAIL---',
    '',
    "SECOND: Your morning email to Zach. Write it like YOU -- direct, warm, sharp. A letter from someone who knows the business deeply.",
    '- Open with what matters most (bold it)',
    '- 2-3 sentences of WHY it matters, not just what',
    "- \"Here's what I'd focus on today:\" -- 2-3 specific actions with specific people",
    "- One thing that might surprise Zach or that he hasn't noticed",
    '- If a PM flagged a concern, surface it naturally',
    '- Close with your sign-off',
    '',
    'NO: corporate headers, bullet lists of everything, "ACTIONS:" sections, repeating what was in the last email.',
    'YES: conversational, opinionated, like a letter from a trusted advisor who actually cares.',
    'Keep it under 300 words. Every sentence must earn its place.',
    '',
    '---MEMORY_UPDATE---',
    '',
    'THIRD: Learnings to remember for next cycle. These get appended to your long-term memory.',
    'Include: patterns you noticed, what Zach responded to, what got ignored, cross-project insights, relationship dynamics observed.',
    'Each entry should be dated with today\'s date. Be concise -- key facts and patterns only.',
    'If nothing new to remember, write "No new learnings this cycle."',
    '',
    '---CONCERNS_UPDATE---',
    '',
    'FOURTH: Your active worry list. What you\'re watching, with dates added/resolved.',
    'This REPLACES your previous concerns entirely. Keep it current.',
    'If nothing concerns you, write "No active concerns."',
    '',
    '---KB_INSIGHTS---',
    '',
    'FIFTH: Facts and patterns that OTHER agents (PMs, specialists) should know about.',
    'Each on its own line. Format: ENTITY_OR_PROJECT | insight text',
    'Example: Neil Dick | responds within 24h when contacted before 9am MDT',
    'Example: Carefront | broker outreach stalled 3 consecutive cycles as of April 6',
    'Only include genuinely useful cross-cutting insights. If none, write "No new insights."',
  );

  const prompt = promptParts.filter(Boolean).join('\n');

  // 8. Call Opus via proxy
  console.log('    COS: calling Opus' + (sessionId ? ' (resuming)' : ' (new)') + '...');
  const response = await callProxy(prompt, sessionId, 300);

  // 9. Parse all sections from response
  const content = response.result;

  console.log('    COS raw response length: ' + content.length + ' chars');

  // Fuzzy marker search -- Opus sometimes adds spaces or changes case
  function findMarker(text: string, marker: string): number {
    let idx = text.indexOf(marker);
    if (idx >= 0) return idx;
    // Case-insensitive
    idx = text.toLowerCase().indexOf(marker.toLowerCase());
    if (idx >= 0) return idx;
    // Try without the dashes (just the word)
    const word = marker.replace(/---/g, '').trim();
    const regex = new RegExp('-{2,3}\\s*' + word + '\\s*-{2,3}', 'i');
    const match = text.match(regex);
    if (match && match.index !== undefined) return match.index;
    return -1;
  }

  // Find marker end positions (after the marker text itself)
  function markerEnd(text: string, marker: string, pos: number): number {
    if (pos < 0) return -1;
    // Find the end of the marker line
    const lineEnd = text.indexOf('\n', pos);
    return lineEnd >= 0 ? lineEnd + 1 : pos + marker.length;
  }

  const emailMarker = findMarker(content, '---EMAIL---');
  const memoryMarker = findMarker(content, '---MEMORY_UPDATE---');
  const concernsMarker = findMarker(content, '---CONCERNS_UPDATE---');
  const kbMarker = findMarker(content, '---KB_INSIGHTS---');

  console.log('    COS markers: email=' + (emailMarker >= 0) + ' memory=' + (memoryMarker >= 0) + ' concerns=' + (concernsMarker >= 0) + ' kb=' + (kbMarker >= 0));

  // Extract JSON brief (everything before ---EMAIL---)
  const jsonPart = emailMarker >= 0 ? content.slice(0, emailMarker) : content;

  // Extract email (between ---EMAIL--- and ---MEMORY_UPDATE--- or end)
  let emailBody = '';
  if (emailMarker >= 0) {
    // Skip past the marker line itself
    const emailLineEnd = content.indexOf('\n', emailMarker);
    const emailStart = emailLineEnd >= 0 ? emailLineEnd + 1 : emailMarker + 15;
    const emailEnd = memoryMarker >= 0 ? memoryMarker : (concernsMarker >= 0 ? concernsMarker : (kbMarker >= 0 ? kbMarker : content.length));
    emailBody = content.slice(emailStart, emailEnd).trim();
  }

  // Extract memory update (between ---MEMORY_UPDATE--- and ---CONCERNS_UPDATE--- or end)
  let memoryUpdate = '';
  if (memoryMarker >= 0) {
    const memStart = memoryMarker + '---MEMORY_UPDATE---'.length;
    const memEnd = concernsMarker >= 0 ? concernsMarker : (kbMarker >= 0 ? kbMarker : content.length);
    memoryUpdate = content.slice(memStart, memEnd).trim();
  }

  // Extract concerns (between ---CONCERNS_UPDATE--- and ---KB_INSIGHTS--- or end)
  let concernsUpdate = '';
  if (concernsMarker >= 0) {
    const conStart = concernsMarker + '---CONCERNS_UPDATE---'.length;
    const conEnd = kbMarker >= 0 ? kbMarker : content.length;
    concernsUpdate = content.slice(conStart, conEnd).trim();
  }

  // Extract KB insights (after ---KB_INSIGHTS---)
  let kbInsightsRaw = '';
  if (kbMarker >= 0) {
    kbInsightsRaw = content.slice(kbMarker + '---KB_INSIGHTS---'.length).trim();
  }

  // Parse JSON brief
  let brief: any = {};
  try {
    const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const candidates = jsonMatch[0];
      for (let end = candidates.length; end > 0; end--) {
        if (candidates[end - 1] !== '}') continue;
        try {
          brief = JSON.parse(candidates.slice(0, end));
          break;
        } catch (_e) {}
      }
    }
  } catch (_e) {}

  // If no email section, extract from after JSON
  if (!emailBody && content.length > jsonPart.length) {
    emailBody = content.slice(jsonPart.length).trim();
  }

  // Fallback: generate email from brief
  if (!emailBody || emailBody.length < 50) {
    emailBody = [
      '**' + (brief.headline || 'Good morning.') + '**',
      '',
      brief.the_one_thing || '',
      '',
      (brief.actions || []).length > 0 ? "Here's what I'd focus on today:" : '',
      ...(brief.actions || []).slice(0, 3).map((a: any, i: number) =>
        (i + 1) + '. ' + a.title + (a.target_person ? ' (-> ' + a.target_person + ')' : '') + ' -- ' + (a.rationale?.slice(0, 120) || '')
      ),
      '',
      'Talk soon,',
      'Quinn',
    ].filter(Boolean).join('\n');
  }

  // Clean up email
  emailBody = emailBody.replace(/^```[\s\S]*?```\s*/g, '').trim();

  // 10. Store results in graph_state (existing behavior)
  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_brief', ?, datetime('now'))"
  ).run(JSON.stringify(brief));

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('intelligence_actions', ?, datetime('now'))"
  ).run(JSON.stringify(brief.actions || []));

  db.prepare(
    "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('cos_email_body', ?, datetime('now'))"
  ).run(emailBody);

  // 11. Update Quinn's memory (append-only, like PM agents)
  if (memoryUpdate && memoryUpdate !== 'No new learnings this cycle.') {
    const existingMemory = quinnMemory || '';
    const newMemory = existingMemory
      ? existingMemory + '\n\n## Cycle ' + dateStr + '\n' + memoryUpdate
      : '## Cycle ' + dateStr + '\n' + memoryUpdate;
    // Store in agent_state.memory (will be written in the UPDATE below)
    db.prepare(
      "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, memory, concerns, session_id, last_run_at) VALUES ('cos', 'global', ?, ?, ?, datetime('now'))"
    ).run(
      newMemory,
      (concernsUpdate && concernsUpdate !== 'No active concerns.') ? concernsUpdate : (quinnConcerns || null),
      response.sessionId || sessionId || '',
    );
    console.log('    COS: memory updated (' + memoryUpdate.length + ' chars appended)');
  } else {
    // 12. Update concerns even if no memory update
    if (concernsUpdate && concernsUpdate !== 'No active concerns.') {
      db.prepare(
        "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, memory, concerns, session_id, last_run_at) VALUES ('cos', 'global', ?, ?, ?, datetime('now'))"
      ).run(
        quinnMemory || null,
        concernsUpdate,
        response.sessionId || sessionId || '',
      );
      console.log('    COS: concerns updated');
    } else {
      // Just update session_id and last_run_at
      db.prepare(
        "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, memory, concerns, session_id, last_run_at) VALUES ('cos', 'global', ?, ?, ?, datetime('now'))"
      ).run(
        quinnMemory || null,
        quinnConcerns || null,
        response.sessionId || sessionId || '',
      );
    }
  }

  // 13. Write KB insights (deduplicated)
  let kbInsightsCount = 0;
  if (kbInsightsRaw && kbInsightsRaw !== 'No new insights.') {
    const lines = kbInsightsRaw.split('\n').filter(l => l.includes('|'));
    for (const line of lines) {
      const pipeIdx = line.indexOf('|');
      if (pipeIdx < 0) continue;
      const entity = line.slice(0, pipeIdx).trim().replace(/^[-*]\s*/, '');
      const insight = line.slice(pipeIdx + 1).trim();
      if (!entity || !insight) continue;

      // Deduplicate: check if similar cos-insight exists for this entity/project
      const existing = db.prepare(
        "SELECT id FROM knowledge WHERE source = 'cos-insight' AND (project = ? OR title LIKE ?) LIMIT 1"
      ).get(entity, '%' + entity + '%') as any;

      // Also check if the exact insight text already exists
      const exactDupe = db.prepare(
        "SELECT id FROM knowledge WHERE source = 'cos-insight' AND summary = ? LIMIT 1"
      ).get(insight) as any;

      if (exactDupe) {
        continue; // Skip exact duplicates
      }

      // If entity already has a cos-insight, supersede it
      const insightId = uuid();
      if (existing) {
        db.prepare("UPDATE knowledge SET superseded_by = ?, valid_until = datetime('now') WHERE id = ?").run(insightId, existing.id);
      }

      db.prepare(
        "INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, importance, project, created_at, updated_at) VALUES (?, ?, ?, 'cos-insight', ?, datetime('now'), 'high', ?, datetime('now'), datetime('now'))"
      ).run(
        insightId,
        'COS Insight: ' + entity,
        insight,
        'cos-cycle-' + dateStr,
        entity,
      );
      kbInsightsCount++;
    }
    if (kbInsightsCount > 0) {
      console.log('    COS: wrote ' + kbInsightsCount + ' KB insights');
    }
  }

  console.log('    COS: done in ' + ((Date.now() - start) / 1000).toFixed(1) + 's -- ' + (brief.headline || '(no headline)').slice(0, 80));

  return {
    headline: brief.headline || '',
    the_one_thing: brief.the_one_thing || '',
    actions: brief.actions || [],
    project_updates: brief.project_updates || [],
    email_body: emailBody,
    raw_response: response.result,
    durationMs: Date.now() - start,
    sessionId: response.sessionId || sessionId || '',
    memoryUpdate,
    concernsUpdate,
    kbInsightsCount,
  };
}
