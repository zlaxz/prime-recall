import type Database from 'better-sqlite3';
import { getConfig } from '../db.js';
import { getDefaultProvider } from './providers.js';
import { search } from './search.js';

export interface AskResult {
  answer: string;
  sources: { id: string; num: number; title: string; source: string; source_ref: string; similarity?: number }[];
  confidence?: number;
  coverage?: { sources_found: number; recency: string; agreement: string };
}

export async function ask(
  db: Database.Database,
  question: string,
  options: { model?: string; provider?: string } = {}
): Promise<string> {
  const result = await askWithSources(db, question, options);
  return result.answer;
}

export async function askWithSources(
  db: Database.Database,
  question: string,
  options: { model?: string; provider?: string } = {}
): Promise<AskResult> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  const businessContext = getConfig(db, 'business_context') || '';

  // Multi-strategy search with reranking
  const searchResult = await search(db, question, { limit: 15, rerank: true });
  const relevantItems = searchResult.items;

  // Number each source for citation
  const sources = relevantItems.map((item, idx) => ({
    id: item.id,
    num: idx + 1,
    title: item.title,
    source: item.source,
    source_ref: item.source_ref,
    similarity: item.similarity,
  }));

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Build context with numbered citations — include age/staleness
  const knowledgeContext = relevantItems.map((item, idx) => {
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    const commitments = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');
    const orgs = Array.isArray(item.organizations) ? item.organizations : JSON.parse(item.organizations || '[]');

    // Calculate age
    let ageNote = '';
    if (item.source_date) {
      const daysAgo = Math.floor((today.getTime() - new Date(item.source_date).getTime()) / 86400000);
      if (daysAgo > 30) ageNote = ` ⚠ STALE (${daysAgo} days old — may be outdated)`;
      else if (daysAgo > 14) ageNote = ` (${daysAgo} days ago)`;
      else if (daysAgo > 0) ageNote = ` (${daysAgo}d ago)`;
      else ageNote = ' (today)';
    }

    let entry = `[${idx + 1}] (${item.source}) ${item.title}${ageNote}`;
    entry += `\nDate: ${item.source_date || 'unknown'}`;
    entry += `\n${item.summary}`;
    if (item.project) entry += `\nProject: ${item.project}`;
    if (contacts.length) entry += `\nContacts: ${contacts.join(', ')}`;
    if (orgs.length) entry += `\nOrgs: ${orgs.join(', ')}`;
    if (commitments.length) entry += `\nCommitments: ${commitments.join('; ')}`;
    if (item.importance !== 'normal') entry += `\nImportance: ${item.importance}`;
    return entry;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are Prime Recall, an AI Chief of Staff with access to a knowledge base of the user's email history, contacts, relationships, commitments, and business context.

Today's date: ${todayStr}

${businessContext ? `BUSINESS CONTEXT:\n${businessContext}\n\n` : ''}SEARCH QUALITY: confidence=${(searchResult.confidence * 100).toFixed(0)}%, recency=${searchResult.coverage.recency}, agreement=${searchResult.coverage.agreement}, strategy=${searchResult.strategy_used}

KNOWLEDGE BASE (${relevantItems.length} sources):

${knowledgeContext || 'No relevant knowledge found.'}

RULES — INFORMATION QUALITY:
1. CITE SOURCES: Every factual claim must include [N] citation. This builds trust.
2. TEMPORAL AWARENESS: Always note WHEN information is from. "As of March 15th [3]..." not just "The deadline is Friday [3]."
3. STALENESS: Items marked ⚠ STALE may be outdated. Flag this: "Based on [3] from 45 days ago — this may have changed. Recommend verifying."
4. SUPERSEDED INFO: If multiple sources discuss the same topic at different dates, PRIORITIZE the most recent. Note: "This updates the earlier info from [2]."
5. CONFLICTS: If sources contradict each other, surface BOTH with dates and let the user decide. "Per [3] (Mar 10) the deadline was Friday, but [7] (Mar 18) suggests it moved to next week."
6. SPECIFICITY: Use names, dates, dollar amounts, and facts from sources. Never be vague when the data is specific.
7. DROPPED BALLS: If someone is waiting on the user (awaiting_reply tag), flag it prominently with how many days.
8. IMPORTANCE: Weight critical > high > normal > low when prioritizing.
9. DON'T FABRICATE: If the knowledge base doesn't contain the answer, say so. "I don't have information about X in your knowledge base."
10. Be concise and actionable. End with a "Sources:" section listing cited source numbers, titles, dates, and origins.`;

  const answer = await provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    { temperature: 0.3, max_tokens: 2000 }
  );

  return { answer, sources, confidence: searchResult.confidence, coverage: searchResult.coverage };
}
