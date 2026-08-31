import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../src/db.js';
import { sendEmail } from '../src/connectors/gmail.js';

// Prime self-heal alert dispatcher.
// Usage: npx tsx scripts/prime-alert.ts "<message>"
// Sends via the working Gmail service-account path (iMessage on the Mini is dead).
// Recipients come from config: alert_email (default below) + optional alert_sms_gateway
// (carrier email-to-SMS, e.g. "15551234567@vtext.com").

const msg = process.argv.slice(2).join(' ').trim();
if (!msg) {
  console.error('usage: prime-alert <message>');
  process.exit(1);
}

const db = new Database(process.env.HOME + '/.prime/prime.db');

function cfg(key: string, def = ''): string {
  try {
    const v = getConfig(db, key);
    if (v == null) return def;
    return typeof v === 'string' ? v : String(v);
  } catch {
    return def;
  }
}

const email = cfg('alert_email', 'zach.stock@recaptureinsurance.com');
const smsGateway = cfg('alert_sms_gateway', ''); // e.g. 15551234567@vtext.com
const imessage = cfg('alert_imessage', 'zach.stock@recaptureinsurance.com'); // handle or +1number; '' to disable
const subject = `[SYSTEM] ${msg.slice(0, 70)}`;

// iMessage via Messages.app. Works only when invoked from a GUI-session process
// (the com.prime.health LaunchAgent is one). execFileSync = no shell, so the only
// escaping needed is AppleScript string escaping (\ and ").
function sendIMessage(handle: string, text: string): boolean {
  const safe = text.slice(0, 300).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Messages" to send "${safe}" to participant "${handle}"`;
  try {
    execFileSync('osascript', ['-e', script], { timeout: 15000, stdio: 'pipe' });
    return true;
  } catch (e: any) {
    console.log(`imessage FAILED: ${String(e.stderr || e.message || e).slice(0, 160)}`);
    return false;
  }
}

(async () => {
  let ok = false;

  if (imessage) {
    if (sendIMessage(imessage, `Prime: ${msg}`)) {
      ok = true;
      console.log(`imessage -> ${imessage}`);
    }
  }

  if (email) {
    const r = await sendEmail(db, { to: email, subject, body: msg, html: false });
    ok = r.success || ok;
    console.log(r.success ? `email -> ${email}` : `email FAILED: ${r.error}`);
  }

  // SMS via carrier email-to-SMS gateway — short body, no subject noise.
  if (smsGateway) {
    const smsBody = msg.slice(0, 300);
    const r = await sendEmail(db, { to: smsGateway, subject: 'PRIME', body: smsBody, html: false });
    ok = r.success || ok;
    console.log(r.success ? `sms -> ${smsGateway}` : `sms FAILED: ${r.error}`);
  }

  process.exit(ok ? 0 : 1);
})();
