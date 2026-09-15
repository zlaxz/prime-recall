/**
 * ChatGPT export ingester — the "shelf" for ChatGPT conversations.
 *
 * Flow: a monthly [REMIND] asks Zach for the 2-click export on chatgpt.com.
 * OpenAI emails "your data export is ready" with a signed 24h download link.
 * This module (hourly, from shift) finds that email in the already-synced
 * gmail rows, downloads the zip itself, unpacks conversations.json, and
 * shelves every conversation verbatim under ~/.prime/chatgpt-shelf/ with an
 * index card each. Cards are the index; files are the shelf (library rule).
 * On success it resolves the reminder and schedules next month's.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const SHELF = '/Users/zachstock/.prime/chatgpt-shelf';

export async function checkChatGPTExport(db: Database.Database): Promise<{ ingested: number }> {
  // 1) Find an unprocessed export-ready email (synced by the gmail connector)
  const seen = (db.prepare("SELECT value FROM graph_state WHERE key='chatgpt_export_last_ref'").get() as any)?.value || '';
  const mail = db.prepare(
    `SELECT id, source_ref, raw_content, summary FROM knowledge
     WHERE source='gmail' AND (title LIKE '%export%' OR summary LIKE '%export%')
       AND (raw_content LIKE '%chatgpt.com%' OR raw_content LIKE '%openai.com%' OR summary LIKE '%OpenAI%')
       AND created_at > datetime('now','-2 days')
     ORDER BY created_at DESC LIMIT 3`
  ).all() as any[];
  const candidate = mail.find(m => m.source_ref !== JSON.parse(seen || '""') &&
    /download|export.*ready|ready.*export/i.test((m.raw_content || '') + (m.summary || '')));
  if (!candidate) return { ingested: 0 };

  const body = candidate.raw_content || '';
  const linkMatch = body.match(/https?:\/\/[^\s"'<>\])]+(?:download|export|estuary)[^\s"'<>\])]*/i)
    || body.match(/https?:\/\/proddatamgmtqueue\.blob\.core\.windows\.net[^\s"'<>\])]*/i);
  if (!linkMatch) {
    console.log('[chatgpt-export] ready-email found but no download link parsed — flagging');
    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('chatgpt_export_parse_fail', ?, datetime('now'))")
      .run(JSON.stringify(candidate.source_ref));
    return { ingested: 0 };
  }
  const url = linkMatch[0].replace(/&amp;/g, '&');

  // 2) Download + unpack
  mkdirSync(SHELF, { recursive: true });
  const zipPath = join(SHELF, `export-${new Date().toISOString().slice(0, 10)}.zip`);
  console.log('[chatgpt-export] downloading export zip...');
  execFileSync('/usr/bin/curl', ['-sL', '--max-time', '300', '-o', zipPath, url]);
  const tmpDir = join(SHELF, '.unpack');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', tmpDir]);
  const convPath = join(tmpDir, 'conversations.json');
  if (!existsSync(convPath)) { console.log('[chatgpt-export] zip had no conversations.json'); return { ingested: 0 }; }

  // 3) Shelve each conversation verbatim + index card (dedup by convo id+update time)
  const conversations = JSON.parse(readFileSync(convPath, 'utf-8')) as any[];
  const { insertKnowledge } = await import('./db.js');
  let ingested = 0;
  for (const c of conversations) {
    const cid = c.conversation_id || c.id;
    const updated = Math.floor(c.update_time || 0);
    const key = `chatgpt:${cid}`;
    const prior = db.prepare("SELECT id, metadata FROM knowledge WHERE source_ref = ?").get(key) as any;
    if (prior) {
      try { if ((JSON.parse(prior.metadata || '{}').update_time || 0) >= updated) continue; } catch (_e) {}
    }
    // Flatten the message tree in chronological order
    const nodes = Object.values(c.mapping || {}) as any[];
    const msgs = nodes
      .map(n => n.message).filter(Boolean)
      .filter((m: any) => m.content?.parts?.length && typeof m.content.parts[0] === 'string' && m.content.parts[0].trim())
      .sort((a: any, b: any) => (a.create_time || 0) - (b.create_time || 0))
      .map((m: any) => `${m.author?.role || '?'}: ${m.content.parts.join('\n')}`);
    if (!msgs.length) continue;
    const full = msgs.join('\n\n');
    const file = join(SHELF, `${cid}.txt`);
    writeFileSync(file, `# ${c.title || 'untitled'}\n# updated: ${new Date(updated * 1000).toISOString()}\n\n${full}`);

    const card: any = {
      id: prior?.id || randomUUID(),
      title: `[ChatGPT full] ${(c.title || 'untitled').slice(0, 90)}`,
      summary: `Complete ChatGPT transcript (${msgs.length} messages, updated ${new Date(updated * 1000).toISOString().slice(0, 10)}). Full text on shelf: ${file}`,
      source: 'chatgpt-export',
      source_ref: key,
      source_date: new Date(updated * 1000).toISOString(),
      importance: 'normal',
      provenance: 'primary',
      tags: JSON.stringify(['chatgpt', 'transcript']),
      metadata: JSON.stringify({ file, update_time: updated, messages: msgs.length }),
    };
    if (prior) {
      db.prepare("UPDATE knowledge SET summary=?, source_date=?, metadata=?, updated_at=datetime('now') WHERE id=?")
        .run(card.summary, card.source_date, card.metadata, prior.id);
    } else {
      insertKnowledge(db, card);
    }
    ingested++;
  }
  rmSync(tmpDir, { recursive: true, force: true });

  // 4) Bookkeeping: mark processed, resolve this month's reminder, schedule next month's
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('chatgpt_export_last_ref', ?, datetime('now'))")
    .run(JSON.stringify(candidate.source_ref));
  db.prepare("UPDATE ledger SET status='resolved', resolved_at=datetime('now') WHERE item='chatgpt-export-monthly' AND status='open'").run();
  const next = new Date(); next.setMonth(next.getMonth() + 1);
  db.prepare(
    `INSERT OR REPLACE INTO ledger (id, monitor, item, title, counterparty, state, ball, ball_since, deadline, next_action, tier, status, created_at, updated_at)
     VALUES (?, 'claude-session', 'chatgpt-export-monthly', 'ChatGPT export — 2 clicks, Prime does the rest', 'OpenAI', 'monthly shelf refresh', 'zach', date('now'), ?, 'chatgpt.com -> Settings -> Data controls -> Export data -> Export. Then close the tab — Prime downloads and shelves it automatically.', 'remind', 'open', datetime('now'), datetime('now'))`
  ).run(randomUUID(), next.toISOString().slice(0, 10));

  console.log(`[chatgpt-export] shelved ${ingested} conversations (${conversations.length} in export)`);
  return { ingested };
}
