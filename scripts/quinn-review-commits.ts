/**
 * Quinn reviews open commitments and triages them.
 * For each commit, Quinn decides: keep / done / drop — with reason.
 * Writes state changes back to the DB.
 */
import Database from 'better-sqlite3';
import { request as httpReq } from 'http';

const DB_PATH = '/Users/zachstock/.prime/prime.db';
const BATCH_SIZE = 25;

function callQuinn(prompt: string, sessionId?: string): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      timeout: 180,
      args: sessionId ? ['--resume', sessionId] : [],
    });
    const req = httpReq('http://localhost:3211/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 210000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ result: parsed.result || '', sessionId: parsed.session_id || '' });
        } catch {
          resolve({ result: data, sessionId: '' });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Quinn timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  // Get Quinn's session for continuity
  const cosState = db.prepare(
    "SELECT session_id FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  let sessionId: string | undefined = cosState?.session_id || undefined;

  // Fetch all open commits with source context
  const commits = db.prepare(`
    SELECT c.id, c.text, c.owner, c.assigned_to, c.due_date, c.project, c.state, c.context, c.importance,
           k.source_date, k.source as source_type, k.title as source_title
    FROM commitments c
    LEFT JOIN knowledge k ON k.id = c.detected_from
    WHERE c.state NOT IN ('abandoned', 'done', 'dropped', 'fulfilled')
    ORDER BY c.project, c.created_at DESC
  `).all() as any[];

  console.log(`Found ${commits.length} open commitments to review`);
  if (commits.length === 0) { console.log('Nothing to review'); process.exit(0); }

  // Batch through Quinn
  const decisions = new Map<string, { action: string; reason: string }>();
  const today = new Date().toISOString().split('T')[0];

  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(commits.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} commits)...`);

    const numbered = batch.map((c, idx) => {
      const parts = [`${idx + 1}. [id=${c.id}] ${c.text}`];
      const meta: string[] = [];
      if (c.owner) meta.push(`owner=${c.owner}`);
      if (c.assigned_to) meta.push(`assigned_to=${c.assigned_to}`);
      if (c.due_date) meta.push(`due=${c.due_date.slice(0, 10)}`);
      if (c.project) meta.push(`project=${c.project}`);
      if (c.state) meta.push(`state=${c.state}`);
      if (meta.length) parts.push(`   (${meta.join(', ')})`);
      if (c.source_type && c.source_title) parts.push(`   from: ${c.source_type} "${(c.source_title || '').slice(0, 80)}" ${c.source_date?.slice(0, 10) || ''}`);
      if (c.context) parts.push(`   context: ${c.context.slice(0, 150)}`);
      return parts.join('\n');
    }).join('\n\n');

    const prompt = `Today is ${today}. You are Quinn Parker, Chief of Staff. You're reviewing a list of commitments that got auto-extracted from emails, meetings, and conversations. The extraction is noisy — many items are either (a) already handled, (b) misextracted noise, or (c) duplicates of other commitments. Your job is to triage each one ruthlessly.

For each commitment, decide one of:
- **keep**: This is a real, current, unresolved task that belongs on Zach's radar
- **done**: Already handled/completed based on what you know about the business
- **drop**: Noise, misextraction, duplicate, aspirational vague intent, agent self-talk, or no longer relevant

Be ruthless on "drop" — our goal is a clean signal-dense list. If a commitment is vague ("continue pursuing X"), stale (>60d old with no follow-up), a duplicate, an observation rather than an action, or doesn't have a clear specific deliverable → drop it.

Return ONLY a JSON array, one object per commitment, in the exact same order as listed below:
[
  {"id": "...", "action": "keep" | "done" | "drop", "reason": "one short phrase"}
]

Commitments to review:

${numbered}

Return ONLY the JSON array. No preamble, no explanation outside the array.`;

    try {
      const response = await callQuinn(prompt, sessionId);
      if (response.sessionId) sessionId = response.sessionId;

      // Extract JSON array from response
      const match = response.result.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (!match) {
        console.log(`  !! No JSON array in response. First 200 chars: ${response.result.slice(0, 200)}`);
        continue;
      }

      let parsed: any[];
      try {
        parsed = JSON.parse(match[0]);
      } catch (e: any) {
        console.log(`  !! JSON parse error: ${e.message}`);
        continue;
      }

      let kept = 0, done = 0, dropped = 0;
      for (const d of parsed) {
        if (!d.id || !d.action) continue;
        decisions.set(d.id, { action: d.action, reason: d.reason || '' });
        if (d.action === 'keep') kept++;
        else if (d.action === 'done') done++;
        else if (d.action === 'drop') dropped++;
      }
      console.log(`  Batch ${batchNum}: ${kept} keep, ${done} done, ${dropped} drop (${parsed.length} total, ${batch.length} expected)`);
    } catch (err: any) {
      console.log(`  !! Batch error: ${err.message}`);
    }
  }

  // Apply decisions
  console.log(`\nApplying ${decisions.size} decisions to database...`);
  const updateStmt = db.prepare(
    "UPDATE commitments SET state = ?, state_changed_at = datetime('now'), fulfilled_evidence = ?, updated_at = datetime('now') WHERE id = ?"
  );

  let applied = { keep: 0, done: 0, drop: 0 };
  for (const [id, { action, reason }] of decisions) {
    let newState: string | null = null;
    if (action === 'keep') { applied.keep++; continue; } // no change
    else if (action === 'done') newState = 'done';
    else if (action === 'drop') newState = 'dropped';
    if (newState) {
      updateStmt.run(newState, `Quinn review: ${reason}`, id);
      if (action === 'done') applied.done++;
      else applied.drop++;
    }
  }

  console.log(`\nDone. Kept: ${applied.keep}, Marked done: ${applied.done}, Dropped: ${applied.drop}`);

  // Save Quinn's new session ID
  if (sessionId && sessionId !== cosState?.session_id) {
    db.prepare(
      "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, session_id, last_run_at) VALUES ('cos', 'global', ?, datetime('now'))"
    ).run(sessionId);
  }

  // Final state
  const after = db.prepare("SELECT state, COUNT(*) as cnt FROM commitments GROUP BY state").all();
  console.log('\nFinal commitments state:');
  console.table(after);

  db.close();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
