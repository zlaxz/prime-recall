import OpenAI from 'openai';

export interface ExtractionResult {
  title: string;
  summary: string;
  contacts: string[];
  organizations: string[];
  decisions: string[];
  commitments: string[];
  action_items: string[];
  tags: string[];
  project: string | null;
  importance: 'low' | 'normal' | 'high' | 'critical';
}

const EXTRACTION_PROMPT = `Analyze this content and extract structured intelligence. Return JSON only.

{
  "title": "Brief descriptive title (max 80 chars)",
  "summary": "2-3 sentence summary of what this is about",
  "contacts": ["Full Name of each person mentioned"],
  "organizations": ["Company/org names mentioned"],
  "decisions": ["Any decisions that were made"],
  "commitments": ["Any promises or commitments made by the user"],
  "action_items": ["Specific things that need to be done"],
  "tags": ["relevant", "topic", "tags"],
  "project": "Project name if identifiable, or null",
  "importance": "low|normal|high|critical based on business impact"
}

Rules:
- contacts: Full names only, not email addresses
- organizations: Company names, not domains
- commitments: Only things the USER committed to doing, not others
- action_items: Specific, actionable tasks
- importance: critical = revenue/legal impact, high = relationship/deadline, normal = routine, low = FYI
- project: Only set if clearly related to a known initiative
- Be concise. Summaries under 3 sentences. Title under 80 chars.`;

export async function extractIntelligence(
  content: string,
  apiKey: string,
  model: string = 'gpt-4o-mini'
): Promise<ExtractionResult> {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: content.slice(0, 6000) },
    ],
    temperature: 0.1,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content || '{}';

  try {
    return JSON.parse(text) as ExtractionResult;
  } catch {
    return {
      title: content.slice(0, 80),
      summary: content.slice(0, 200),
      contacts: [],
      organizations: [],
      decisions: [],
      commitments: [],
      action_items: [],
      tags: [],
      project: null,
      importance: 'normal',
    };
  }
}

export async function extractBatch(
  items: { id: string; content: string }[],
  apiKey: string,
  model: string = 'gpt-4o-mini'
): Promise<Map<string, ExtractionResult>> {
  const results = new Map<string, ExtractionResult>();

  // Process in parallel, 5 at a time
  const concurrency = 5;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const extractions = await Promise.all(
      batch.map(async (item) => {
        try {
          const result = await extractIntelligence(item.content, apiKey, model);
          return { id: item.id, result };
        } catch {
          return {
            id: item.id,
            result: {
              title: item.content.slice(0, 80),
              summary: item.content.slice(0, 200),
              contacts: [],
              organizations: [],
              decisions: [],
              commitments: [],
              action_items: [],
              tags: [],
              project: null,
              importance: 'normal' as const,
            },
          };
        }
      })
    );

    for (const { id, result } of extractions) {
      results.set(id, result);
    }
  }

  return results;
}
