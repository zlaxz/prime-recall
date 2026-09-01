import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligenceV2, toV1 } from '../ai/extract.js';
import { getServiceAccountAuth } from './gmail.js';

// Scan Google Drive for recent documents via service account
export async function scanDrive(
  db: Database.Database,
  options: { days?: number; maxFiles?: number; sourceAccount: string } = { sourceAccount: '' }
): Promise<{ files: number; items: number }> {
  const days = options.days || 30;
  const maxFiles = options.maxFiles || 100;

  if (!options.sourceAccount) throw new Error('sourceAccount required for Drive scanning');

  const auth = getServiceAccountAuth(options.sourceAccount, ['https://www.googleapis.com/auth/drive.readonly']);
  if (!auth) throw new Error('Service account not configured');

  const drive = google.drive({ version: 'v3', auth });

  // Find recently modified docs, sheets, slides, PDFs
  const afterDate = new Date(Date.now() - days * 86400000).toISOString();
  const query = `modifiedTime > '${afterDate}' and trashed = false and (mimeType contains 'document' or mimeType contains 'spreadsheet' or mimeType contains 'presentation' or mimeType = 'application/pdf')`;

  const response = await drive.files.list({
    q: query,
    pageSize: maxFiles,
    fields: 'files(id, name, mimeType, modifiedTime, createdTime, owners, lastModifyingUser, webViewLink, parents)',
    orderBy: 'modifiedTime desc',
  });

  const files = response.data.files || [];
  if (files.length === 0) return { files: 0, items: 0 };

  console.log(`  Drive (${options.sourceAccount}): ${files.length} recent files`);

  let items = 0;
  const apiKey = (db.prepare("SELECT value FROM config WHERE key = 'openai_api_key'").get() as any)?.value;

  for (const file of files) {
    const sourceRef = `drive:${file.id}`;

    // Dedup per account
    const existing = db.prepare(
      'SELECT id FROM knowledge WHERE source_ref = ? AND (source_account = ? OR source_account IS NULL)'
    ).get(sourceRef, options.sourceAccount) as any;

    if (existing) continue;

    // Try to get text content for Google Docs/Sheets/Slides
    let content = '';
    try {
      if (file.mimeType?.includes('document') || file.mimeType?.includes('spreadsheet') || file.mimeType?.includes('presentation')) {
        const exported = await drive.files.export({
          fileId: file.id!,
          mimeType: 'text/plain',
        });
        content = (typeof exported.data === 'string' ? exported.data : '').slice(0, 10000);
      }
    } catch {
      // Can't export — just index metadata
    }

    const ownerName = file.owners?.[0]?.displayName || options.sourceAccount;
    const modifiedBy = file.lastModifyingUser?.displayName || ownerName;

    // Build a summary from metadata + content preview
    const summary = content
      ? `${file.name} (${file.mimeType?.split('.').pop() || 'document'}). Modified by ${modifiedBy}. Content preview: ${content.slice(0, 500)}`
      : `${file.name} (${file.mimeType?.split('.').pop() || 'document'}). Modified by ${modifiedBy}. No text content available.`;

    // AI extraction if we have content
    let ext: any = { title: file.name, summary, contacts: [ownerName], organizations: [], decisions: [], commitments: [], action_items: [], tags: ['drive'], project: '' };
    if (content.length > 100 && apiKey) {
      try {
        const v2 = await extractIntelligenceV2('Document: ' + file.name + '\n\nContent:\n' + content.slice(0, 5000), apiKey);
        ext = toV1(v2);
        ext.tags = [...(ext.tags || []), 'drive'];
      } catch (_e) {}
    }

    let embedding: number[] | undefined = undefined;
    try {
      embedding = await generateEmbedding(ext.summary, apiKey);
    } catch (_e) {}

    const item: KnowledgeItem = {
      id: uuid(),
      title: ext.title || file.name || 'Drive document',
      summary: ext.summary || summary,
      source: 'drive',
      source_ref: sourceRef,
      source_date: file.modifiedTime || new Date().toISOString(),
      contacts: ext.contacts || [ownerName],
      organizations: ext.organizations || [],
      decisions: ext.decisions || [],
      commitments: ext.commitments || [],
      action_items: ext.action_items || [],
      tags: ext.tags || ['drive'],
      project: ext.project || '',
      importance: ext.importance || 'normal',
      embedding,
      source_account: options.sourceAccount,
      metadata: {
        drive_file_id: file.id,
        mime_type: file.mimeType,
        web_link: file.webViewLink,
        owner: ownerName,
        modified_by: modifiedBy,
        has_content: content.length > 0,
      },
    };

    insertKnowledge(db, item);
    items++;
  }

  return { files: files.length, items };
}
