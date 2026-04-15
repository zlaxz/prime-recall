import type Database from 'better-sqlite3';
import { compileProjectWiki, compileEntityWiki } from './deepseek-agent.js';

const MEMORY_MARKER = '---AGENT_MEMORY---';
const MAX_MEMORY_CHARS = 3000;

/**
 * Parse agent output to separate wiki content from memory section.
 * Returns { wikiContent, memory }.
 */
function parseAgentOutput(content: string): { wikiContent: string; memory: string | null } {
  const idx = content.indexOf(MEMORY_MARKER);
  if (idx === -1) return { wikiContent: content, memory: null };
  return {
    wikiContent: content.slice(0, idx).trimEnd(),
    memory: content.slice(idx + MEMORY_MARKER.length).trim(),
  };
}

/**
 * Append new memory to existing, keeping under MAX_MEMORY_CHARS.
 * Most recent memory is kept; oldest is trimmed.
 */
function accumulateMemory(existing: string | null, newMemory: string | null): string | null {
  if (!newMemory) return existing || null;
  if (!existing) return newMemory.slice(0, MAX_MEMORY_CHARS);
  const combined = existing + '\n\n--- Cycle ' + new Date().toISOString().slice(0, 10) + ' ---\n' + newMemory;
  if (combined.length <= MAX_MEMORY_CHARS) return combined;
  // Keep the tail (most recent learnings)
  return combined.slice(combined.length - MAX_MEMORY_CHARS);
}

// ============================================================
// Wiki Compiler — Orchestrates DeepSeek research agents
//
// Determines which wiki pages are stale, runs DeepSeek agents
// in controlled batches, stores results in compiled_pages.
// Triggered by shift daemon every 4 hours.
// ============================================================

interface CompileResult {
  compiled: number;
  skipped: number;
  failed: number;
  errors: string[];
  durationMs: number;
}

export async function compileWikiPages(db: Database.Database): Promise<CompileResult> {
  const start = Date.now();
  const errors: string[] = [];
  let compiled = 0;
  let skipped = 0;
  let failed = 0;

  // Load dismissed projects list from graph_state
  const dismissedRaw = (db.prepare(
    "SELECT value FROM graph_state WHERE key = 'dismissed_projects'"
  ).get() as any)?.value;
  const dismissedProjects: string[] = dismissedRaw ? JSON.parse(dismissedRaw) : [];

  // Determine which projects need wiki pages (excluding dismissed)
  const allProjects = db.prepare(`
    SELECT project, COUNT(*) as cnt, MAX(source_date) as last_activity
    FROM knowledge WHERE project IS NOT NULL AND project != ''
    AND source_date >= datetime('now', '-30 days')
    GROUP BY project HAVING cnt >= 3
    ORDER BY last_activity DESC LIMIT 16
  `).all() as any[];
  const projects = allProjects.filter(p => !dismissedProjects.includes(p.project));

  // Check staleness: skip pages compiled recently with no new data
  const BATCH_SIZE = 5;
  const toCompile: string[] = [];

  for (const p of projects) {
    const existing = db.prepare(
      "SELECT compiled_at, stale FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?"
    ).get(p.project) as any;

    if (existing && !existing.stale) {
      // Check if new data arrived since last compile
      const newItems = db.prepare(
        "SELECT COUNT(*) as c FROM knowledge WHERE project = ? AND source_date > ?"
      ).get(p.project, existing.compiled_at) as any;

      if (newItems.c === 0) {
        skipped++;
        continue;
      }
    }

    toCompile.push(p.project);
  }

  if (toCompile.length === 0) {
    console.log('    Wiki compiler: all pages up to date, nothing to compile');
    return { compiled: 0, skipped: projects.length, failed: 0, errors: [], durationMs: Date.now() - start };
  }

  console.log(`    Wiki compiler: ${toCompile.length} pages to compile (${skipped} up to date)`);

  // Load Quinn's active concerns to pass relevant ones to each research agent
  const cosState = db.prepare(
    "SELECT concerns FROM agent_state WHERE agent_type = 'cos' AND subject_id = 'global'"
  ).get() as any;
  const quinnConcerns = cosState?.concerns || '';

  // Compile in batches
  for (let i = 0; i < toCompile.length; i += BATCH_SIZE) {
    const batch = toCompile.slice(i, i + BATCH_SIZE);
    console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.join(', ')}`);

    const results = await Promise.allSettled(
      batch.map(async (project) => {
        try {
          // Load previous page and memory from agent_state
          const state = db.prepare(
            "SELECT memory, last_wiki_page FROM agent_state WHERE agent_type = 'wiki_project' AND subject_id = ?"
          ).get(project) as any;

          // Extract Quinn's concerns relevant to this project
          let projectConcerns = '';
          if (quinnConcerns) {
            const lines = quinnConcerns.split("\n").filter((l: string) =>
              l.toLowerCase().includes(project.toLowerCase()) ||
              l.toLowerCase().includes(project.split(' ')[0].toLowerCase())
            );
            if (lines.length > 0) {
              projectConcerns = "COS PRIORITY — Quinn is specifically watching:\n" + lines.join("\n");
            }
          }

          // Also load PM concerns if a PM exists for this project
          const pmState = db.prepare(
            "SELECT concerns FROM agent_state WHERE agent_type = 'pm' AND subject_id = ?"
          ).get(project) as any;
          const pmConcerns = pmState?.concerns ? "PM CONCERNS:\n" + pmState.concerns.slice(0, 500) : '';

          const result = await compileProjectWiki(db, project, {
            maxTurns: state?.last_wiki_page ? 30 : 100,
            previousPage: state?.last_wiki_page || undefined,
            memory: state?.memory || undefined,
            // Pass downstream context as soul (injected at top of prompt)
            soul: [projectConcerns, pmConcerns].filter(Boolean).join("\n\n") || undefined,
          });

          // Parse memory from agent output
          const { wikiContent, memory: newMemory } = parseAgentOutput(result.content);
          const accMemory = accumulateMemory(state?.memory || null, newMemory);

          // Store wiki page (without memory section)
          const { v4: uuid } = await import('uuid');
          db.prepare(`
            INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content,
              version, source_item_count, last_source_date, compiled_at, stale)
            VALUES (?, 'project', ?, ?, ?,
              COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'project' AND subject_id = ?), 1),
              ?, datetime('now'), datetime('now'), 0)
          `).run(uuid(), project, project, wikiContent, project, result.sourceRefsRead.length);

          // Update agent state with memory
          db.prepare(`
            INSERT OR REPLACE INTO agent_state (agent_type, subject_id, last_wiki_page, memory, last_run_at)
            VALUES ('wiki_project', ?, ?, ?, datetime('now'))
          `).run(project, wikiContent, accMemory);

          console.log(`      ${project}: ${result.turns} turns, ${result.toolCalls} tools, ${(result.durationMs / 1000).toFixed(0)}s`);
          compiled++;
        } catch (err: any) {
          errors.push(`${project}: ${(err.message || '').slice(0, 80)}`);
          console.log(`      ${project}: FAILED — ${(err.message || '').slice(0, 60)}`);
          failed++;
        }
      })
    );

    // Brief cooldown between batches
    if (i + BATCH_SIZE < toCompile.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { compiled, skipped, failed, errors, durationMs: Date.now() - start };
}
