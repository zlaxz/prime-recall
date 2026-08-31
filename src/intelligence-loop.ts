import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { getConfig } from './db.js';
import { getBulkProvider, getDefaultProvider } from './ai/providers.js';
import { runClaude } from './utils/claude-spawn.js';

// ============================================================
// Recursive Intelligence Loop
//
// Task 15: Prediction Verification (DeepSeek — bulk check)
// Task 16: Strategic Reflection (Claude — meta-cognition)
//
// Red team mitigations baked in:
// - Source-grounded verification (must cite timestamped data)
// - Impact-weighted predictions (no trivial gaming)
// - Counterfactual validation on action-changing lessons
// - Lesson conflict detection
// - Confidence calibration tracking
// ============================================================

interface TaskResult {
  task: string;
  status: 'success' | 'failed' | 'skipped';
  duration_seconds: number;
  output?: any;
  error?: string;
}

// ── Task 15: Prediction Verification ─────────────────────

export async function task15PredictionVerification(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Get pending predictions due for verification
    const pending = db.prepare(`
      SELECT * FROM predictions
      WHERE outcome = 'pending' AND check_by <= date('now')
      ORDER BY prediction_date ASC LIMIT 20
    `).all() as any[];

    if (pending.length === 0) {
      return { task: '15-prediction-verification', status: 'skipped', duration_seconds: 0, output: { message: 'No predictions due for verification' } };
    }

    // Gather current reality for each prediction
    const verificationsPrompt: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      const pred = pending[i];
      let reality = '';

      if (pred.domain === 'project') {
        const profile = db.prepare("SELECT value FROM graph_state WHERE key = 'project_profiles'").get() as any;
        if (profile) {
          const profiles = JSON.parse(profile.value);
          const match = profiles.find((p: any) => p.project === pred.subject || p.project === pred.project);
          if (match) reality = `Project status: ${match.status}. Reasoning: ${match.status_reasoning || 'N/A'}`;
        }
        // Recent items for this project
        const items = db.prepare(
          "SELECT title, source, source_date FROM knowledge_primary WHERE project = ? AND source_date > ? ORDER BY source_date DESC LIMIT 5"
        ).all(pred.project || pred.subject, pred.prediction_date) as any[];
        if (items.length > 0) {
          reality += '\nRecent activity:\n' + items.map((i: any) => `  ${i.source_date} [${i.source}] ${i.title}`).join('\n');
        }
      } else if (pred.domain === 'entity') {
        const items = db.prepare(`
          SELECT k.title, k.source, k.source_date FROM knowledge_primary k
          JOIN entity_mentions em ON k.id = em.knowledge_item_id
          JOIN entities e ON em.entity_id = e.id
          WHERE e.canonical_name LIKE ? AND k.source_date > ?
          ORDER BY k.source_date DESC LIMIT 5
        `).all(`%${pred.subject}%`, pred.prediction_date) as any[];
        reality = items.length > 0
          ? 'Recent activity:\n' + items.map((i: any) => `  ${i.source_date} [${i.source}] ${i.title}`).join('\n')
          : 'No activity found since prediction was made.';
      } else if (pred.domain === 'commitment') {
        const commitments = db.prepare(
          "SELECT text, state, detected_from FROM commitments WHERE text LIKE ? OR project = ? ORDER BY detected_at DESC LIMIT 3"
        ).all(`%${pred.subject}%`, pred.project || '') as any[];
        reality = commitments.length > 0
          ? commitments.map((c: any) => `Commitment: "${c.text}" — state: ${c.state}`).join('\n')
          : 'No matching commitments found.';
      }

      if (!reality) {
        reality = 'No direct evidence found. Check may be premature.';
      }

      verificationsPrompt.push(
        `[${i + 1}] PREDICTED (${pred.prediction_date}, ${Math.round(pred.confidence * 100)}% confidence):\n` +
        `  "${pred.prediction}"\n` +
        `  Subject: ${pred.subject}\n` +
        `  Reasoning: ${pred.reasoning}\n` +
        `  CURRENT REALITY:\n  ${reality}`
      );
    }

    const prompt = `You are verifying predictions made by an AI Chief of Staff system.
For each prediction, compare what was predicted against current evidence.

IMPORTANT: You MUST cite specific timestamped evidence. Do NOT invent evidence.
If evidence is ambiguous or insufficient, mark as "unverifiable" — do NOT guess.

${verificationsPrompt.join('\n\n')}

Return JSON array:
[{
  "index": 1,
  "outcome": "correct|partially_correct|wrong|unverifiable",
  "evidence": "specific evidence with dates",
  "error_description": "what was wrong (null if correct or unverifiable)"
}]`;

    const provider = await getBulkProvider(getConfig(db, 'openai_api_key') || undefined);
    const response = await provider.chat([{ role: 'user', content: prompt }], { json: true, temperature: 0.1 });

    let results: any[];
    try {
      const parsed = JSON.parse(response.replace(/```json?\s*\n?/g, '').replace(/\n?```/g, ''));
      results = Array.isArray(parsed) ? parsed : parsed.results || parsed.predictions || [];
    } catch {
      return { task: '15-prediction-verification', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'Failed to parse verification results' };
    }

    // Update predictions
    let correct = 0, wrong = 0, partial = 0, unverifiable = 0;
    for (const r of results) {
      const idx = (r.index || r.id || 0) - 1;
      if (idx < 0 || idx >= pending.length) continue;
      const pred = pending[idx];

      db.prepare(`
        UPDATE predictions SET outcome = ?, outcome_evidence = ?, outcome_date = date('now'),
        error_analysis = ?, updated_at = datetime('now') WHERE id = ?
      `).run(r.outcome, r.evidence, r.error_description, pred.id);

      if (r.outcome === 'correct') correct++;
      else if (r.outcome === 'wrong') wrong++;
      else if (r.outcome === 'partially_correct') partial++;
      else unverifiable++;
    }

    // Compute accuracy metrics
    const verified = correct + wrong + partial;
    const accuracy = verified > 0 ? (correct + partial * 0.5) / verified : 0;

    // Historical accuracy
    const allVerified = db.prepare(
      "SELECT outcome, COUNT(*) as cnt FROM predictions WHERE outcome != 'pending' GROUP BY outcome"
    ).all() as any[];
    const totalVerified = allVerified.reduce((s: number, r: any) => s + r.cnt, 0);
    const totalCorrect = allVerified.find((r: any) => r.outcome === 'correct')?.cnt || 0;
    const totalPartial = allVerified.find((r: any) => r.outcome === 'partially_correct')?.cnt || 0;
    const overallAccuracy = totalVerified > 0 ? (totalCorrect + totalPartial * 0.5) / totalVerified : 0;

    const accuracyData = {
      total_verified: totalVerified,
      correct: totalCorrect,
      partially_correct: totalPartial,
      wrong: allVerified.find((r: any) => r.outcome === 'wrong')?.cnt || 0,
      unverifiable: allVerified.find((r: any) => r.outcome === 'unverifiable')?.cnt || 0,
      accuracy_rate: overallAccuracy,
      this_run: { correct, wrong, partial, unverifiable },
      verified_at: new Date().toISOString(),
    };

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('prediction_accuracy', ?, datetime('now'))")
      .run(JSON.stringify(accuracyData));

    // Store recent errors for Task 16
    const recentErrors = pending
      .map((p: any, i: number) => {
        const r = results.find((r: any) => (r.index || r.id || 0) - 1 === i);
        if (!r || (r.outcome !== 'wrong' && r.outcome !== 'partially_correct')) return null;
        return { prediction: p.prediction, subject: p.subject, confidence: p.confidence, reasoning: p.reasoning, outcome: r.outcome, evidence: r.evidence, error: r.error_description };
      })
      .filter(Boolean);

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('prediction_errors_latest', ?, datetime('now'))")
      .run(JSON.stringify(recentErrors));

    // ── Hypothesis verification (meta-learning for intelligence cycle) ──
    // Check hypotheses from hypothesis_history that are >24h old and not yet verified
    let hypothesesVerified = 0;
    try {
      const historyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'hypothesis_history'").get() as any)?.value;
      if (historyRaw) {
        const history = JSON.parse(historyRaw);
        const cutoff = Date.now() - 24 * 3600000; // Only verify hypotheses >24h old
        let updated = false;

        for (const h of history) {
          if (h.verified !== null) continue; // Already verified
          if (new Date(h.generated_at).getTime() > cutoff) continue; // Too recent

          // Check for new evidence since hypothesis was generated
          const searchTerms = (h.claim || '').split(/\s+/).filter((w: string) => w.length > 4).slice(0, 4).join(' ');
          if (!searchTerms) continue;

          const newEvidence = db.prepare(`
            SELECT title, summary, source_date FROM knowledge_primary
            WHERE source_date > ? AND (title LIKE ? OR summary LIKE ?)
            LIMIT 3
          `).all(h.generated_at, `%${searchTerms.split(' ')[0]}%`, `%${searchTerms.split(' ')[0]}%`) as any[];

          if (newEvidence.length > 0) {
            // Mark as needing verification (will be resolved by intelligence cycle's persistent session)
            h.verified = 'pending_review';
            h.new_evidence = newEvidence.map((e: any) => e.title).slice(0, 3);
            updated = true;
            hypothesesVerified++;
          } else if (Date.now() - new Date(h.generated_at).getTime() > 7 * 24 * 3600000) {
            // Older than 7 days with no evidence either way → mark stale
            h.verified = 'stale';
            updated = true;
          }
        }

        if (updated) {
          db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('hypothesis_history', ?, datetime('now'))")
            .run(JSON.stringify(history.slice(-100)));
        }
      }
    } catch (_e) {}

    return {
      task: '15-prediction-verification',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { verified: pending.length, correct, wrong, partial, unverifiable, overall_accuracy: overallAccuracy, hypotheses_checked: hypothesesVerified },
    };
  } catch (err: any) {
    return { task: '15-prediction-verification', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Task 16: Strategic Reflection ────────────────────────

const significantWords = (s: string) => new Set(
  (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
);
const lessonSimilarity = (a: string, b: string) => {
  const wa = significantWords(a), wb = significantWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
};

export async function task16StrategicReflection(db: Database.Database): Promise<TaskResult> {
  const start = Date.now();
  try {
    // Self-heal pass: collapse near-duplicate lessons within the SAME prompt window used
    // below (ORDER BY created_at DESC LIMIT 15), before anything else runs. The insert-time
    // dedup check further down only stops NEW duplicates from being written — it does nothing
    // about duplicates that already exist (e.g. the 15-row "HARD STOP" cluster from before
    // that check existed on 2026-08-29). Left unaddressed, a cluster this size permanently
    // fills the entire prompt window, so the model never sees anything but stale noise and
    // has no fresh signal to retire it from (retirement is only ever triggered when the model
    // tries to add a lesson that would restate one already shown to it). Scoped to just the
    // 15-row window — not the full active history — so this can't mass-retire older, more
    // varied lessons on a crude word-overlap heuristic.
    const windowForSelfHeal = db.prepare(
      "SELECT id, lesson, lesson_type FROM strategic_lessons WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at DESC LIMIT 15"
    ).all().reverse() as any[]; // oldest-first so the earliest instance of a repeated lesson is the one kept
    const keptForSelfHeal: any[] = [];
    const selfHealRetireIds: string[] = [];
    for (const l of windowForSelfHeal) {
      const dup = keptForSelfHeal.find(k => k.lesson_type === l.lesson_type && lessonSimilarity(k.lesson, l.lesson) > 0.6);
      if (dup) selfHealRetireIds.push(l.id);
      else keptForSelfHeal.push(l);
    }
    if (selfHealRetireIds.length > 0) {
      const retireStmt = db.prepare("UPDATE strategic_lessons SET superseded_by = 'retired_dup', expires_at = datetime('now') WHERE id = ?");
      for (const id of selfHealRetireIds) retireStmt.run(id);
      console.log(`    ⚠ Self-healed ${selfHealRetireIds.length} near-duplicate lesson(s) in the active prompt window`);
    }

    // Load prediction errors
    const errorsRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_errors_latest'").get() as any)?.value;
    const errors = errorsRaw ? JSON.parse(errorsRaw) : [];

    // Load accuracy history
    const accuracyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'prediction_accuracy'").get() as any)?.value;
    const accuracy = accuracyRaw ? JSON.parse(accuracyRaw) : null;

    // Need at least some data to reflect on
    if (errors.length === 0 && (!accuracy || accuracy.total_verified < 3)) {
      return { task: '16-strategic-reflection', status: 'skipped', duration_seconds: 0, output: { message: 'Insufficient prediction history for reflection', self_healed_duplicates: selfHealRetireIds.length } };
    }

    // Load active lessons
    const activeLessons = db.prepare(
      "SELECT * FROM strategic_lessons WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at DESC LIMIT 15"
    ).all() as any[];

    // Load recent staged action feedback
    const recentFeedback = db.prepare(
      "SELECT type, summary, status, reasoning, project FROM staged_actions WHERE acted_at > datetime('now', '-7 days') ORDER BY acted_at DESC LIMIT 10"
    ).all() as any[];

    const prompt = `You are the METACOGNITIVE LAYER of an AI Chief of Staff for Zach Stock (insurance MGA founder, ADHD).
Your job: analyze WHY predictions were wrong and extract lessons that prevent the same errors.

PREDICTION ERRORS:
${errors.length > 0 ? errors.map((e: any) => `- PREDICTED: "${e.prediction}" (${Math.round(e.confidence * 100)}% confidence)\n  ACTUAL: ${e.outcome} — ${e.evidence}\n  ERROR: ${e.error}`).join('\n') : '(no errors this cycle)'}

ACCURACY HISTORY:
${accuracy ? `Overall: ${Math.round(accuracy.accuracy_rate * 100)}% (${accuracy.total_verified} verified)\nThis run: ${accuracy.this_run?.correct || 0} correct, ${accuracy.this_run?.wrong || 0} wrong` : '(first cycle)'}

ACTIVE LESSONS (${activeLessons.length}):
${activeLessons.map((l: any) => `- [id: ${l.id}] [${l.lesson_type}] ${l.lesson}\n  Rule: ${l.correction_rule || 'none'}`).join('\n') || '(none yet)'}
Each lesson above is prefixed with its real "id". To retire a lesson, put that exact id string in "retired_lessons". To mark a new lesson as replacing an old one, put that exact id string in "supersedes_lesson_id". Never invent an id. If a new lesson would restate or only trivially vary an active lesson above, do not add it — retire/consolidate instead and emit zero new_lessons for that topic.

USER FEEDBACK (staged action outcomes):
${recentFeedback.map((f: any) => `- [${f.status}] ${f.type}: ${f.summary}`).join('\n') || '(none)'}

REFLECT:
1. What SYSTEMATIC ERRORS is the system making?
2. Is the system OVER-CONFIDENT or UNDER-CONFIDENT?
3. What BLIND SPOTS exist?
4. Which existing lessons should be RETIRED?
5. What NEW RULES should the system follow?

CRITICAL: correction_rule must be CONCRETE and ACTIONABLE — not "be more careful" but "When evaluating X, weight Y because Z."

ALSO CRITICAL: Before proposing a lesson that would REDUCE follow-up with someone, consider whether that creates a self-fulfilling prophecy. If reducing action could CAUSE the predicted outcome, flag it.

Return JSON:
{
  "systematic_errors": ["pattern 1", "pattern 2"],
  "calibration": {"direction": "overconfident|underconfident|calibrated", "recommendation": "..."},
  "blind_spots": ["..."],
  "new_lessons": [{
    "lesson_type": "prediction_error|blind_spot|calibration|pattern_discovery",
    "lesson": "human-readable lesson",
    "domain": "project|entity|commitment|deal|timing|relationship",
    "root_cause": "why the error occurred",
    "severity": "critical|high|medium|low",
    "correction_rule": "When X, do Y instead of Z",
    "self_fulfilling_risk": false,
    "supersedes_lesson_id": null
  }],
  "retired_lessons": [],
  "meta_insight": "one sentence about the system's biggest growth area"
}`;

    // Use Claude for strategic reflection (highest quality reasoning)
    const response = await runClaude(prompt, { timeout: 180000 });

    // Parse response
    const cleaned = response.replace(/```json?\s*\n?/g, '').replace(/\n?```/g, '').trim();
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      return { task: '16-strategic-reflection', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: 'No JSON in reflection response' };
    }

    const reflection = JSON.parse(objMatch[0]);

    // Full active set (not the 15-item prompt window) for a code-level dedup check —
    // prompt-level "don't repeat yourself" instructions have repeatedly failed to stop
    // near-duplicate lessons (e.g. the "HARD STOP" pattern), so this is enforced here
    // regardless of what the model does.
    const dedupCandidates = db.prepare(
      "SELECT id, lesson, lesson_type FROM strategic_lessons WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).all() as any[];

    // Insert new lessons
    let lessonsAdded = 0;
    let lessonsSkippedDup = 0;
    for (const lesson of (reflection.new_lessons || [])) {
      // Skip self-fulfilling lessons unless flagged as safe
      if (lesson.self_fulfilling_risk) {
        console.log(`    ⚠ Skipped self-fulfilling lesson: "${lesson.lesson}"`);
        continue;
      }

      const dup = dedupCandidates.find(l => l.lesson_type === lesson.lesson_type && lessonSimilarity(l.lesson, lesson.lesson) > 0.6);
      if (dup) {
        console.log(`    ⚠ Skipped near-duplicate lesson (matches active ${dup.id}): "${(lesson.lesson || '').slice(0, 80)}"`);
        lessonsSkippedDup++;
        continue;
      }

      const newId = uuid();
      db.prepare(`
        INSERT INTO strategic_lessons (id, lesson_date, lesson_type, lesson, domain, root_cause, severity, correction_rule, superseded_by)
        VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, lesson.lesson_type, lesson.lesson, lesson.domain, lesson.root_cause, lesson.severity, lesson.correction_rule, null);
      dedupCandidates.push({ id: newId, lesson: lesson.lesson, lesson_type: lesson.lesson_type });

      // Handle superseding: the OLD lesson (supersedes_lesson_id) is marked as
      // superseded by this NEW row's id — previously both args were the same value,
      // which pointed a lesson's superseded_by at its own id instead of the new lesson.
      if (lesson.supersedes_lesson_id) {
        db.prepare("UPDATE strategic_lessons SET superseded_by = ? WHERE id = ?")
          .run(newId, lesson.supersedes_lesson_id);
      }
      lessonsAdded++;
    }

    // Retire old lessons
    for (const retiredId of (reflection.retired_lessons || [])) {
      db.prepare("UPDATE strategic_lessons SET superseded_by = 'retired', expires_at = datetime('now') WHERE id = ?").run(retiredId);
    }

    // Build active correction rules for injection into downstream tasks
    const allActive = db.prepare(
      "SELECT correction_rule, domain, severity FROM strategic_lessons WHERE superseded_by IS NULL AND correction_rule IS NOT NULL AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 10"
    ).all() as any[];

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('active_correction_rules', ?, datetime('now'))")
      .run(JSON.stringify(allActive));

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('strategic_reflection_latest', ?, datetime('now'))")
      .run(JSON.stringify(reflection));

    return {
      task: '16-strategic-reflection',
      status: 'success',
      duration_seconds: (Date.now() - start) / 1000,
      output: { lessons_added: lessonsAdded, lessons_skipped_dup: lessonsSkippedDup, meta_insight: reflection.meta_insight, calibration: reflection.calibration?.direction },
    };
  } catch (err: any) {
    return { task: '16-strategic-reflection', status: 'failed', duration_seconds: (Date.now() - start) / 1000, error: err.message };
  }
}

// ── Helper: Get correction rules for prompt injection ────

export function getCorrectionRules(db: Database.Database, domain?: string): string {
  const raw = (db.prepare("SELECT value FROM graph_state WHERE key = 'active_correction_rules'").get() as any)?.value;
  if (!raw) return '';

  const rules = JSON.parse(raw) as any[];
  const filtered = domain ? rules.filter(r => r.domain === domain || r.domain === 'general') : rules;
  if (filtered.length === 0) return '';

  return 'CORRECTION RULES (from past errors — FOLLOW THESE):\n' +
    filtered.map((r: any, i: number) => `${i + 1}. [${r.domain}] ${r.correction_rule}`).join('\n') +
    '\nThese are extracted from PAST ERRORS. When your analysis conflicts with a rule, the rule wins unless you have strong new evidence.\n';
}
