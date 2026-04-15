# Prime Architecture Audit — April 15, 2026

## The Problem In One Sentence

Prime has 7 lossy processing steps between an email arriving and Quinn mentioning it, and when the first step breaks, everything downstream presents stale data with false confidence for 10 days without alerting anyone.

---

## What We Found Today

1. **Gmail was silently broken for 10 days** — OAuth token was for quinn@ (31 messages), not zach.stock@ (45K messages). Service account config key was missing from DB despite the JSON file existing. Neither the system nor Quinn flagged it.

2. **The noise filter killed 42% of legitimate business emails** — Patterns like `quinn@recaptureinsurance.com` and `Gusto` matched against full email content, filtering threads where those strings appeared anywhere.

3. **The proxy had a 64KB body limit** — The Swift proxy at localhost:3211 silently failed on payloads >65534 bytes, breaking all large Claude calls from Prime.

4. **Half of Forrest's raw email bodies are empty** — `raw_content` not stored, so when you ask "what is Forrest working on" the system can only show extracted summaries, not actual email content.

5. **Quinn was confidently presenting conclusions based on stale data** — The intelligence cycle reasoned on 10-day-old summaries and PM reports, not fresh emails. FOCUS.md said "Carefront is live, Forrest executing" based on inference, not evidence.

---

## The Current Architecture (What Exists)

```
Email arrives at Gmail
  → Gmail API fetches thread (every 15 min via shift daemon)
  → DeepSeek extracts intelligence from thread content
  → Stored in `knowledge` table (6600+ rows, 53 tables total)
  → Wiki agents compile entity/project pages from knowledge table
  → Verification agents audit wiki claims against sources
  → PM agents (Opus) read wiki pages, produce concerns
  → Intelligence cycle v2 (Opus) reads ALL of the above in 116K prompt
  → Produces JSON brief → stored in graph_state
  → FOCUS.md written (new, deployed today)
  → Quinn reads FOCUS.md + agent_state + graph_state + corrections + calendar
  → Daily email sent to Zach

7 LLM processing steps. Each step:
- Costs tokens (DeepSeek for extraction, DeepSeek for wiki, DeepSeek for verification, Opus for PMs, Opus for intelligence, Opus for Quinn)
- Loses fidelity (extraction summarizes, wiki compiles, intelligence reasons on compiled, Quinn summarizes intelligence)
- Can fail silently (Gmail breaks, extraction hallucinates, wiki goes stale, PM invents urgency)
```

## What Karpathy's Pattern Says It Should Be

```
raw/                          ← Immutable sources. NEVER modified by AI.
  gmail/zach/thread-abc.md    ← Raw email thread as markdown
  gmail/forrest/thread-def.md ← Raw email thread as markdown
  calendar/2026-04-15.md      ← Today's calendar events
  transcripts/meeting-xyz.md  ← Fireflies transcript
  claude/conversation-uvw.md  ← Claude.ai conversation

wiki/                         ← LLM-COMPILED. This is the queryable artifact.
  people/forrest-pullen.md    ← Everything known about Forrest, compiled from raw/
  people/costas.md
  projects/carefront.md       ← Carefront status, compiled from all raw mentions
  projects/foresite.md
  situations/current.md       ← "What's happening right now"
  index.md                    ← Human-readable catalog of all wiki pages
  log.md                      ← Append-only operation log

schema/
  QUINN.md                    ← Quinn's identity + compilation instructions
  SCHEMA.md                   ← Entity types, page templates, quality standards

FOCUS.md                      ← Quinn's working state (already deployed)
```

**2 steps, not 7:**
1. **Ingest** — Raw source arrives → stored as markdown file in raw/ → triggers compilation of affected wiki pages
2. **Query** — Quinn reads wiki/ pages. That's it. The wiki IS the intelligence.

The intelligence cycle doesn't need to re-read 12 SQL tables and reason from scratch. It reads `wiki/situations/current.md` which was compiled from fresh raw sources.

---

## The Gap Analysis

### What Prime Does Right (Keep)
- **Service account for Gmail** — Domain-wide delegation works for all accounts (fixed today)
- **FOCUS.md** — Quinn's persistent working state, harness-enforced (deployed today)
- **Context reordering** — Attention-optimized prompt layout (deployed today)
- **Health monitor** — Source staleness detection (deployed today)
- **MCP tools** — The interface layer (prime_search, prime_retrieve, etc.) is good
- **Shift daemon** — 15-min sync cycle is the right cadence

### What Prime Does Wrong (Fix)

| Current | Problem | Karpathy Fix |
|---------|---------|-------------|
| Emails stored in SQLite `knowledge` table | Opaque, not human-readable, can't be audited | Store as markdown files in `raw/gmail/` |
| DeepSeek extracts "intelligence" from every email | Lossy — 50% of email bodies end up empty | Store raw thread content as markdown first, compile later |
| Wiki agents compile from SQL queries | Can't trace claims to sources | Compile from raw/ files, cite file paths |
| Intelligence cycle re-reads everything from scratch | 116K prompt, rebuilds world every 4 hours | Read compiled wiki/ pages instead |
| 53 SQLite tables | Over-engineered, fragile, hard to debug | SQLite for metadata/search index only, files for content |
| No lint pass | Stale data persists indefinitely | Periodic lint: check for contradictions, missing data, staleness |
| Silent failures | Gmail broke for 10 days, nobody noticed | Health monitor on every sync cycle (deployed today) |
| PM agents invent urgency from stale data | "Manufactured urgency" — existing known problem | PMs read wiki pages that are compiled from fresh raw sources |
| Noise filter too aggressive | 42% of business emails killed | Fixed today — match subject/from only, not full content |

### What's Missing Entirely

1. **Raw source files** — Karpathy stores raw articles as immutable markdown. Prime stores extracted summaries in SQLite. The raw content is either lost or not queryable.

2. **The compilation step** — Karpathy's core innovation. An LLM reads raw sources and produces structured wiki pages. Prime's wiki agents do something like this, but they compile from SQL queries (already-extracted data), not from raw sources.

3. **Linting** — Periodic health checks where the LLM scans the wiki for inconsistencies, missing data, stale claims, and new connections. Prime has verification agents but they audit wiki claims against sources — that's close but not the same as linting the whole system.

4. **index.md** — A human-readable catalog of everything in the wiki. Prime has no equivalent. You can't open a file and see "here's everything Quinn knows."

5. **log.md** — An append-only operation log. When was each page last compiled? What raw sources were ingested today? Prime has no audit trail of compilation operations.

6. **Traceability** — Every wiki claim should cite the raw source file it came from. Prime's wiki pages cite knowledge IDs, not readable source files.

---

## The Architectural Options

### Option A: Patch What Exists
Keep the 53-table SQLite architecture. Add monitors, fix configs, improve noise filters. This is what we've been doing today.

**Pros:** Low risk, incremental, nothing breaks
**Cons:** Fundamental fidelity problem remains. 7 lossy steps. Silent failures will recur. "Clunky and sucks" feeling won't go away.

### Option B: Add a Wiki Layer On Top
Keep SQLite for ingestion/search but add a `wiki/` directory of compiled markdown files. The intelligence cycle reads wiki files instead of SQL tables. Raw sources get saved as markdown alongside the SQLite storage.

**Pros:** Incremental migration. SQLite still works. Wiki adds auditability and Karpathy-pattern benefits.
**Cons:** Two systems to maintain (SQLite + files). Still has the extraction step.

### Option C: Rebuild Around Karpathy Pattern
Raw sources as markdown files → LLM compilation into wiki pages → Quinn reads wiki. SQLite becomes a search index only (BM25 + metadata), not the primary data store.

**Pros:** Matches what Manus, OpenClaw, Claude Code, and Karpathy all converged on. Simpler, more auditable, fewer failure modes. "Curated library with a head librarian" instead of "warehouse with a forklift."
**Cons:** Significant rebuild. Risk of the "building instead of using" ADHD trap. Need to migrate 6600+ items.

### Recommended: Option B (Wiki Layer) → Evolve to C

Start by adding the wiki layer alongside SQLite. The shift daemon's compilation step writes markdown files in addition to (not instead of) updating SQLite. The intelligence cycle reads the wiki files. Over time, the wiki becomes the source of truth and SQLite becomes just the search index.

This is the @jumperz swarm pattern: "every agent auto dumps its output into a raw/ folder, a compiler runs every few hours and organizes everything into the wiki."

---

## Concrete Next Steps (If Approved)

### Phase 1: Raw Source Preservation (1 day)
- When Gmail connector fetches a thread, save the full thread content as `~/.prime/raw/gmail/{thread-id}.md`
- Same for calendar events, transcripts, claude conversations
- These files are IMMUTABLE — the AI never modifies them
- This immediately solves the "empty raw_content" problem

### Phase 2: Wiki Compilation (2 days)
- Create `~/.prime/wiki/` directory
- Add compilation step to shift daemon: after sync, compile affected wiki pages
- Start with: `people/{name}.md` for top 20 contacts, `projects/{name}.md` for active projects
- Each wiki page cites raw source files: `[Source: raw/gmail/thread-abc.md]`
- Create `wiki/index.md` with catalog of all pages
- Create `wiki/log.md` with append-only operation log

### Phase 3: Intelligence Reads Wiki (1 day)
- Intelligence cycle v2 reads `wiki/` markdown files instead of (or in addition to) SQL queries
- Quinn context loads from wiki pages, not 7 SQL queries
- FOCUS.md continues as working state

### Phase 4: Lint Pass (1 day)
- Add lint step to shift daemon: every 4 hours, scan wiki for staleness, contradictions, missing data
- Flag stale wiki pages for recompilation
- Log lint results to `wiki/log.md`

---

## Sources That Informed This Audit

- "The Markdown File That Beat a $50M Vector Database" — Micheal Lanham (PDF: ~/Downloads/)
- Karpathy LLM Wiki Gist — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- LLM Wiki v2 (agentmemory extension) — https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2
- Karpathy LLM Knowledge Base (VentureBeat) — PDF: ~/Downloads/
- Context Engineering for AI Agents (Manus) — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Context Engineering for Agents (LangChain) — https://www.langchain.com/blog/context-engineering-for-agents/
- @jumperz Swarm Knowledge Base pattern (VentureBeat article, page 7)

---

## The One-Line Summary

**Prime is a warehouse with a forklift. It needs to become a library with a librarian.**
