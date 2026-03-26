import OpenAI from 'openai';
import type { Database as SqlJsDatabase } from 'sql.js';
import { searchByEmbedding, searchByText, getConfig } from '../db.js';
import { generateEmbedding } from '../embedding.js';

export async function ask(
  db: SqlJsDatabase,
  question: string,
  options: { model?: string; provider?: string } = {}
): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  // Get business context
  const businessContext = getConfig(db, 'business_context') || '';

  // Semantic search for relevant knowledge
  let relevantItems: any[] = [];
  try {
    const queryEmb = await generateEmbedding(question, apiKey);
    relevantItems = searchByEmbedding(db, queryEmb, 15, 0.25);
  } catch {
    relevantItems = searchByText(db, question, 15);
  }

  // Also do text search to catch exact matches semantic might miss
  const textResults = searchByText(db, question, 10);
  for (const tr of textResults) {
    if (!relevantItems.find(r => r.id === tr.id)) {
      relevantItems.push(tr);
    }
  }

  // Build context from knowledge
  const knowledgeContext = relevantItems.map(item => {
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    const commitments = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
    const orgs = Array.isArray(item.organizations) ? item.organizations : JSON.parse(item.organizations || '[]');

    let entry = `[${item.source}] ${item.title}\n${item.summary}`;
    if (contacts.length) entry += `\nContacts: ${contacts.join(', ')}`;
    if (orgs.length) entry += `\nOrgs: ${orgs.join(', ')}`;
    if (commitments.length) entry += `\nCommitments: ${commitments.join('; ')}`;
    if (item.importance !== 'normal') entry += `\nImportance: ${item.importance}`;
    if (item.source_date) entry += `\nDate: ${item.source_date}`;
    return entry;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are Prime, an AI Chief of Staff. You have access to a knowledge base containing the user's email history, contacts, relationships, commitments, and business context. Answer questions based on this real data — be specific, use names, dates, and facts from the knowledge base.

${businessContext ? `BUSINESS CONTEXT:\n${businessContext}\n\n` : ''}Today's date: ${new Date().toISOString().split('T')[0]}

KNOWLEDGE BASE (${relevantItems.length} relevant items):

${knowledgeContext || 'No relevant knowledge found.'}

RULES:
- Be specific. Use names, dates, and facts from the knowledge above.
- If asked about priorities, weight by importance (critical > high > normal > low).
- If someone is waiting on the user (awaiting_reply tag), flag it.
- Don't make up information not in the knowledge base.
- Be concise and actionable.`;

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
    max_tokens: 1500,
  });

  return response.choices[0]?.message?.content || 'Unable to generate response.';
}
