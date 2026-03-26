import type { Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { getAllKnowledge, getCommitments, insertCommitment, updateCommitmentState, getConfig, searchByText } from '../db.js';
import { getDefaultProvider } from './providers.js';

/**
 * Simple string similarity (Dice coefficient) for deduplication.
 */
function similarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
    return set;
  };

  const ba = bigrams(na);
  const bb = bigrams(nb);
  let intersection = 0;
  for (const b of ba) {
    if (bb.has(b)) intersection++;
  }
  return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Extract commitments from all knowledge items into the commitments table.
 * Called during `recall refine`.
 */
export async function extractCommitments(
  db: SqlJsDatabase,
  options: { verbose?: boolean } = {}
): Promise<{ extracted: number; skipped: number; errors: number }> {
  const log = options.verbose ? console.log : () => {};
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  const items = getAllKnowledge(db);
  const existingCommitments = getCommitments(db);
  const existingTexts = existingCommitments.map((c: any) => c.text as string);

  let extracted = 0;
  let skipped = 0;
  let errors = 0;

  // Collect all items that have commitments in their JSON array
  const itemsWithCommitments: { item: any; commitmentTexts: string[] }[] = [];
  for (const item of items) {
    const commitments = Array.isArray(item.commitments) ? item.commitments : [];
    if (commitments.length > 0) {
      itemsWithCommitments.push({ item, commitmentTexts: commitments });
    }
  }

  if (itemsWithCommitments.length === 0) {
    log('    No commitment texts found in knowledge items');
    return { extracted: 0, skipped: 0, errors: 0 };
  }

  log(`    Found ${itemsWithCommitments.reduce((sum, i) => sum + i.commitmentTexts.length, 0)} commitment texts across ${itemsWithCommitments.length} items`);

  // Batch process commitments through Claude for enrichment
  for (const { item, commitmentTexts } of itemsWithCommitments) {
    for (const text of commitmentTexts) {
      // Dedup check: skip if very similar to an existing commitment
      const isDuplicate = existingTexts.some(existing => similarity(existing, text) > 0.85);
      if (isDuplicate) {
        skipped++;
        continue;
      }

      try {
        const today = new Date().toISOString().split('T')[0];
        const response = await provider.chat(
          [
            {
              role: 'system',
              content: `You are analyzing a commitment/promise extracted from a business knowledge item. Today is ${today}.

Return JSON with these fields:
{
  "owner": "person who made the commitment (null if the user)",
  "assigned_to": "person who needs to act (null if the user)",
  "due_date": "ISO date if a deadline is mentioned or can be inferred, null otherwise",
  "importance": "critical|high|normal|low",
  "context": "brief 1-sentence context about what this commitment is about",
  "state": "detected or active (use active if there's a clear actionable deadline)"
}

Source item context:
- Title: ${item.title}
- Project: ${item.project || 'unknown'}
- Source: ${item.source}
- Date: ${item.source_date || 'unknown'}
- Contacts: ${JSON.stringify(item.contacts || [])}`,
            },
            { role: 'user', content: `Commitment text: "${text}"` },
          ],
          { temperature: 0.1, max_tokens: 300, json: true }
        );

        const enriched = JSON.parse(response);

        insertCommitment(db, {
          id: uuid(),
          text,
          owner: enriched.owner || null,
          assigned_to: enriched.assigned_to || null,
          due_date: enriched.due_date || null,
          detected_from: item.id,
          state: enriched.state || 'detected',
          context: enriched.context || null,
          project: item.project || null,
          importance: enriched.importance || 'normal',
        });

        existingTexts.push(text); // Track for dedup within this run
        extracted++;
        log(`    + "${text.slice(0, 60)}..." → ${enriched.state || 'detected'}${enriched.due_date ? ` (due ${enriched.due_date})` : ''}`);
      } catch (err: any) {
        errors++;
        log(`    ! Error enriching "${text.slice(0, 40)}...": ${err.message}`);
      }
    }
  }

  return { extracted, skipped, errors };
}

/**
 * Review all active commitments and update states:
 * - active with past due_date → overdue
 * - overdue for 14+ days → dropped
 * - Check for fulfillment evidence in recent knowledge items
 */
export async function updateCommitmentStates(
  db: SqlJsDatabase,
  options: { verbose?: boolean } = {}
): Promise<{ newOverdue: number; newDropped: number; newFulfilled: number }> {
  const log = options.verbose ? console.log : () => {};
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  const now = new Date();
  const nowISO = now.toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString();

  let newOverdue = 0;
  let newDropped = 0;
  let newFulfilled = 0;

  // 1. Active with past due_date → overdue
  const activeCommitments = getCommitments(db, { state: 'active' });
  for (const c of activeCommitments) {
    if (c.due_date && c.due_date < nowISO) {
      updateCommitmentState(db, c.id, 'overdue');
      newOverdue++;
      log(`    ! OVERDUE: "${(c.text as string).slice(0, 60)}..." (due ${c.due_date})`);
    }
  }

  // 2. Overdue for 14+ days → dropped
  const overdueCommitments = getCommitments(db, { state: 'overdue' });
  for (const c of overdueCommitments) {
    if (c.due_date && c.due_date < fourteenDaysAgo) {
      updateCommitmentState(db, c.id, 'dropped');
      newDropped++;
      log(`    x DROPPED: "${(c.text as string).slice(0, 60)}..." (due ${c.due_date})`);
    }
  }

  // 3. Check for fulfillment evidence
  const openCommitments = [
    ...getCommitments(db, { state: 'active' }),
    ...getCommitments(db, { state: 'overdue' }),
  ];

  for (const c of openCommitments) {
    // Extract keywords from commitment text for searching
    const keywords = (c.text as string)
      .split(/\s+/)
      .filter((w: string) => w.length > 3)
      .slice(0, 5)
      .join(' ');

    if (!keywords) continue;

    // Search recent knowledge items for evidence
    const candidates = searchByText(db, keywords, 5);
    // Only consider items newer than the commitment
    const recentCandidates = candidates.filter(
      (item: any) => item.source_date && item.source_date > (c.detected_at || c.created_at)
    );

    if (recentCandidates.length === 0) continue;

    // Use Claude to check if any candidate suggests fulfillment
    const candidateSummaries = recentCandidates
      .slice(0, 3)
      .map((item: any, i: number) => `[${i}] ${item.title}: ${item.summary}`)
      .join('\n');

    try {
      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `You are checking if a commitment has been fulfilled based on recent knowledge items.

Return JSON: {"fulfilled": true/false, "evidence_index": 0 (index of the item that shows fulfillment, or null), "confidence": 0.0-1.0}

Only return fulfilled=true if you are confident (>0.7) that the commitment was actually completed.`,
          },
          {
            role: 'user',
            content: `Commitment: "${c.text}"
Project: ${c.project || 'unknown'}

Recent items:
${candidateSummaries}`,
          },
        ],
        { temperature: 0.1, max_tokens: 200, json: true }
      );

      const result = JSON.parse(response);
      if (result.fulfilled && result.confidence > 0.7) {
        const evidenceItem = recentCandidates[result.evidence_index];
        updateCommitmentState(db, c.id, 'fulfilled', evidenceItem?.id);
        newFulfilled++;
        log(`    ✓ FULFILLED: "${(c.text as string).slice(0, 60)}..." (evidence: ${evidenceItem?.title})`);
      }
    } catch {
      // Skip fulfillment check on error
    }
  }

  return { newOverdue, newDropped, newFulfilled };
}

/**
 * Returns structured commitment summary for use in briefings.
 */
export function getCommitmentSummary(db: SqlJsDatabase): {
  fires: any[];
  due_soon: any[];
  active: any[];
  recently_fulfilled: any[];
  dropped: any[];
} {
  const now = new Date();
  const threeDaysFromNow = new Date(now.getTime() + 3 * 86400000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const nowISO = now.toISOString();

  // Overdue commitments sorted by days overdue
  const overdue = getCommitments(db, { state: 'overdue' });
  const fires = overdue.map((c: any) => {
    const daysOverdue = c.due_date
      ? Math.floor((now.getTime() - new Date(c.due_date).getTime()) / 86400000)
      : 0;
    return { ...c, days_overdue: daysOverdue };
  }).sort((a: any, b: any) => b.days_overdue - a.days_overdue);

  // Active commitments due within 3 days
  const active = getCommitments(db, { state: 'active' });
  const due_soon = active.filter(
    (c: any) => c.due_date && c.due_date <= threeDaysFromNow && c.due_date >= nowISO
  );

  // Recently fulfilled (last 7 days)
  const allFulfilled = getCommitments(db, { state: 'fulfilled' });
  const recently_fulfilled = allFulfilled.filter(
    (c: any) => c.state_changed_at && c.state_changed_at >= sevenDaysAgo
  );

  // Dropped
  const dropped = getCommitments(db, { state: 'dropped' });

  return {
    fires,
    due_soon,
    active,
    recently_fulfilled,
    dropped,
  };
}
