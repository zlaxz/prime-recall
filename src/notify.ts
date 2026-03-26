import { execSync } from 'child_process';
import { platform } from 'os';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig, insertKnowledge, type KnowledgeItem } from './db.js';

// ============================================================
// Multi-Channel Notification System
// ============================================================

export type NotifyUrgency = 'critical' | 'high' | 'normal' | 'fyi';

export interface NotifyOptions {
  title: string;
  body: string;
  urgency: NotifyUrgency;
  agent?: string;          // Which agent is notifying (e.g., 'carefront-pm')
  project?: string;
  actionRequired?: string; // What the user needs to do
  channels?: ('imessage' | 'email' | 'macos' | 'recall')[]; // Override auto-routing
}

/**
 * Channel routing based on urgency:
 * - CRITICAL: iMessage + email + macOS + recall
 * - HIGH: iMessage + recall
 * - NORMAL: email digest (saved to recall, batched email later)
 * - FYI: recall only
 */
function resolveChannels(urgency: NotifyUrgency): ('imessage' | 'email' | 'macos' | 'recall')[] {
  switch (urgency) {
    case 'critical': return ['imessage', 'email', 'macos', 'recall'];
    case 'high': return ['imessage', 'recall'];
    case 'normal': return ['email', 'recall'];
    case 'fyi': return ['recall'];
  }
}

/**
 * Send a notification through the appropriate channels.
 */
export async function notify(db: Database.Database, options: NotifyOptions): Promise<{
  channels: string[];
  errors: string[];
}> {
  const channels = options.channels || resolveChannels(options.urgency);
  const results: string[] = [];
  const errors: string[] = [];

  const agentLabel = options.agent ? `[${options.agent}] ` : '';
  const fullTitle = `${agentLabel}${options.title}`;

  // ── Always save to Prime Recall ──
  if (channels.includes('recall')) {
    try {
      const item: KnowledgeItem = {
        id: uuid(),
        title: fullTitle,
        summary: options.body,
        source: 'agent-notification',
        source_ref: `notification:${Date.now()}`,
        source_date: new Date().toISOString(),
        tags: [
          'notification',
          `urgency:${options.urgency}`,
          ...(options.agent ? [`agent:${options.agent}`] : []),
          ...(options.actionRequired ? ['action-required'] : []),
        ],
        project: options.project,
        importance: options.urgency === 'critical' ? 'critical' : options.urgency === 'high' ? 'high' : 'normal',
        metadata: {
          notification_type: 'agent-push',
          agent: options.agent,
          urgency: options.urgency,
          action_required: options.actionRequired,
          channels_used: channels,
        },
      };
      insertKnowledge(db, item);
      results.push('recall');
    } catch (err: any) {
      errors.push(`recall: ${err.message}`);
    }
  }

  // ── iMessage ──
  if (channels.includes('imessage') && platform() === 'darwin') {
    try {
      const phoneNumber = getConfig(db, 'notify_phone_number');
      if (phoneNumber) {
        const message = `${fullTitle}\n\n${options.body}${options.actionRequired ? `\n\nAction needed: ${options.actionRequired}` : ''}`;
        // Escape for AppleScript
        const escaped = message
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');

        execSync(
          `osascript -e 'tell application "Messages" to send "${escaped}" to buddy "${phoneNumber}"'`,
          { timeout: 10000 }
        );
        results.push('imessage');
      } else {
        errors.push('imessage: no phone number configured (set with: recall config notify_phone_number "+1XXXXXXXXXX")');
      }
    } catch (err: any) {
      errors.push(`imessage: ${err.message?.slice(0, 100)}`);
    }
  }

  // ── Email ──
  if (channels.includes('email')) {
    try {
      const gmailTokens = getConfig(db, 'gmail_tokens');
      const userEmail = getConfig(db, 'gmail_email');

      if (gmailTokens && userEmail) {
        await sendGmailNotification(gmailTokens, userEmail, fullTitle, options);
        results.push('email');
      } else {
        errors.push('email: Gmail not connected (run: recall connect gmail)');
      }
    } catch (err: any) {
      errors.push(`email: ${err.message?.slice(0, 100)}`);
    }
  }

  // ── macOS notification ──
  if (channels.includes('macos') && platform() === 'darwin') {
    try {
      const escaped = options.body.replace(/"/g, '\\"').slice(0, 200);
      const titleEscaped = fullTitle.replace(/"/g, '\\"');
      execSync(
        `osascript -e 'display notification "${escaped}" with title "${titleEscaped}" sound name "Glass"'`,
        { timeout: 5000 }
      );
      results.push('macos');
    } catch (err: any) {
      errors.push(`macos: ${err.message?.slice(0, 100)}`);
    }
  }

  return { channels: results, errors };
}

// ============================================================
// Gmail send (self-email for notifications)
// ============================================================

async function sendGmailNotification(
  tokens: any,
  userEmail: string,
  subject: string,
  options: NotifyOptions
): Promise<void> {
  const { google } = await import('googleapis');

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const urgencyEmoji = {
    critical: '🔴',
    high: '🟠',
    normal: '🔵',
    fyi: '⚪',
  };

  const htmlBody = `
<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #1a1a2e; color: white; padding: 16px 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0; font-size: 18px;">${urgencyEmoji[options.urgency]} ${subject}</h2>
    ${options.agent ? `<p style="margin: 4px 0 0; opacity: 0.7; font-size: 13px;">From: ${options.agent}</p>` : ''}
  </div>
  <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e0e0e0;">
    <p style="white-space: pre-wrap; line-height: 1.6;">${options.body}</p>
    ${options.actionRequired ? `
    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 12px; margin-top: 16px;">
      <strong>Action needed:</strong> ${options.actionRequired}
    </div>
    ` : ''}
    ${options.project ? `<p style="color: #666; font-size: 13px; margin-top: 16px;">Project: ${options.project}</p>` : ''}
  </div>
  <div style="background: #e9ecef; padding: 12px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #666;">
    Prime Recall Agent Notification • ${new Date().toLocaleString()}
  </div>
</div>`;

  // Build RFC 2822 message
  const message = [
    `From: Prime Recall <${userEmail}>`,
    `To: ${userEmail}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ].join('\r\n');

  const encodedMessage = Buffer.from(message).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
    },
  });
}

// ============================================================
// CLI helper: configure notification settings
// ============================================================

export function configureNotifications(db: Database.Database, key: string, value: string): void {
  const validKeys = ['notify_phone_number', 'notify_email', 'notify_channels'];
  if (!validKeys.includes(key)) {
    console.log(`  Unknown config key: ${key}. Valid: ${validKeys.join(', ')}`);
    return;
  }
  setConfig(db, key, value);
  console.log(`  ✓ Set ${key} = ${value}`);
}
