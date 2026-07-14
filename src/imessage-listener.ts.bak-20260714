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
const POLL_INTERVAL = 30_000; // 30 seconds
const STATE_KEY = 'imessage_listener_last_rowid';

/**
 * Read recent incoming messages from Zach's phone number.
 */
function getNewMessages(lastRowId: number, zachPhone: string): { rowid: number; text: string; date: number }[] {
  if (!existsSync(MESSAGES_DB)) return [];

  try {
    // Read-only connection to Messages database
    const msgDb = new Database(MESSAGES_DB, { readonly: true, fileMustExist: true });

    const rows = msgDb.prepare(`
      SELECT m.ROWID as rowid, m.text, m.date
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id LIKE ?
        AND m.is_from_me = 0
        AND m.ROWID > ?
        AND m.text IS NOT NULL
      ORDER BY m.ROWID ASC
      LIMIT 10
    `).all(`%${zachPhone.replace(/[^0-9]/g, '').slice(-10)}%`, lastRowId) as any[];

    msgDb.close();
    return rows;
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

  } else {
    // Unknown command — ignore silently (might be a normal conversation)
    console.log(`[iMessage] Ignored unrecognized: "${text.trim().slice(0, 50)}"`);
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

  console.log(`[iMessage] Listener started. Monitoring replies from ${zachPhone}`);
  console.log(`[iMessage] Last processed ROWID: ${lastRowId}`);
  console.log(`[iMessage] Commands: YES/Y, NO/N, #, LATER/SNOOZE, STATUS, LIST`);
  console.log(`[iMessage] Polling every ${POLL_INTERVAL / 1000}s\n`);

  const poll = async () => {
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
    }
  };

  // Initial poll
  await poll();

  // Continuous polling
  setInterval(poll, POLL_INTERVAL);
}
