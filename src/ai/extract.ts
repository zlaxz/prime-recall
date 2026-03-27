import { getDefaultProvider, type LLMProvider } from './providers.js';

// Cache business context to avoid reading DB every call
let _cachedBusinessContext: string | null = null;
let _contextLoadedAt = 0;

// Cache the provider instance
let _cachedProvider: LLMProvider | null = null;

export function setBusinessContext(ctx: string) {
  _cachedBusinessContext = ctx;
  _contextLoadedAt = Date.now();
}

export async function loadBusinessContext(): Promise<string> {
  // Cache for 5 minutes
  if (_cachedBusinessContext && Date.now() - _contextLoadedAt < 300000) {
    return _cachedBusinessContext;
  }

  try {
    // Dynamic import to avoid circular dependency
    const { getDb, getConfig } = await import('../db.js');
    const db = getDb();
    const ctx = getConfig(db, 'business_context');
    if (ctx) {
      _cachedBusinessContext = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
      _contextLoadedAt = Date.now();
      return _cachedBusinessContext;
    }
  } catch {}

  return '';
}

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

async function getProvider(apiKey?: string): Promise<LLMProvider> {
  if (_cachedProvider) return _cachedProvider;
  _cachedProvider = await getDefaultProvider(apiKey);
  return _cachedProvider;
}

export async function extractIntelligence(
  content: string,
  apiKey?: string,
  _model?: string,
  businessContext?: string
): Promise<ExtractionResult> {
  const provider = await getProvider(apiKey);

  // Auto-load business context if not passed
  const ctx = businessContext || await loadBusinessContext();
  let systemPrompt = EXTRACTION_PROMPT;
  if (ctx) {
    systemPrompt += `\n\nBUSINESS CONTEXT (use this to correctly assign projects and importance):\n${ctx}`;
  }

  const response = await provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: content.slice(0, 6000) },
    ],
    { temperature: 0.1, max_tokens: 1000, json: true }
  );

  try {
    return JSON.parse(response) as ExtractionResult;
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

// ============================================================
// V2 Provenance-First Extraction
// ============================================================

export interface ExtractedContactV2 {
  name: string;
  email: string | null;
  role: string | null;
  organization: string | null;
  quote: string;
  confidence: number;
}

export interface ExtractedFactV2 {
  text: string;
  quote: string;
  confidence: number;
  who: string | null;
}

export interface ExtractionResultV2 {
  schema_version: 2;
  title: string;
  summary: string;
  contacts: ExtractedContactV2[];
  organizations: { name: string; domain: string | null; quote: string; confidence: number }[];
  decisions: ExtractedFactV2[];
  commitments: (ExtractedFactV2 & { owner: string | null; assigned_to: string | null; due_hint: string | null })[];
  action_items: (ExtractedFactV2 & { assignee: string | null; due_hint: string | null })[];
  tags: string[];
  project: { name: string; evidence: string[]; confidence: number } | null;
  importance: 'low' | 'normal' | 'high' | 'critical';
  importance_reasoning: string;
}

const EXTRACTION_PROMPT_V2 = `Extract structured intelligence from the source text. Every extraction MUST include an exact quote from the source.

Return JSON matching this schema:
{
  "schema_version": 2,
  "title": "Brief descriptive title (max 80 chars)",
  "summary": "2-3 sentences about what this is and why it matters",
  "contacts": [{"name": "Full Name", "email": "email@domain.com or null", "role": "their title/role or null", "organization": "company or null", "quote": "exact text where they appear", "confidence": 0.95}],
  "organizations": [{"name": "Org Name", "domain": "domain.com or null", "quote": "exact text where they appear", "confidence": 0.95}],
  "decisions": [{"text": "what was decided", "who": "who decided or null", "quote": "exact source text", "confidence": 0.9}],
  "commitments": [{"text": "what was promised", "owner": "who promised or null", "assigned_to": "who acts or null", "due_hint": "deadline text or null", "quote": "exact source text", "confidence": 0.9}],
  "action_items": [{"text": "what needs doing", "assignee": "who or null", "due_hint": "deadline or null", "quote": "exact source text", "confidence": 0.85}],
  "tags": ["relevant", "tags"],
  "project": {"name": "Project Name", "evidence": ["quote supporting this classification"], "confidence": 0.9} or null,
  "importance": "low|normal|high|critical",
  "importance_reasoning": "one sentence explaining the rating"
}

CRITICAL RULES:
1. QUOTES ARE MANDATORY. Every contact, decision, commitment, action item MUST include a "quote" field with an EXACT substring from the source. If you cannot quote the source, do not include the item.
2. EXTRACT EMAIL ADDRESSES when present. Parse "Name <email>" format. Do NOT strip emails.
3. Confidence: 1.0 = explicit, 0.8 = strongly implied, 0.6 = inferred. Below 0.6 = don't extract.
4. Commitments = PROMISES someone made. Action items = TASKS that need doing (not promised).
5. importance: critical = revenue/legal, high = key relationship/deadline, normal = routine, low = FYI.
6. Empty arrays for categories with no extractions. Do not invent items.`;

// Cache entity registry (reload every 5 minutes)
let _cachedRegistry: { contacts: string[]; projects: string[] } | null = null;
let _registryLoadedAt = 0;

async function loadEntityRegistry(): Promise<{ contacts: string[]; projects: string[] }> {
  if (_cachedRegistry && Date.now() - _registryLoadedAt < 300000) return _cachedRegistry;

  try {
    const { getDb } = await import('../db.js');
    const db = getDb();

    const contacts = (db.prepare(
      "SELECT DISTINCT canonical_name FROM entities WHERE type = 'person' AND user_dismissed = 0 ORDER BY canonical_name"
    ).all() as any[]).map(r => r.canonical_name);

    const projects = (db.prepare(
      "SELECT DISTINCT project FROM knowledge WHERE project IS NOT NULL AND project != '' GROUP BY project HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC"
    ).all() as any[]).map(r => r.project);

    _cachedRegistry = { contacts, projects };
    _registryLoadedAt = Date.now();
    return _cachedRegistry;
  } catch {
    return { contacts: [], projects: [] };
  }
}

export async function extractIntelligenceV2(
  content: string,
  apiKey?: string,
  businessContext?: string,
  entityRegistry?: { contacts: string[]; projects: string[] }
): Promise<ExtractionResultV2> {
  const provider = await getProvider(apiKey);

  // Auto-load entity registry if not provided
  const registry = entityRegistry || await loadEntityRegistry();

  const ctx = businessContext || await loadBusinessContext();
  let systemPrompt = EXTRACTION_PROMPT_V2;
  if (ctx) {
    systemPrompt += `\n\nBUSINESS CONTEXT:\n${ctx}`;
  }
  if (registry.contacts.length) {
    systemPrompt += `\n\nKNOWN CONTACTS (use these canonical names when matching):\n${registry.contacts.slice(0, 50).join(', ')}`;
  }
  if (registry.projects.length) {
    systemPrompt += `\n\nKNOWN PROJECTS (ONLY assign to these projects — if no match, set project to null):\n${registry.projects.join(', ')}`;
  }

  const response = await provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: content.slice(0, 12000) },
    ],
    { temperature: 0.1, max_tokens: 2500, json: true }
  );

  try {
    const result = JSON.parse(response) as ExtractionResultV2;
    return validateExtractionV2(result, content);
  } catch {
    // V2 parse failed — return minimal result, do NOT fall back to V1 (source of hallucinations)
    return {
      schema_version: 2,
      title: content.slice(0, 80).replace(/\n/g, ' '),
      summary: content.slice(0, 200).replace(/\n/g, ' '),
      contacts: [],
      organizations: [],
      decisions: [],
      commitments: [],
      action_items: [],
      tags: [],
      project: null,
      importance: 'normal',
      importance_reasoning: 'V2 extraction failed — minimal result',
    };
  }
}

function validateExtractionV2(result: ExtractionResultV2, sourceContent: string): ExtractionResultV2 {
  const source = sourceContent.toLowerCase();

  // Validate quotes — drop items whose quotes can't be found
  result.contacts = result.contacts.filter(c => {
    if (!c.quote) return false;
    return source.includes(c.quote.toLowerCase().slice(0, 40));
  });
  result.decisions = result.decisions.filter(d => {
    if (!d.quote) return false;
    return source.includes(d.quote.toLowerCase().slice(0, 40));
  });
  result.commitments = result.commitments.filter(c => {
    if (!c.quote) return false;
    return source.includes(c.quote.toLowerCase().slice(0, 40));
  });
  result.action_items = result.action_items.filter(a => {
    if (!a.quote) return false;
    return source.includes(a.quote.toLowerCase().slice(0, 40));
  });

  // Drop low confidence
  result.contacts = result.contacts.filter(c => c.confidence >= 0.6);
  result.decisions = result.decisions.filter(d => d.confidence >= 0.6);
  result.commitments = result.commitments.filter(c => c.confidence >= 0.6);
  result.action_items = result.action_items.filter(a => a.confidence >= 0.6);

  // Validate project evidence — must have quotes
  if (result.project && (!result.project.evidence || result.project.evidence.length === 0)) {
    result.project = null;
  }

  // Validate project name against known projects
  if (result.project) {
    const registry = _cachedRegistry;
    if (registry && registry.projects.length > 0) {
      const known = registry.projects.map(p => p.toLowerCase());
      const projectLower = result.project.name.toLowerCase();
      if (!known.some(k => k.includes(projectLower) || projectLower.includes(k))) {
        // Project not in known list — reject it
        result.project = null;
      }
    }
  }

  result.schema_version = 2;
  return result;
}

function v1ToV2(v1: ExtractionResult): ExtractionResultV2 {
  return {
    schema_version: 2,
    title: v1.title,
    summary: v1.summary,
    contacts: v1.contacts.map(c => ({ name: c, email: null, role: null, organization: null, quote: '', confidence: 0.5 })),
    organizations: v1.organizations.map(o => ({ name: o, domain: null, quote: '', confidence: 0.5 })),
    decisions: v1.decisions.map(d => ({ text: d, who: null, quote: '', confidence: 0.5 })),
    commitments: v1.commitments.map(c => ({ text: c, who: null, owner: null, assigned_to: null, due_hint: null, quote: '', confidence: 0.5 })),
    action_items: v1.action_items.map(a => ({ text: a, who: null, assignee: null, due_hint: null, quote: '', confidence: 0.5 })),
    tags: v1.tags,
    project: v1.project ? { name: v1.project, evidence: [], confidence: 0.5 } : null,
    importance: v1.importance,
    importance_reasoning: '',
  };
}

export function toV1(v2: ExtractionResultV2): ExtractionResult {
  return {
    title: v2.title,
    summary: v2.summary,
    contacts: v2.contacts.map(c => c.name),
    organizations: v2.organizations.map(o => o.name),
    decisions: v2.decisions.map(d => d.text),
    commitments: v2.commitments.map(c => c.text),
    action_items: v2.action_items.map(a => a.text),
    tags: v2.tags,
    project: v2.project?.name ?? null,
    importance: v2.importance,
  };
}

// Helper for consumers that need to handle both V1 and V2 contact formats
export function getContactNames(contacts: (string | ExtractedContactV2)[]): string[] {
  return contacts.map(c => typeof c === 'string' ? c : c.name);
}

export function getContactEmails(contacts: (string | ExtractedContactV2)[]): string[] {
  return contacts
    .filter((c): c is ExtractedContactV2 => typeof c !== 'string' && c.email !== null)
    .map(c => c.email!);
}

// ============================================================
// Legacy V1 batch extraction (kept for backward compat)
// ============================================================

export async function extractBatch(
  items: { id: string; content: string }[],
  apiKey?: string,
  _model?: string
): Promise<Map<string, ExtractionResult>> {
  const results = new Map<string, ExtractionResult>();

  // Process in parallel, 3 at a time (claude CLI has its own concurrency limits)
  const concurrency = 3;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const extractions = await Promise.all(
      batch.map(async (item) => {
        try {
          const result = await extractIntelligence(item.content, apiKey);
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
