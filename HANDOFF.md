# Prime Handoff — April 16, 2026

## The Big Picture

Prime is an AI Chief of Staff (Quinn Parker) running on a Mac Mini. The system ingests emails, calendar, transcripts, and conversations, and produces strategic intelligence for Zach Stock at Recapture Insurance.

**The core problem discovered this session:** The entire intelligence pipeline was a game of telephone. Emails were ingested as 100-char snippets (Gmail format:'metadata'), extracted by an LLM that only saw 6K chars, compiled into wiki pages from 3-5 summaries, then reasoned about by Quinn who never read the actual emails. Every step lost fidelity.

**What was fixed today:**
- Gmail sync (broken 10 days — wrong OAuth account, switched to service account)
- Email body fetching (format:'full' instead of 'metadata')
- Extraction limits (6K→30K input, 1K→2K/3K output)
- Proxy 64KB body limit (curl fallback)
- Noise filter (42%→10% false positives)
- Entity dedup (112 merged)
- 290 noise items deleted
- 5,106 items re-extracted via DeepSeek
- DB: 1,335MB→337MB
- FOCUS.md deployed
- Health monitor deployed
- Wiki lint + markdown export to Obsidian
- Question accumulation fix (72→5 pending)
- Drive sync via service account
- Entity page IDs: UUIDs→readable slugs

## What Needs To Happen Next

### Priority 1: Make Quinn a Real Agent

**File:** `src/quinn-agent.ts` (created, not yet working)

The intelligence cycle (v1 and v2) pre-chews Quinn's food. She should be a tool-using agent who investigates. The architecture is right: `claude -p --resume` with MCP tools via the proxy. 

**The blocker:** First test completed in 3 seconds with a 43-char response. The proxy may not be relaying tool calls properly. Need to:

1. Test if the proxy's `claude -p` actually invokes MCP tools when `--max-turns` is set
2. If not, investigate why — the MCP config exists at `~/.claude/.mcp.json`
3. May need to modify the proxy or find an alternative way to run multi-turn tool sessions on the Mac Mini

**Key insight from Zach:** Quinn doesn't need to spawn sub-agents via `claude -p` — she IS a `claude -p` session. The MCP tools are her native tools. She should be able to search, retrieve, follow threads all within her session.

### Priority 2: Re-extract with Fixed Limits

The extraction function now reads 30K chars instead of 6K. But 3,800+ existing gmail items were extracted with the old 6K limit. Need another batch re-extraction with the fixed limits. ~$5-10, ~30 minutes with 100 DeepSeek agents.

**Script exists:** `scripts/batch-reextract.ts` — needs to be re-run now that extract.ts has the 30K limit.

### Priority 3: Wiki Compilation Quality

The wiki compiler agents only retrieve 3-5 actual sources per page. For entities with 50+ email threads, this means 90% of communications are invisible in the wiki. 

**Options:**
- Increase the retrieve count in the wiki agent prompt
- Have the wiki agent use ALL index cards (not just 3-5 retrieved sources)
- Since index cards are now better quality (format:'full' + 30K extraction), the wiki may improve naturally after re-extraction

### Priority 4: Compiled Page Duplicates Keep Recurring

Case-sensitivity creates duplicates: "Carefront" / "CareFront" / "carefront". The wiki compiler normalizes to lowercase now for entities but not for projects. The `fix-compiled-pages.ts` script cleans them up but they keep coming back.

**Fix:** Normalize project subject_id to lowercase in `wiki-compiler.ts` (same fix applied to `wiki-agents.ts` for entities).

## Architecture Reference

```
Mac Mini (zachs-mac-mini.local)
├── Port 3210: Prime API Server (Express + MCP over HTTP)
├── Port 3211: Claude Proxy (Swift, Keychain OAuth → claude -p)
├── ~/.prime/prime.db: SQLite (337MB, 6,677 items)
├── ~/.prime/FOCUS.md: Quinn's persistent working state
├── ~/.prime/cycles/: Intelligence cycle output archive
├── ~/.prime/wiki/: Markdown export of compiled pages
├── Shift daemon: 15-min sync, hourly checks, 4-hour full cycle
└── Health monitor: checks all sources every 4 hours

Laptop
├── ~/GitHub/prime: Source code (Node.js/TypeScript)
├── ~/ObsidianVault/Projects/prime/: Wiki + FOCUS.md synced every 15 min
└── Claude Desktop: MCP proxy → Mac Mini API
```

## Key Files

| File | Purpose |
|------|---------|
| `src/quinn-agent.ts` | NEW — Quinn as tool-using agent (not yet working) |
| `src/intelligence-cycle-v2.ts` | Current working intelligence cycle (single Opus prompt) |
| `src/intelligence-cycle.ts` | V1 — agent model with tools (was limited to 20 turns) |
| `src/dream.ts` | Dream pipeline orchestrator (calls v2 currently) |
| `src/shift.ts` | Shift daemon (sync + health + lint + wiki export) |
| `src/connectors/gmail.ts` | Gmail connector (format:'full', service account) |
| `src/ai/extract.ts` | Extraction (30K input limit, 3K output) |
| `src/wiki-agents.ts` | Entity wiki page compilation |
| `src/wiki-compiler.ts` | Project wiki page compilation |
| `src/wiki-lint.ts` | Lint + markdown export |
| `src/source-health.ts` | Source freshness monitoring |
| `src/utils/claude-spawn.ts` | Claude proxy interface (curl fallback for >60KB) |

## Critical Memories

- Library metaphor: index cards in DB, raw content fetched live from APIs. NEVER store full content permanently.
- Gmail MUST use service account (not OAuth). SA: `prime-149@prime-recall.iam.gserviceaccount.com`
- Extraction was truncating to 6K chars — now 30K. This was THE root cause of hollow intelligence.
- The proxy has a 128KB body limit. Wiki text capped at 60K in intelligence cycle.
- Questions accumulate infinitely — auto-expire after 3 days, cap at 10 pending.
- Entity page IDs must be slugified names, not UUIDs.
- Compiled page duplicates from case sensitivity — normalize to lowercase.

## Git State

Branch: main, 12 commits ahead of origin
Tag: v1.0-pre-wiki (before this session's changes)
Latest: 0080fd7 (Quinn agent v1)
