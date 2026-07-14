import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { getDb, getConfig } from './db.js';
import { executeAction, executeAllPending } from './actions.js';
import { snoozeAllPending } from './escalation.js';
import { notify } from './notify.js';

// ============================================================
// iMessage Reply Listener
//
// Monitors incoming iMessages on Mac Mini. When Zach replies
// to a Prime notification:
//   "YES" / "Y"       → execute ALL pending staged actions
//   "1", "2", "3"     → execute that specific action
//   "NO" / "N"        → reject all pending actions
//   "SKIP"            → do nothing (acknowledged)
//
// Runs as a launchd daemon, polling every 30 seconds.
// ============================================================

const MESSAGES_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const POLL_INTERVAL = 5_000; // 5 seconds — conversational latency
const STATE_KEY = 'imessage_listener_last_rowid';
const QUINN_SESSION_KEY = 'imessage_quinn_session';

/**
 * Extract plain text from a Messages attributedBody typedstream blob.
 * Modern macOS leaves message.text NULL and stores the text after the
 * NSString class marker: "NSString" + 01 94 84 01 2B + length + utf8 bytes
 * (length is one byte, or 0x81 + uint16 LE for texts over 255 bytes).
 * Verified against real chat.db rows on the Mini, 2026-07-14.
 */
function decodeAttributedBody(buf: Buffer | null): string {
  if (!buf || !buf.length) return '';
  const marker = Buffer.from('NSString');
  const idx = buf.indexOf(marker);
  if (idx === -1) return '';
  const i = idx + marker.length + 5;
  if (i >= buf.length) return '';
  let length: number, start: number;
  if (buf[i] === 0x81) { length = buf.readUInt16LE(i + 1); start = i + 3; }
  else { length = buf[i]; start = i + 1; }
  return buf.slice(start, start + length).toString('utf8');
}

/**
 * Read recent incoming messages from Zach's phone number.
 */
function getNewMessages(lastRowId: number, zachPhone: string): { rowid: number; text: string; date: number }[] {
  if (!existsSync(MESSAGES_DB)) return [];

  try {
    // Read-only connection to Messages database
    const msgDb = new Database(MESSAGES_DB, { readonly: true, fileMustExist: true });

    const rows = msgDb.prepare(`
      SELECT m.ROWID as rowid, m.text, m.attributedBody as body, m.date
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id LIKE ?
        AND m.is_from_me = 0
        AND m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT 10
    `).all(`%${zachPhone.replace(/[^0-9]/g, '').slice(-10)}%`, lastRowId) as any[];

    msgDb.close();
    return rows
      .map(r => ({ rowid: r.rowid, text: r.text || decodeAttributedBody(r.body), date: r.date }))
      .filter(r => r.text && r.text.trim().length > 0);
  } catch (err: any) {
    console.error(`[iMessage] DB read error: ${err.message}`);
    return [];
  }
}

/**
 * Send a reply via iMessage.
 */
function sendReply(phone: string, text: string): boolean {
  try {
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    execSync(
      `/usr/bin/osascript <<'APPLESCRIPT'\ntell application "Messages" to send "${escaped}" to buddy "${phone}"\nAPPLESCRIPT`,
      { timeout: 30000, shell: '/bin/bash' }
    );
    return true;
  } catch (err: any) {
    console.error(`[iMessage] Send error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

/**
 * Route a conversational message to Quinn via the serve's /api/prime endpoint.
 * One persistent session across texts (text RESET or NEW to start fresh).
 */
async function quinnChat(db: Database.Database, text: string, zachPhone: string): Promise<void> {
  const apiKey = getConfig(db, 'prime_api_key') || process.env.PRIME_API_KEY || '';
  const sessionId = (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(QUINN_SESSION_KEY) as any)?.value || '';

  // One "thinking" ack if Quinn takes a while — keeps the thread from feeling dead
  const ackTimer = setTimeout(() => {
    sendReply(zachPhone, '\u2026on it, give me a minute');
  }, 25_000);

  try {
    const resp = await fetch('http://127.0.0.1:3210/api/prime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': String(apiKey) },
      body: JSON.stringify({ message: text, session_id: sessionId }),
      signal: AbortSignal.timeout(180_000),
    });
    clearTimeout(ackTimer);
    const result: any = await resp.json();

    if (result?.session_id) {
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run(QUINN_SESSION_KEY, result.session_id);
    }

    const content: string = result?.content || result?.error || 'Quinn returned an empty response.';
    // Split very long replies for readability
    const CHUNK = 3500;
    for (let i = 0; i < content.length; i += CHUNK) {
      sendReply(zachPhone, content.slice(i, i + CHUNK));
    }
  } catch (err: any) {
    clearTimeout(ackTimer);
    sendReply(zachPhone, `Quinn is unreachable (${err.message?.slice(0, 60)}). The serve may be restarting \u2014 try again in a minute.`);
  }
}

/**
 * Process a single reply message.
 */
async function processReply(db: Database.Database, text: string, zachPhone: string): Promise<void> {
  const cmd = text.trim().toUpperCase();
  const timestamp = new Date().toLocaleString();

  console.log(`[iMessage] ${timestamp} Received: "${text.trim()}"`);

  if (cmd === 'YES' || cmd === 'Y' || cmd === 'APPROVE' || cmd === 'GO') {
    // Execute all pending actions
    const results = await executeAllPending(db);
    if (results.length === 0) {
      sendReply(zachPhone, 'No pending actions to execute.');
      return;
    }

    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let reply = `Executed ${succeeded.length}/${results.length} actions:`;
    for (const r of succeeded) {
      reply += `\n✓ ${r.message}`;
    }
    for (const r of failed) {
      reply += `\n✗ ${r.message}`;
    }

    sendReply(zachPhone, reply);
    console.log(`[iMessage] Executed ${succeeded.length}/${results.length} actions`);

  } else if (cmd === 'NO' || cmd === 'N' || cmd === 'REJECT') {
    // Reject all pending
    const pending = db.prepare(
      "SELECT id FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).all() as any[];

    for (const { id } of pending) {
      db.prepare("UPDATE staged_actions SET status = 'rejected', acted_at = datetime('now') WHERE id = ?").run(id);
    }

    sendReply(zachPhone, `Rejected ${pending.length} action${pending.length === 1 ? '' : 's'}. System will learn from this.`);
    console.log(`[iMessage] Rejected ${pending.length} actions`);

  } else if (/^\d+$/.test(cmd)) {
    // Execute specific action by number (maps to action list order)
    const actionNum = parseInt(cmd);
    const pending = db.prepare(
      "SELECT id, type, summary FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id"
    ).all() as any[];

    if (actionNum < 1 || actionNum > pending.length) {
      sendReply(zachPhone, `Invalid action number. You have ${pending.length} pending action${pending.length === 1 ? '' : 's'} (1-${pending.length}).`);
      return;
    }

    const action = pending[actionNum - 1];
    const result = await executeAction(db, action.id);

    if (result.success) {
      sendReply(zachPhone, `✓ ${result.message}`);
    } else {
      sendReply(zachPhone, `✗ ${result.message}`);
    }

    console.log(`[iMessage] Action #${actionNum}: ${result.success ? 'success' : 'failed'}`);

  } else if (cmd === 'LATER' || cmd === 'SNOOZE') {
    // Snooze all pending actions — reset escalation, extend expiry 24h
    const snoozed = snoozeAllPending(db);
    if (snoozed === 0) {
      sendReply(zachPhone, 'No pending actions to snooze.');
    } else {
      sendReply(zachPhone, `Snoozed ${snoozed} action${snoozed === 1 ? '' : 's'} for 24h. Escalation reset.`);
    }
    console.log(`[iMessage] Snoozed ${snoozed} actions`);

  } else if (cmd === 'STATUS' || cmd === 'LIST') {
    // List pending actions
    const pending = db.prepare(
      "SELECT id, type, summary, project, COALESCE(escalation_level, 0) as escalation_level FROM staged_actions WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id"
    ).all() as any[];

    if (pending.length === 0) {
      sendReply(zachPhone, 'No pending actions.');
    } else {
      const levelLabel = (l: number) => l === 0 ? '' : l === 1 ? ' [REMINDER]' : l === 2 ? ' [AUTO-SEND SOON]' : ' [AUTO-SENDING]';
      const lines = pending.map((a: any, i: number) =>
        `${i + 1}. [${a.type}] ${a.summary}${levelLabel(a.escalation_level)}`
      ).join('\n');
      sendReply(zachPhone, `${pending.length} pending:\n${lines}\n\nReply YES/NO/#/LATER`);
    }

  } else if (cmd === 'RESET' || cmd === 'NEW') {
    db.prepare('DELETE FROM graph_state WHERE key = ?').run(QUINN_SESSION_KEY);
    sendReply(zachPhone, 'Fresh Quinn conversation started.');
    console.log('[iMessage] Quinn session reset');

  } else {
    // Not a command — it's conversation. Route to Quinn.
    console.log(`[iMessage] \u2192 Quinn: "${text.trim().slice(0, 80)}"`);
    await quinnChat(db, text.trim(), zachPhone);
  }
}

/**
 * Main polling loop.
 */
export async function startListener(): Promise<void> {
  const db = getDb();
  const zachPhone = getConfig(db, 'notify_phone_number');

  if (!zachPhone) {
    console.error('[iMessage] No phone number configured. Run: recall config notify_phone_number "+1XXXXXXXXXX"');
    process.exit(1);
  }

  // Get last processed message ROWID
  let lastRowId = parseInt(
    (db.prepare("SELECT value FROM graph_state WHERE key = ?").get(STATE_KEY) as any)?.value || '0'
  );

  // First run: start from the newest message — never replay history
  if (!lastRowId) {
    try {
      const msgDb = new Database(MESSAGES_DB, { readonly: true, fileMustExist: true });
      lastRowId = (msgDb.prepare('SELECT MAX(ROWID) as m FROM message').get() as any)?.m || 0;
      msgDb.close();
      db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run(STATE_KEY, String(lastRowId));
      console.log(`[iMessage] First run \u2014 starting from ROWID ${lastRowId}`);
    } catch (err: any) {
      console.error(`[iMessage] Could not read chat.db for initial ROWID: ${err.message}`);
    }
  }

  console.log(`[iMessage] Listener started. Monitoring replies from ${zachPhone}`);
  console.log(`[iMessage] Last processed ROWID: ${lastRowId}`);
  console.log(`[iMessage] Commands: YES/Y, NO/N, #, LATER/SNOOZE, STATUS, LIST, RESET/NEW \u2014 anything else routes to Quinn`);
  console.log(`[iMessage] Polling every ${POLL_INTERVAL / 1000}s\n`);

  let polling = false;
  const poll = async () => {
    if (polling) return; // a Quinn call can outlast the interval — don't overlap
    polling = true;
    try {
      const messages = getNewMessages(lastRowId, zachPhone);

      for (const msg of messages) {
        await processReply(db, msg.text, zachPhone);
        lastRowId = msg.rowid;

        // Persist last processed ROWID
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES (?, ?, datetime('now'))"
        ).run(STATE_KEY, String(lastRowId));
      }
    } catch (err: any) {
      console.error(`[iMessage] Poll error: ${err.message}`);
    } finally {
      polling = false;
    }
  };

  // Initial poll
  await poll();

  // Continuous polling
  setInterval(poll, POLL_INTERVAL);
}
