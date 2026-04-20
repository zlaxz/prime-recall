import type Database from 'better-sqlite3';
import { DeepSeekAgent } from './deepseek-agent.js';

// ============================================================
// Verification Layer — DeepSeek audits wiki claims against sources
//
// After wiki compilation, picks random claims from wiki pages
// and verifies them against actual source material. Flags
// unverifiable or incorrect claims. Results stored for
// observability and fed back to wiki agents on next compile.
// ============================================================

export interface VerificationResult {
  totalClaims: number;
  verified: number;
  unverifiable: number;
  incorrect: number;
  findings: Finding[];
  durationMs: number;
}

interface Finding {
  page: string;
  claim: string;
  verdict: 'verified' | 'unverifiable' | 'incorrect' | 'outdated';
  evidence: string;
  sourceRef?: string;
}

// Extract factual claims from a wiki page (simple heuristic — grab sentences with specifics)
function extractClaims(content: string, maxClaims: number = 8): string[] {
  const lines = content.split('\n').filter(l => l.trim().length > 20);
  const claims: string[] = [];

  for (const line of lines) {
    const cleaned = line.replace(/^[#*\->\s]+/, '').trim();
    // Skip headers, metadata, empty
    if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('---')) continue;
    // Look for lines with factual content (names, dates, numbers, specific assertions)
    if (/\d|[A-Z][a-z]+ [A-Z]|(?:signed|sent|launched|agreed|confirmed|pending|overdue|blocked|completed)/.test(cleaned)) {
      claims.push(cleaned.slice(0, 300));
    }
  }

  // Shuffle and take random sample
  for (let i = claims.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [claims[i], claims[j]] = [claims[j], claims[i]];
  }
  return claims.slice(0, maxClaims);
}

export async function verifyWikiPages(db: Database.Database, options?: {
  maxPages?: number;
  claimsPerPage?: number;
}): Promise<VerificationResult> {
  const start = Date.now();
  const maxPages = options?.maxPages ?? 3;
  const claimsPerPage = options?.claimsPerPage ?? 3;
  const allFindings: Finding[] = [];

  // Get recently compiled pages (prioritize ones that changed this cycle)
  const pages = db.prepare(`
    SELECT page_type, subject_id, content FROM compiled_pages
    WHERE content IS NOT NULL AND length(content) > 100
    ORDER BY compiled_at DESC LIMIT ?
  `).all(maxPages * 2) as any[];

  if (pages.length === 0) {
    return { totalClaims: 0, verified: 0, unverifiable: 0, incorrect: 0, findings: [], durationMs: Date.now() - start };
  }

  // Shuffle and pick pages to audit
  for (let i = pages.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pages[i], pages[j]] = [pages[j], pages[i]];
  }
  const selectedPages = pages.slice(0, maxPages);

  // Collect all claims to verify
  const claimsToVerify: { page: string; claim: string }[] = [];
  for (const page of selectedPages) {
    const claims = extractClaims(page.content, claimsPerPage);
    for (const claim of claims) {
      claimsToVerify.push({ page: page.subject_id, claim });
    }
  }

  if (claimsToVerify.length === 0) {
    return { totalClaims: 0, verified: 0, unverifiable: 0, incorrect: 0, findings: [], durationMs: Date.now() - start };
  }

  // Build verification prompt — one DeepSeek call verifies all claims
  const claimsList = claimsToVerify.map((c, i) =>
    `${i + 1}. [${c.page}] "${c.claim}"`
  ).join('\n');

  const prompt = `You are a fact-checker auditing wiki pages for accuracy. Your job is to verify claims against actual source material in the knowledge base.

For EACH claim below, you must:
1. Search the knowledge base for evidence supporting or contradicting the claim
2. Read the actual source material (emails, conversations, documents) — do NOT rely on summaries
3. Render a verdict

CLAIMS TO VERIFY:
${claimsList}

After investigating ALL claims, output your findings in this exact format:

---FINDINGS---
${claimsToVerify.map((_, i) => `${i + 1}. VERDICT: [verified|unverifiable|incorrect|outdated]
   EVIDENCE: [What you found — cite specific sources]
   SOURCE_REF: [source_ref of the evidence, or "none"]`).join('\n')}

Rules:
- "verified" = found primary source evidence that supports the claim
- "unverifiable" = could not find any source evidence (claim may be hallucinated)
- "incorrect" = found source evidence that CONTRADICTS the claim
- "outdated" = claim was once true but newer evidence shows it changed
- Be thorough but efficient. Search, read, judge. Don't over-investigate.`;

  try {
    const agent = new DeepSeekAgent(db, {
      model: 'deepseek-chat',  // Chat is faster + cheaper for verification
      maxTurns: 100,
      maxTokens: 8000,
      temperature: 0.3,
    });

    const result = await agent.run(prompt);

    // Parse findings from agent output
    const findingsSection = result.content.split('---FINDINGS---')[1] || result.content;
    const findingBlocks = findingsSection.split(/\n\d+\.\s+VERDICT:/);

    for (let i = 0; i < claimsToVerify.length; i++) {
      const block = findingBlocks[i + 1]; // +1 because split creates empty first element
      if (!block) continue;

      const verdictMatch = block.match(/^\s*(verified|unverifiable|incorrect|outdated)/i);
      const evidenceMatch = block.match(/EVIDENCE:\s*(.+?)(?=\n\s*SOURCE_REF:|$)/s);
      const sourceRefMatch = block.match(/SOURCE_REF:\s*(.+)/);

      const verdict = (verdictMatch?.[1]?.toLowerCase() || 'unverifiable') as Finding['verdict'];
      const evidence = evidenceMatch?.[1]?.trim() || 'No evidence provided';
      const sourceRef = sourceRefMatch?.[1]?.trim();

      allFindings.push({
        page: claimsToVerify[i].page,
        claim: claimsToVerify[i].claim,
        verdict,
        evidence: evidence.slice(0, 500),
        sourceRef: sourceRef !== 'none' ? sourceRef : undefined,
      });
    }

    // Store results
    const verified = allFindings.filter(f => f.verdict === 'verified').length;
    const unverifiable = allFindings.filter(f => f.verdict === 'unverifiable').length;
    const incorrect = allFindings.filter(f => f.verdict === 'incorrect' || f.verdict === 'outdated').length;

    // Store verification results in graph_state for observability
    const summary = {
      timestamp: new Date().toISOString(),
      pages_audited: selectedPages.map((p: any) => p.subject_id),
      claims_checked: allFindings.length,
      verified,
      unverifiable,
      incorrect,
      accuracy_rate: allFindings.length > 0 ? Math.round((verified / allFindings.length) * 100) : 0,
      findings: allFindings,
      agent_turns: result.turns,
      agent_tool_calls: result.toolCalls,
      duration_seconds: Math.round(result.durationMs / 1000),
    };

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_verification', ?, datetime('now'))"
    ).run(JSON.stringify(summary));

    // If any claims are incorrect, create corrections automatically
    for (const finding of allFindings) {
      if (finding.verdict === 'incorrect' || finding.verdict === 'outdated') {
        // Mark affected wiki page stale so it gets recompiled
        db.prepare(
          "UPDATE compiled_pages SET stale = 1 WHERE subject_id = ?"
        ).run(finding.page);

        // Store as a knowledge item so wiki agents see it next cycle
        const { v4: uuid } = await import('uuid');
        db.prepare(`
          INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, importance, provenance, project)
          VALUES (?, ?, ?, 'verification', ?, datetime('now'), 'high', 'derived', ?)
        `).run(
          uuid(),
          `VERIFICATION FAILED: ${finding.claim.slice(0, 80)}`,
          `Claim: "${finding.claim}"\nVerdict: ${finding.verdict}\nEvidence: ${finding.evidence}`,
          `verification:${Date.now()}`,
          finding.page
        );

        console.log(`      FLAGGED [${finding.page}]: ${finding.claim.slice(0, 60)}... → ${finding.verdict}`);
      }
    }

    console.log(`    Verification: ${verified}/${allFindings.length} verified, ${unverifiable} unverifiable, ${incorrect} incorrect (${result.turns} turns, ${Math.round(result.durationMs / 1000)}s)`);

    return {
      totalClaims: allFindings.length,
      verified,
      unverifiable,
      incorrect,
      findings: allFindings,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    console.log(`    Verification failed: ${(err.message || '').slice(0, 80)}`);
    return { totalClaims: claimsToVerify.length, verified: 0, unverifiable: 0, incorrect: 0, findings: [], durationMs: Date.now() - start };
  }
}
