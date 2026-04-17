import { getDb, getConfig } from './db.js';
import { syncAll } from './connectors/index.js';

// ============================================================
// Prime Shift Daemon — Active autonomous monitoring
//
// Runs from 7am to 10pm. Makes Prime feel alive:
// - Every 15 min: sync data, check for signals
// - Every hour: meeting prep, commitment checks
// - Every 4 hours: full intelligence cycle + research + playbooks
//
// This replaces the 3x daily cron with continuous awareness.
// ============================================================

const CYCLE_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const HOUR_MS = 60 * 60 * 1000;

async function tick() {
  const db = getDb();
  const now = new Date();
  const hour = now.getHours();

  // Only work between 7am and 10pm
  if (hour < 7 || hour >= 22) {
    console.log(`[shift] ${now.toLocaleTimeString()} — Off hours. Sleeping.`);
    return;
  }

  console.log(`[shift] ${now.toLocaleTimeString()} — Tick starting...`);

  // ── EVERY TICK (15 min): Sync data ──
  try {
    const syncResults = await syncAll(db);
    const totalSynced = syncResults.reduce((s, r) => s + r.items, 0);
    if (totalSynced > 0) {
      console.log(`[shift]   Synced ${totalSynced} items`);
    }
    // Event-driven intelligence is already wired into syncAll
    // (triggers when key entity emails detected)
  } catch (err: any) {
    console.log(`[shift]   Sync error: ${err.message?.slice(0, 60)}`);
  }

  // ── HOURLY: Meeting prep + commitment checks ──
  const lastHourlyRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_hourly_check'").get() as any)?.value;
  const lastHourly = lastHourlyRaw ? new Date(JSON.parse(lastHourlyRaw)).getTime() : 0;

  if (Date.now() - lastHourly > HOUR_MS) {
    console.log(`[shift]   Running hourly checks...`);

    // Meeting prep for next 2 hours
    try {
      const meetings = db.prepare(`
        SELECT title, source_date, metadata FROM knowledge_primary
        WHERE source = 'calendar'
          AND source_date >= datetime('now')
          AND source_date <= datetime('now', '+2 hours')
        ORDER BY source_date ASC LIMIT 3
      `).all() as any[];

      if (meetings.length > 0) {
        console.log(`[shift]   📅 ${meetings.length} meeting(s) in next 2 hours`);
        // Meeting prep is already handled by Task 12 in the dream pipeline
        // Store a flag so the next intelligence cycle emphasizes it
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('upcoming_meeting_alert', ?, datetime('now'))"
        ).run(JSON.stringify(meetings.map((m: any) => ({ title: m.title, time: m.source_date }))));
      }
    } catch (e) {}

    // Commitment deadline check — anything due in next 24 hours
    try {
      const urgentCommitments = db.prepare(`
        SELECT text, owner, project, due_date, state FROM commitments
        WHERE state IN ('active', 'overdue')
          AND due_date IS NOT NULL
          AND due_date <= datetime('now', '+24 hours')
          AND due_date >= datetime('now', '-48 hours')
        ORDER BY due_date ASC
      `).all() as any[];

      if (urgentCommitments.length > 0) {
        console.log(`[shift]   ⚠️ ${urgentCommitments.length} commitment(s) due in 24h`);
        db.prepare(
          "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('urgent_commitments', ?, datetime('now'))"
        ).run(JSON.stringify(urgentCommitments));
      }
    } catch (e) {}

    db.prepare(
      "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_hourly_check', ?, datetime('now'))"
    ).run(JSON.stringify(new Date().toISOString()));
  }

  // ── EVERY 4 HOURS: Full intelligence cycle + research + playbooks ──
  const lastFullRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_full_cycle'").get() as any)?.value;
  const lastFull = lastFullRaw ? new Date(JSON.parse(lastFullRaw)).getTime() : 0;

  if (Date.now() - lastFull > 4 * HOUR_MS) {
    // Run dream pipeline FIRST (entity profiles, project profiles, commitments)
    // Intelligence cycle reads these outputs, so they must be fresh
    console.log('[shift]   Running dream pipeline (project/entity profiles, commitments)...');
    try {
      const { runDreamPipeline } = await import('./dream.js');
      const dreamResult = await runDreamPipeline({ quick: true }); // SQL tasks only — LLM tasks replaced by wiki agents + PMs
      const succeeded = dreamResult.tasks.filter((t: any) => t.status === 'success').length;
      const failed = dreamResult.tasks.filter((t: any) => t.status === 'failed').length;
      console.log('[shift]   Dream: ' + succeeded + ' succeeded, ' + failed + ' failed (' + dreamResult.total_duration.toFixed(0) + 's)');
    } catch (err: any) {
      console.log('[shift]   Dream pipeline failed: ' + (err.message || '').slice(0, 60));
    }

    // NEW: Wiki compilation via DeepSeek agents (reads actual sources)
    console.log('[shift]   Compiling wiki pages (DeepSeek agents)...');
    try {
      const { compileWikiPages } = await import('./wiki-compiler.js');
      const wikiResult = await compileWikiPages(db);
      console.log('[shift]   Wiki: ' + wikiResult.compiled + ' compiled, ' + wikiResult.skipped + ' skipped (' + (wikiResult.durationMs / 1000).toFixed(0) + 's)');
    } catch (err: any) {
      console.log('[shift]   Wiki compilation failed: ' + (err.message || '').slice(0, 60));
    }


    // NEW: Verification layer — audit wiki claims against actual sources
    console.log("[shift]   Verifying wiki claims (DeepSeek audit)...");
    try {
      const { verifyWikiPages } = await import("./verification.js");
      const verResult = await verifyWikiPages(db, { maxPages: 3, claimsPerPage: 3 });
      const rate = verResult.totalClaims > 0 ? Math.round((verResult.verified / verResult.totalClaims) * 100) : 0;
      console.log("[shift]   Verification: " + verResult.verified + "/" + verResult.totalClaims + " verified (" + rate + "%), " + verResult.incorrect + " flagged (" + (verResult.durationMs / 1000).toFixed(0) + "s)");
    } catch (err: any) {
      console.log("[shift]   Verification failed: " + (err.message || "").slice(0, 60));
    }
    // NEW: PM agents (Opus, persistent sessions, active projects only)
    console.log('[shift]   Running PM agents...');
    try {
      const { runPMAgent } = await import('./pm-agent.js');
      for (const pm of [
        { project: 'Carefront', agentId: 'carefront-pm' },
        { project: 'Foresite', agentId: 'foresite-pm' },
      ]) {
        try {
          const result = await runPMAgent(db, pm);
          console.log('[shift]   PM ' + pm.agentId + ': done (' + (result.durationMs / 1000).toFixed(0) + 's)');
        } catch (pmErr: any) {
          console.log('[shift]   PM ' + pm.agentId + ' failed: ' + (pmErr.message || '').slice(0, 60));
        }
      }
    } catch (err: any) {
      console.log('[shift]   PM agents failed: ' + (err.message || '').slice(0, 60));
    }

    // NEW: COS agent reads wiki pages and produces brief
    console.log('[shift]   Running COS agent...');
    try {
      const { runCOS } = await import('./cos-agent.js');
      const cosResult = await runCOS(db);
      console.log('[shift]   COS: ' + (cosResult.durationMs / 1000).toFixed(0) + 's — ' + (cosResult.headline || '').slice(0, 60));
    } catch (err: any) {
      console.log('[shift]   COS failed: ' + (err.message || '').slice(0, 60));
    }

    // Daily web research — scours internet for relevant articles (20-hour gate)
    console.log('[shift]   Running daily web research...');
    try {
      const { runDailyWebResearch } = await import('./web-research.js');
      const researchResult = await runDailyWebResearch(db);
      if (researchResult.skipped) {
        console.log('[shift]   Research: skipped (already ran today)');
      } else {
        console.log('[shift]   Research: ' + researchResult.articles + ' articles stored');
      }
    } catch (err: any) {
      console.log('[shift]   Research failed: ' + (err.message || '').slice(0, 60));
    }

    // Send DAILY intelligence email via Quinn — ONCE per day, morning only
    try {
      const lastEmailRaw = (db.prepare("SELECT value FROM graph_state WHERE key = 'last_quinn_email'").get() as any)?.value;
      const lastEmail = lastEmailRaw ? new Date(JSON.parse(lastEmailRaw)).getTime() : 0;
      const hoursSinceEmail = (Date.now() - lastEmail) / 3600000;
      const currentHour = new Date().getHours();

      // Only send if: >20 hours since last email AND it's between 6-9am
      if (hoursSinceEmail > 20 && currentHour >= 6 && currentHour <= 9) {
        const { sendDailyIntelligenceEmail } = await import('./daily-email.js');
        const sent = await sendDailyIntelligenceEmail(db);
        if (sent) {
          db.prepare(
            "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_quinn_email', ?, datetime('now'))"
          ).run(JSON.stringify(new Date().toISOString()));
          console.log('[shift]   Quinn daily email sent');
        }
      }
    } catch (e) {}

    db.prepare("INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('last_full_cycle', ?, datetime('now'))").run(JSON.stringify(new Date().toISOString()));

    // Source health monitor — check all ingestion sources for staleness
    console.log('[shift]   Running source health monitor...');
    try {
      const { runHealthCheck } = await import('./source-health.js');
      const health = await runHealthCheck(db);
      if (health.criticals.length > 0) {
        console.log(`[shift]   🚨 ${health.criticals.length} CRITICAL: ${health.criticals.join('; ')}`);
      } else {
        console.log('[shift]   ✓ All sources healthy');
      }
    } catch (err: any) {
      console.log('[shift]   Health check failed: ' + (err.message || '').slice(0, 60));
    }

    // Pre-compile context summaries for intelligence cycle
    console.log('[shift]   Pre-compiling context cache...');
    try {
      // Compile corrections context (changes rarely)
      const corrections = db.prepare(
        "SELECT title, summary FROM knowledge WHERE source IN ('correction', 'manual', 'training') ORDER BY source_date DESC LIMIT 30"
      ).all() as any[];
      db.prepare(`INSERT OR REPLACE INTO compiled_context (key, content, source_count, compiled_at, expires_at)
        VALUES ('corrections', ?, ?, datetime('now'), datetime('now', '+24 hours'))`)
        .run(corrections.map((c: any) => `- ${c.title}`).join('\n'), corrections.length);

      // Compile CEO statements context
      const ceoStatements = db.prepare(
        "SELECT title, summary, source_date FROM knowledge WHERE source = 'user-feedback' AND provenance = 'primary' ORDER BY source_date DESC LIMIT 20"
      ).all() as any[];
      db.prepare(`INSERT OR REPLACE INTO compiled_context (key, content, source_count, compiled_at, expires_at)
        VALUES ('ceo_statements', ?, ?, datetime('now'), datetime('now', '+4 hours'))`)
        .run(ceoStatements.map((s: any) => `[${(s.source_date || '').slice(0, 10)}] ${s.summary?.slice(0, 300)}`).join('\n'), ceoStatements.length);

      // Compile commitments context
      const commitments = db.prepare(
        "SELECT text, state, due_date, owner, project FROM commitments WHERE state IN ('active', 'overdue') ORDER BY due_date ASC LIMIT 20"
      ).all() as any[];
      db.prepare(`INSERT OR REPLACE INTO compiled_context (key, content, source_count, compiled_at, expires_at)
        VALUES ('commitments', ?, ?, datetime('now'), datetime('now', '+4 hours'))`)
        .run(commitments.map((c: any) => `- [${c.state}] ${c.text}${c.due_date ? ' (due: ' + c.due_date + ')' : ''}${c.owner ? ' — ' + c.owner : ''}`).join('\n'), commitments.length);

      console.log('[shift]   ✓ Context cache: corrections, ceo_statements, commitments');
    } catch (err: any) {
      console.log('[shift]   Context cache failed: ' + (err.message || '').slice(0, 60));
    }

    // Wiki lint + markdown export
    console.log('[shift]   Running wiki lint + export...');
    try {
      const { lintAndExportWiki } = await import('./wiki-lint.js');
      const lint = await lintAndExportWiki(db);
      console.log(`[shift]   Wiki: ${lint.exportedFiles} exported, ${lint.stalePages.length} stale, ${lint.missingPages.length} missing pages`);
    } catch (err: any) {
      console.log('[shift]   Wiki lint failed: ' + (err.message || '').slice(0, 60));
    }

    // Auto-sync: commit and push any changes after full cycle
    try {
      const { execSync } = await import("child_process");
      const cwd = "/Users/zachstock/GitHub/prime";
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
      if (status) {
        execSync("git add -A", { cwd });
        execSync(`git commit -m "Auto-commit: shift ${new Date().toISOString().slice(0,10)}"`, { cwd });
      }
      execSync("git push origin main 2>/dev/null || true", { cwd });
    } catch (e) {}
  }

  // ── LOG ROTATION (every tick) ──
  try {
    const { execSync } = await import('child_process');
    const rotateOutput = execSync('bash /Users/zachstock/GitHub/prime/scripts/rotate-logs.sh 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (rotateOutput) console.log(`[shift]   ${rotateOutput}`);
  } catch (e) {}

  // ── HEALTH CHECK (every tick) ──
  try {
    const health: string[] = [];

    // Check intelligence brief freshness
    const briefAge = db.prepare("SELECT (julianday('now') - julianday(updated_at)) * 24 as hours FROM graph_state WHERE key = 'intelligence_brief'").get() as any;
    if (!briefAge || briefAge.hours > 8) health.push(`Intelligence brief stale (${briefAge?.hours?.toFixed(1) || 'never'}h old)`);

    // Check proxy
    try {
      const { execSync } = await import('child_process');
      execSync('curl -s -f http://localhost:3211/health', { timeout: 3000 });
    } catch {
      health.push('Claude proxy DOWN — dream tasks will fall back to GUI wrapper');
    }

    // Check serve
    try {
      const { execSync } = await import('child_process');
      execSync('curl -s -f http://localhost:3210/api/status', { timeout: 3000 });
    } catch {
      health.push('Prime serve DOWN — API and MCP unavailable');
    }

    // Check Terminal windows
    try {
      const { execSync } = await import('child_process');
      const count = parseInt(execSync("osascript -e 'tell application \"Terminal\" to count windows' 2>/dev/null || echo 0").toString().trim());
      if (count > 5) {
        health.push(`${count} Terminal windows accumulated — closing`);
        execSync("osascript -e 'tell application \"Terminal\" to close every window' 2>/dev/null");
      }
    } catch (e) {}

    if (health.length > 0) {
      console.log(`[shift]   ⚠️ HEALTH: ${health.join(' | ')}`);
      db.prepare(
        "INSERT OR REPLACE INTO graph_state (key, value, updated_at) VALUES ('system_health', ?, datetime('now'))"
      ).run(JSON.stringify({ issues: health, checked_at: new Date().toISOString() }));
    }
  } catch (e) {}

  console.log(`[shift] ${now.toLocaleTimeString()} — Tick complete.`);
}

// ── Main loop ──
async function main() {
  console.log(`[shift] Prime Shift Daemon starting. Active hours: 7am-10pm. Cycle: ${CYCLE_INTERVAL / 60000} min.`);

  // Run immediately on start
  await tick();

  // Then loop
  setInterval(async () => {
    try {
      await tick();
    } catch (err: any) {
      console.error(`[shift] Tick error: ${err.message}`);
    }
  }, CYCLE_INTERVAL);
}

main().catch(err => {
  console.error(`[shift] Fatal: ${err.message}`);
  process.exit(1);
});
