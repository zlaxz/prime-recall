import Database from "better-sqlite3";
import { compileEntityWiki } from "../src/deepseek-agent.js";
import { v4 as uuid } from "uuid";
import { homedir } from "os";

const MEMORY_MARKER = "---AGENT_MEMORY---";
const MAX_MEMORY_CHARS = 3000;

function parseAgentOutput(content: string) {
  const idx = content.indexOf(MEMORY_MARKER);
  if (idx === -1) return { wikiContent: content, memory: null as string | null };
  return {
    wikiContent: content.slice(0, idx).trimEnd(),
    memory: content.slice(idx + MEMORY_MARKER.length).trim(),
  };
}

function accumulateMemory(existing: string | null, newMemory: string | null): string | null {
  if (!newMemory) return existing || null;
  if (!existing) return newMemory.slice(0, MAX_MEMORY_CHARS);
  const combined = existing + '\n\n--- Cycle ' + new Date().toISOString().slice(0, 10) + ' ---\n' + newMemory;
  if (combined.length <= MAX_MEMORY_CHARS) return combined;
  return combined.slice(combined.length - MAX_MEMORY_CHARS);
}

const db = new Database(homedir() + "/.prime/prime.db");

const entities = db.prepare(
  "SELECT cp.subject_id, e.canonical_name FROM compiled_pages cp JOIN entities e ON e.id = cp.subject_id WHERE cp.page_type = 'entity' ORDER BY cp.compiled_at ASC"
).all() as any[];

console.log(`Found ${entities.length} entity pages to recompile`);

const BATCH_SIZE = 5;
let compiled = 0;
let failed = 0;
const errors: string[] = [];

for (let i = 0; i < entities.length; i += BATCH_SIZE) {
  const batch = entities.slice(i, i + BATCH_SIZE);
  console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map((e: any) => e.canonical_name).join(", ")}`);

  await Promise.allSettled(
    batch.map(async (entity: any) => {
      try {
        const state = db.prepare(
          "SELECT memory, last_wiki_page FROM agent_state WHERE agent_type = 'wiki_entity' AND subject_id = ?"
        ).get(entity.subject_id) as any;

        const existing = db.prepare(
          "SELECT content FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?"
        ).get(entity.subject_id) as any;

        const result = await compileEntityWiki(db, entity.canonical_name, {
          maxTurns: 200,
          previousPage: state?.last_wiki_page || existing?.content || undefined,
          memory: state?.memory || undefined,
        });

        const { wikiContent, memory: newMemory } = parseAgentOutput(result.content);
        const accMemory = accumulateMemory(state?.memory || null, newMemory);

        db.prepare(
          "INSERT OR REPLACE INTO compiled_pages (id, page_type, subject_id, subject_name, content, version, source_item_count, last_source_date, compiled_at, stale) VALUES (?, 'entity', ?, ?, ?, COALESCE((SELECT version + 1 FROM compiled_pages WHERE page_type = 'entity' AND subject_id = ?), 1), ?, datetime('now'), datetime('now'), 0)"
        ).run(uuid(), entity.subject_id, entity.canonical_name, wikiContent, entity.subject_id, result.sourceRefsRead?.length || 0);

        db.prepare(
          "INSERT OR REPLACE INTO agent_state (agent_type, subject_id, last_wiki_page, memory, last_run_at) VALUES ('wiki_entity', ?, ?, ?, datetime('now'))"
        ).run(entity.subject_id, wikiContent, accMemory);

        console.log(`  ${entity.canonical_name}: ${result.turns} turns, ${result.toolCalls} tools, ${Math.round(result.durationMs / 1000)}s`);
        compiled++;
      } catch (err: any) {
        errors.push(`${entity.canonical_name}: ${(err.message || "").slice(0, 80)}`);
        console.log(`  ${entity.canonical_name}: FAILED - ${(err.message || "").slice(0, 60)}`);
        failed++;
      }
    })
  );

  if (i + BATCH_SIZE < entities.length) {
    await new Promise(r => setTimeout(r, 2000));
  }
}

console.log(JSON.stringify({ compiled, failed, total: entities.length, errors }));
db.close();
