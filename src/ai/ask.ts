import OpenAI from 'openai';
import type { Database as SqlJsDatabase } from 'sql.js';
import { searchByEmbedding, searchByText, getConfig } from '../db.js';
import { generateEmbedding } from '../embedding.js';

export interface AskResult {
  answer: string;
  sources: { id: string; title: string; source: string; source_ref: string; similarity?: number }[];
}

export async function ask(
  db: SqlJsDatabase,
  question: string,
  options: { model?: string; provider?: string } = {}
): Promise<string> {
  const result = await askWithSources(db, question, options);
  return result.answer;
}

export async function askWithSources(
  db: SqlJsDatabase,
  question: string,
  options: { model?: string; provider?: string } = {}
): Promise<AskResult> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const businessContext = getConfig(db, 'business_context') || '';

  // Semantic search for relevant knowledge
  let relevantItems: any[] = [];
  try {
    const queryEmb = await generateEmbedding(question, apiKey);
    relevantItems = searchByEmbedding(db, queryEmb, 15, 0.25);
  } catch {
    relevantItems = searchByText(db, question, 15);
  }

  // Also do text search to catch exact matches
  const textResults = searchByText(db, question, 10);
  for (const tr of textResults) {
    if (!relevantItems.find(r => r.id === tr.id)) {
      relevantItems.push(tr);
    }
  }

  // Number each source for citation
  const sources = relevantItems.map((item, idx) => ({
    id: item.id,
    num: idx + 1,
    title: item.title,
    source: item.source,
    source_ref: item.source_ref,
    similarity: item.similarity,
  }));

  // Build context with numbered citations
  const knowledgeContext = relevantItems.map((item, idx) => {
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    const commitments = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
    const orgs = Array.isArray(item.organizations) ? item.organizations : JSON.parse(item.organizations || '[]');

    let entry = `[${idx + 1}] (${item.source}) ${item.title}\n${item.summary}`;
    if (contacts.length) entry += `\nContacts: ${contacts.join(', ')}`;
    if (orgs.length) entry += `\nOrgs: ${orgs.join(', ')}`;
    if (commitments.length) entry += `\nCommitments: ${commitments.join('; ')}`;
    if (item.importance !== 'normal') entry += `\nImportance: ${item.importance}`;
    if (item.source_date) entry += `\nDate: ${item.source_date}`;
    return entry;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are Prime Recall, an AI Chief of Staff with access to a knowledge base of the user's email history, contacts, relationships, commitments, and business context.

CRITICAL: Cite your sources. When referencing information from the knowledge base, include the source number in brackets like [1], [3], [7]. Every factual claim must have a citation. This builds trust.

${businessContext ? `BUSINESS CONTEXT:\n${businessContext}\n\n` : ''}Today's date: ${new Date().toISOString().split('T')[0]}

KNOWLEDGE BASE (${relevantItems.length} sources):

${knowledgeContext || 'No relevant knowledge found.'}

RULES:
- ALWAYS cite sources with [N] notation when referencing knowledge base items.
- Be specific — use names, dates, and facts from the sources above.
- If asked about priorities, weight by importance (critical > high > normal > low).
- If someone is waiting on the user (awaiting_reply tag), flag it prominently.
- Don't make up information not in the knowledge base. If you don't know, say so.
- Be concise and actionable.
- End with a "Sources:" section listing the cited source numbers, titles, and origins.`;

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });

  const answer = response.choices[0]?.message?.content || 'Unable to generate response.';

  return { answer, sources };
}
