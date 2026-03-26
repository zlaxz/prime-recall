# Competitive Intelligence Report: AI Knowledge/Memory/Second-Brain Products

**Date:** March 25, 2026
**Analyst:** Claude (Strategic Co-Founder to Zach Stock)
**Purpose:** Competitive landscape analysis for Prime's positioning in the AI memory/knowledge space

---

## 1. Saner.AI

**URL:** https://saner.ai
**Tagline:** "Save, auto-organize, get insights with calmness, speed & confidence"
**Category:** Consumer-facing AI personal knowledge assistant

### First Impression (first 60 seconds)

Saner.AI redirects directly to `app.saner.ai` — it drops you straight into the product. On first load, the AI assistant ("Skai") immediately greeted by name, showed proactive evening check-in, and surfaced insights from existing notes. The onboarding is minimal — Getting Started widget shows 3/5 steps completed. The product feels like it *already knows you*, which is a powerful first impression.

**Aha moment:** Skai proactively surfacing actionable recommendations from your notes without being asked. It didn't just store — it synthesized.

**What confused:** The sample notes made it feel slightly canned. Not immediately obvious how to connect real data sources (Gmail, etc.) without exploring the sidebar.

### Key Features

- **AI Assistant (Skai):** Proactive, chat-based assistant that reasons over your notes. Supports GPT-5, GPT-5 Nano/Mini, GPT-4.1, O3, O4-mini, Claude Opus 4.5/4.1/4, Sonnet 4.5/4, 3.7/3.5 Sonnet, Haiku, Gemini 3.0/2.5 Pro/Flash, Grok 3/4, DeepSeek R1, Llama 4 Maverick/Scout — massive model selection
- **Quick Note & Voice Capture:** Microphone button in chat for voice input
- **Auto-Organization:** AI-powered tagging, folder sorting, and note linking
- **Semantic Search:** Natural language search across all saved content
- **Timeline View:** Notes linked chronologically — retrace your day
- **Smart Inbox:** Unified input for all captured content
- **Focus Box:** Ongoing task tracker in sidebar
- **Calendar Integration:** Shows daily time slots alongside notes
- **Connectors:** Gmail, Google Drive, Slack, Calendar integration
- **Chrome Extension:** Web-based note capture from any page

### UX/Design

The UI is clean, warm, and deliberately calm. Left sidebar organizes: Add, Ask AI, Task, Inbox, Timeline, Conversations, Knowledge (Folders, Connectors, Sample notes), Tags. The main area is a chat interface with the AI assistant. Right sidebar shows Similar Notes, Calendar, and Focus Box.

**What feels good:** The proactive AI that surfaces insights without prompting. Model selection is excellent — lets you pick from dozens of models. The "suggested actions" after each AI response are genuinely useful (prioritize tasks, summarize notes, etc.). The referenced notes with numbered citations feel trustworthy.

**What feels bad:** The UI is slightly busy with all the sidebar panels. The "Getting Started" checklist at bottom-left feels like a to-do that never goes away. Sample notes pollute the workspace.

### ADHD-Friendliness

**Score: 8/10**

- Auto-organization means you don't have to file things manually — just capture and Skai handles it
- Proactive AI that comes TO you with insights (not waiting for you to ask)
- Voice capture reduces friction for quick thoughts
- Focus Box for ongoing tasks is smart for ADHD — visual task anchoring
- Timeline view helps when you can't remember "when did I do that?"
- The multiple sidebar panels could feel overwhelming on a bad day

### Technical Architecture

- **Cloud-based** SaaS application (web app at app.saner.ai)
- **Database/Vector store:** Not disclosed (proprietary)
- **MCP support:** No evidence of MCP integration
- **Open source:** No — fully proprietary
- **Pricing:**
  - Free: 30 AI requests/month, 100 notes, 100MB storage
  - Starter: $8/month (annual) or $12/month (monthly)
  - Standard: $16/month (annual) or $20/month (monthly)

### What We Should Steal

1. **Proactive AI check-ins** — Skai doesn't wait for you to ask. It greets you and surfaces what matters. This is huge for ADHD users.
2. **Massive model selection** — letting users pick from 20+ models (including latest GPT-5, Claude 4.x, Gemini 3.0) is a power-user feature
3. **Suggested actions after AI responses** — clickable next-step buttons that turn insight into action
4. **Citation-backed responses** — numbered references to specific notes with source linking
5. **Timeline view** — chronological note trail for "when did I think about this?"
6. **Focus Box** — persistent task widget in sidebar for ADHD anchoring

### What We Should Avoid

1. **Sample notes pollution** — pre-loaded content that feels fake and clutters the workspace
2. **Getting Started widget that never completes** — feels like guilt
3. **Cloud-only architecture** — no local option, no data sovereignty story
4. **No MCP integration** — can't plug into the emerging agentic ecosystem
5. **Limited integrations** — only Gmail, GDrive, Slack, Calendar. No Notion, Obsidian, etc.

### Gaps (What They Don't Do)

- No screen/audio capture (passive memory)
- No knowledge graph or relationship mapping between entities
- No temporal reasoning (can't ask "what changed since last week?")
- No MCP server — can't be used as a memory layer for other AI tools
- No local/self-hosted option
- No API for developers — consumer-only product
- No cross-application memory sharing

---

## 2. Mem0 (OpenMemory)

**URL:** https://mem0.ai
**Tagline:** "AI Agents Forget. Mem0 Remembers."
**Category:** Developer-focused AI memory layer / platform

### First Impression (first 60 seconds)

Mem0.ai lands on a sleek dark homepage. YC-backed badge prominently displayed. The value prop is instantly clear — memory layer for LLM apps. "Setup in 60 seconds" button. After signing in, the dashboard at app.mem0.ai shows a developer-oriented control panel with metrics: Total Memories, Retrieval API Usage, Add Events, Requests, Entities. Clean but empty — needs you to integrate before you see value.

**Aha moment:** The concept of *portable memory across AI apps* — store context in Claude Desktop, retrieve it in Cursor. That's the dream.

**What confused:** The gap between OpenMemory (local MCP) and Mem0 Platform (cloud API) isn't immediately clear. Two distinct products under one brand.

### Key Features

- **Mem0 Platform (Cloud):** Managed memory infrastructure with API. Add memories, search, retrieve across sessions. Entity extraction, graph memory, webhooks, memory exports.
- **OpenMemory MCP (Local):** Private, local-first memory server using Model Context Protocol. Dashboard at localhost:3000. Tools exposed: `add_memories`, `search_memory`, `list_memories`, `delete_all_memories`.
- **Graph Memory:** Knowledge graph of entities and relationships (Pro tier, $249/mo)
- **Playground:** Test memory add/retrieve before integrating
- **Multi-project support:** Organize memories by project
- **Entity extraction:** Auto-identifies people, orgs, concepts from stored memories
- **Memory Exports:** Bulk export stored memories
- **Webhooks:** Event-driven notifications on memory changes

### UX/Design

The dashboard is clean, developer-oriented. Left sidebar: Setup (Install, Playground, API Keys), Activity (Dashboard, Request, Entities, Memories, Graph Memory, Webhooks, Memory Exports), Account (Settings, Usage & Billing). Main area shows metrics cards and "Explore the Platform" quick-start tiles.

**What feels good:** Clean developer experience. Metrics-forward dashboard. "Customize Mem0" suggested first action. The separation of concerns (memories, entities, requests) is well-organized. Intercom chat for support appeared within 19 minutes.

**What feels bad:** Empty state is uninspiring — just zeros everywhere. No guided onboarding beyond "here's your API key." The jump from "cool landing page" to "stare at an empty dashboard" is jarring.

### ADHD-Friendliness

**Score: 3/10**

- This is a developer tool, not a consumer product. Requires active integration work.
- No automatic capture — you must programmatically store memories
- No proactive AI — it's a passive memory store
- The OpenMemory MCP is closer to useful (auto-stores across tools) but still requires setup
- No UI for browsing/searching memories in a human-friendly way (dashboard is metrics, not content)

### Technical Architecture

- **Cloud (Mem0 Platform):** Managed SaaS. Vector + graph database backend. REST API.
- **Local (OpenMemory MCP):** Runs entirely on your machine. Docker-based. Vector DB + API server + MCP server + React dashboard.
- **Database/Vector store:** Qdrant (default for OpenMemory), likely proprietary managed vector DB for Platform
- **MCP support:** Yes — OpenMemory MCP is a core product. Exposes standard memory tools.
- **Open source:** Mem0 core is open source (Apache 2.0). OpenMemory MCP is open source. Platform is proprietary.
- **GitHub:** ~50.2k stars on mem0ai/mem0 — extremely popular
- **Pricing:**
  - Hobby (Free): 10,000 memories, 1,000 retrieval calls/month
  - Starter: $19/month (50K memories, 5K retrieval calls)
  - Pro: $249/month (unlimited memories, 50K retrieval calls, graph memory)
  - Enterprise: Custom (on-premises, SSO, audit logs)
  - Startup program: 3 months free Pro for companies <$5M funding

### What We Should Steal

1. **Cross-app memory portability** — the killer concept. Store in Claude, retrieve in Cursor. Memory that follows the user.
2. **MCP as the transport layer** — building on an open protocol means instant compatibility with the emerging ecosystem
3. **Entity extraction** — automatically identifying people, orgs, concepts from raw memory
4. **Graph memory** — relationships between entities, not just flat vector search
5. **Developer-first API** — simple add/search/retrieve primitives
6. **Startup program** — 3 months free Pro is a smart GTM move

### What We Should Avoid

1. **Empty dashboard syndrome** — landing on zeros is deflating. Need immediate value.
2. **Graph memory paywalled at $249/mo** — the most interesting feature behind a steep gate
3. **Two-product confusion** — OpenMemory vs Mem0 Platform aren't clearly delineated
4. **No proactive intelligence** — it stores and retrieves, but doesn't synthesize or surface insights
5. **Developer-only** — no consumer play. If you can't code, Mem0 is useless.

### Gaps (What They Don't Do)

- No proactive AI that surfaces relevant memories at the right time
- No temporal reasoning (can't understand time-relative queries)
- No screen/audio capture
- No consumer-facing UI for browsing your memories naturally
- No note-taking or capture UI — purely API/MCP
- Low benchmark performance (49% on LongMemEval vs Hindsight's 91.4%)
- No observation consolidation (doesn't learn patterns from accumulated memories)

---

## 3. Screenpipe

**URL:** https://screenpi.pe
**Tagline:** "Your AI finally knows what you're doing"
**Category:** Local-first screen/audio capture & memory system

### First Impression (first 60 seconds)

The landing page is bold, monochrome, developer-aesthetic. Animated text cycles through taglines. The value prop is visceral: "Screenpipe turns your computer into a personal AI that knows everything you've seen, said, or heard." GitHub star button prominently displayed (4,138+ stars shown on page, but GitHub shows higher). The demo video is well-produced and immediately shows the product in action.

**Aha moment:** The scrubbing timeline that lets you rewind through your day with live audio transcription. It's Rewind.ai but open source and more powerful.

**What confused:** The pricing page redirected to an onboarding/download page. The $400/$600 price point is a shock for an open-source product. The relationship between the open source code and the paid app isn't immediately clear.

### Key Features

- **24/7 Screen & Audio Capture:** Runs in background, captures everything you see and hear
- **Accessibility-First Text Extraction:** Uses OS accessibility APIs (OCR as fallback) — more reliable than pure screenshot OCR
- **Local Audio Transcription:** Whisper-based, runs locally
- **AI-Powered Search:** Natural language search over your screen/audio history
- **Timeline Scrubbing:** Visual rewind through your day
- **Pipes Plugin System:** Markdown-file AI agents that run on schedules. Each pipe is a `pipe.md` with prompt + schedule. An AI coding agent (like Claude Code) executes the pipe, queries screen data, calls APIs, writes files.
- **PII Auto-Removal:** Strips sensitive data (cards, phones, emails, passwords) before sending to AI
- **MCP Server:** Exposes screen/audio history to any MCP-compatible client
- **Speaker Identification:** Tags audio segments by speaker
- **Storage Optimization:** ~63MB/hour of data (screenshots 55MB, audio 6MB, text 1.5MB)

### UX/Design

The website is monochrome, developer-focused, with a cyberpunk aesthetic. Interactive demos show the search, timeline, and AI chat features. The pricing page is straightforward — two tiers, one-time purchase.

**What feels good:** The demo interactions are compelling. PII auto-removal visualization is trust-building. Storage calculator is a smart anxiety reducer. The Pipes concept (markdown AI agents) is genuinely novel.

**What feels bad:** $400-$600 for a desktop app is sticker shock. The onboarding page is where you go to buy, not where you learn about pricing — confusing flow. The "100,000+ installs" counter showed "0+" on my visit (possibly a rendering issue).

### ADHD-Friendliness

**Score: 7/10**

- **Zero manual work** — it captures everything automatically in the background
- **Timeline scrubbing** — perfect for "what was I just looking at?" moments
- **Natural language search** — no remembering where you saved things
- **Pipes automation** — set up once, runs forever without thinking about it
- **BUT:** Requires desktop app installation and always-running process
- **BUT:** $400 upfront is a commitment barrier for trying it out

### Technical Architecture

- **100% Local-first** — all data stored on device, nothing uploaded unless you opt in
- **Written in Rust** — performance-focused native application
- **Database:** SQLite for metadata, local file storage for captures
- **OCR:** Accessibility APIs primary, Tesseract/custom OCR fallback
- **Audio:** Whisper (local transcription)
- **MCP support:** Yes — acts as MCP server for AI assistants
- **Open source:** MIT license (core). Pro features (cloud sync, cloud AI) are paid add-ons.
- **GitHub:** ~16,700+ stars, 1,300+ forks
- **Platforms:** macOS (Intel + Apple Silicon), Windows, Linux
- **Pricing:**
  - Lifetime License: $400 one-time (pre-built app, AI search, scheduled pipes, 1mo Pro free)
  - Lifetime + 1yr Pro: $600 one-time (10x better transcription, built-in Claude Opus 4.6, encrypted cloud archive, cross-device sync, iOS/Android coming Q3 2026)
  - Core open source: Free (build from source)

### What We Should Steal

1. **Passive capture architecture** — memory that requires zero manual effort
2. **Pipes system** — markdown-file AI agents is a brilliant pattern. Define behavior in prose, AI executes on schedule.
3. **PII auto-removal** — critical trust feature. Strip sensitive data before AI processing.
4. **Timeline scrubbing** — visual time-based navigation through memory
5. **Accessibility API text extraction** — more reliable than pure OCR
6. **Storage calculator** — proactively answering "will this fill my disk?" concern
7. **One-time pricing model** — no subscription fatigue

### What We Should Avoid

1. **$400 entry price** — massive barrier to trial. No free tier for the app.
2. **Desktop-only** — no mobile, no web interface (mobile coming Q3 2026)
3. **Raw capture without synthesis** — stores everything but doesn't consolidate or learn
4. **No knowledge graph** — flat search over raw captures
5. **No entity resolution** — doesn't know "Sarah from engineering" and "Sarah Chen" are the same person
6. **Privacy anxiety** — even with local-first, "records everything" is a hard sell for many people

### Gaps (What They Don't Do)

- No knowledge consolidation or observation synthesis
- No entity relationship mapping
- No cross-device memory (coming, but not there yet)
- No temporal reasoning beyond timestamp search
- No integration with note-taking or knowledge management tools
- No consumer-friendly pricing (free tier is build-from-source only)
- No collaborative/team features

---

## 4. Hindsight (by Vectorize.io)

**URL:** https://hindsight.vectorize.io
**Tagline:** "Agent Memory That Learns"
**Category:** Developer infrastructure — AI agent memory system

### First Impression (first 60 seconds)

Lands directly on comprehensive docs. Banner announces "State-of-the-Art on Memory for AI Agents." The documentation is exceptionally well-organized with a clear left sidebar: Architecture (Overview, Retain, Recall, Reflect, Observations, etc.), API, Clients (Python, TypeScript, Go, CLI), Integrations. The "Why Hindsight?" section immediately articulates the problem clearly.

**Aha moment:** The TEMPR retrieval system running four parallel search strategies simultaneously, then fusing results. And the 91.4% accuracy on LongMemEval vs Mem0's 49%. That's a 2x performance gap.

**What confused:** Nothing — this is the best-documented product in the competitive set. The only confusion is whether this is purely self-hosted or if there's a managed cloud (there is, but it's secondary in the docs).

### Key Features

- **Multi-Strategy Retrieval (TEMPR):** Four parallel searches — semantic, BM25 keyword, graph traversal, temporal. Results fused via Reciprocal Rank Fusion + cross-encoder reranking.
- **Memory Type Hierarchy:**
  - Mental Models: User-curated summaries for common queries
  - Observations: Auto-consolidated knowledge from facts (evolves over time)
  - World Facts: Objective facts received
  - Experience Facts: Agent's own actions and interactions
- **Observation Consolidation:** Automatically synthesizes related facts into observations. Tracks evidence chains. Continuously refines as new data arrives.
- **Mission, Directives & Disposition:** Configure agent personality — mission (identity), directives (hard rules), disposition (soft traits like skepticism, empathy on 1-5 scale).
- **Retain / Recall / Reflect API:** Three clean primitives. Retain stores, Recall searches, Reflect reasons with memory.
- **Multi-language SDKs:** Python, TypeScript, Go, CLI
- **Entity Resolution:** Maps "Alice," "alice@company.com," and "account owner" to the same node.

### UX/Design

This is a docs-first product — no consumer UI. The documentation site uses a dark theme with excellent information architecture. Mermaid diagrams show system architecture clearly. Code examples in multiple languages. The "export this page as .md" button and Claude Code skill installer are nice developer-experience touches.

**What feels good:** Best documentation in the competitive set by far. Clear mental models (pun intended). Architecture diagrams that actually help. The reflect operation concept — having the agent reason WITH memory, not just retrieve.

**What feels bad:** No consumer-facing interface at all. Pure developer infrastructure. No playground or demo you can try without setup.

### ADHD-Friendliness

**Score: 1/10**

- This is pure developer infrastructure. Not designed for end users at all.
- Requires integration into an application to provide value
- No capture mechanism — you must programmatically retain memories
- However: if built into a consumer app (like Prime), the underlying architecture is the most ADHD-friendly in the set because of observation consolidation (it learns and simplifies for you)

### Technical Architecture

- **Self-hosted or Cloud:** Docker Compose, Helm, or pip for self-hosting. Managed cloud available.
- **Database:** PostgreSQL + pgvector for storage. Dedicated graph store for entity relationships.
- **MCP support:** Yes — integrations hub lists MCP and others
- **Open source:** Yes, MIT license
- **GitHub:** ~5.9k stars (growing rapidly)
- **Pricing:**
  - Self-hosted: Free (MIT license)
  - Cloud: Usage-based with free credits
  - Enterprise: Custom

### What We Should Steal

1. **TEMPR multi-strategy retrieval** — running semantic + keyword + graph + temporal in parallel is the right approach. Single-strategy retrieval fails too often.
2. **Observation consolidation** — automatically synthesizing patterns from accumulated facts. This is the closest thing to "learning" in any memory system.
3. **Memory type hierarchy** — Mental Models > Observations > Facts priority ordering during reflect. User-curated knowledge trumps auto-generated.
4. **Mission/Directives/Disposition** — configurable agent personality that shapes how memories are interpreted.
5. **Entity resolution** — critical for connecting disparate references to the same entity.
6. **The reflect operation** — reasoning WITH memory, not just retrieving. This is the conceptual leap.
7. **Documentation quality** — set the bar for how developer docs should look.

### What We Should Avoid

1. **Developer-only** — no consumer interface means no viral adoption
2. **No capture mechanism** — depends on external apps to feed it data
3. **No real-time/streaming** — batch-oriented memory processing
4. **Brand confusion** — "Hindsight" by "Vectorize.io" is hard to discover. SEO challenge.

### Gaps (What They Don't Do)

- No screen/audio capture
- No consumer UI
- No note-taking or knowledge management
- No proactive intelligence (doesn't surface insights unprompted)
- No cross-app memory sharing via MCP (it's an MCP consumer, not server)
- No mobile
- No real-time capture pipeline

---

## 5. Zep / Graphiti

**URL:** https://www.getzep.com
**Tagline:** "Context Engineering & Agent Memory Platform"
**Category:** Developer infrastructure — temporal knowledge graph for AI agents

### First Impression (first 60 seconds)

Zep's homepage leads with "CONTEXT ENGINEERING" — positioning itself in the emerging context engineering space. The copy focuses on assembling the "right context" from chat history, business data, and user behavior. Clean purple/white design. "Any Framework | Three Lines of Code | 200ms Retrieval" is a compelling value prop. Blog post about "unknown unknowns problem" shows thought leadership.

After login, the Zep dashboard shows Analytics: Episodes Added, Episodes Processing, Users Created, Error Rate. Enterprise features (Audit Logs, API Logs, LLM Providers, Encryption) are clearly labeled but gated. The "FREE PLAN: Limited to 1,000 Episodes" banner is prominent.

**Aha moment:** Temporal edge invalidation — facts automatically supersede each other based on timestamps. "Alice works at Google" gets invalidated when "Alice moved to Microsoft" arrives. The graph understands time.

**What confused:** The relationship between Zep (the company/platform) and Graphiti (the open-source framework) is muddled. Blog posts reference both. The dashboard says "Zep" but the docs talk about "Graphiti."

### Key Features

- **Temporal Knowledge Graph:** Facts as triplets (entity-relationship-entity) with temporal metadata. Edges have `valid_at` and `invalid_at` dates.
- **Fact Versioning/Superseding:** Newer facts automatically invalidate older contradictory facts. Point-in-time queries supported.
- **Episode-Based Ingestion:** Data enters as "episodes" — discrete units preserving chronological order and provenance.
- **Custom Entity & Edge Types:** Domain-specific ontology (prescribed or learned)
- **Hybrid Search:** Semantic + BM25 full-text + graph-based retrieval
- **Sub-Second Retrieval:** Claims 200ms typical latency
- **Multi-User/Group Support:** group_id filtering for data isolation
- **MCP Server:** Graphiti MCP Server exposes episode management, entity management, search, group management, graph maintenance, entity extraction
- **Dashboard:** Analytics with Episodes Added/Processing, Users Created, Error Rate, Retrieval Activity (Context Retrievals vs Graph Searches), Errors by Type
- **LLM Provider Flexibility:** OpenAI, Anthropic, Gemini, Groq, Azure OpenAI

### UX/Design

Dashboard is dark-themed, analytics-forward. Left sidebar: Projects, Account, Usage & Billing, Members, Audit Logs (Enterprise), API Logs (Enterprise), LLM Providers (Enterprise Add-on), Encryption (Enterprise), Documentation. "Ask AI" button in top-right for help.

**What feels good:** The analytics dashboard is comprehensive. Episode/entity model is intuitive. "Ask AI" for in-product help is smart. Documentation quality is solid.

**What feels bad:** The free tier banner is aggressive. Enterprise gating on basic features (audit logs, API logs) feels punitive. Dashboard is analytics-only — no way to browse actual graph content from the web UI. The "Ask for Company" page during onboarding felt like a sales gate.

### ADHD-Friendliness

**Score: 2/10**

- Pure developer infrastructure
- Requires programmatic integration to use
- No capture, no UI for browsing knowledge
- However: temporal fact versioning would be incredibly powerful in a consumer app — it means the system automatically keeps itself current

### Technical Architecture

- **Cloud (Zep Platform):** Managed SaaS with multiple deployment options (Managed, BYOK, BYOM, BYOC)
- **Self-hosted (Graphiti):** Open-source framework. Requires FalkorDB (Redis-based) or Neo4j 5.26+
- **Database:** Neo4j or FalkorDB for graph, vector search integrated
- **MCP support:** Yes — Graphiti MCP Server with full tool exposure
- **Open source:** Graphiti is Apache 2.0 licensed
- **GitHub:** ~23.3k stars (Graphiti repo) — very strong community
- **Pricing:**
  - Free: 1,000 episodes/month, variable rate limits, lower priority processing
  - Flex: $25/month (20K credits, 600 req/min, 5 projects, 10 custom types)
  - Flex Plus: $475/month (300K credits, 1000 req/min, 20 custom types, webhooks)
  - Enterprise: Custom (SOC 2 Type II, HIPAA BAA, dedicated support)

### What We Should Steal

1. **Temporal fact versioning** — facts that automatically supersede each other based on time. This is how human memory works. "Alice works at Google" → "Alice moved to Microsoft" = automatic update.
2. **Episode-based ingestion** — preserving chronological order and provenance for every piece of data
3. **Point-in-time queries** — "What did Alice's profile look like in January?" — powerful for understanding change
4. **Custom entity/edge types** — domain-specific ontology that shapes how the graph understands your world
5. **Graph + vector hybrid search** — combining structured relationships with semantic similarity
6. **200ms retrieval target** — performance matters for real-time agent use

### What We Should Avoid

1. **Brand confusion** — Zep vs Graphiti is unclear even to informed users
2. **Enterprise gating on basics** — audit logs and API logs shouldn't be Enterprise-only
3. **No consumer interface** — pure developer play
4. **Aggressive free tier limitations** — 1,000 episodes with "variable rate limits" and "lower priority" feels hostile
5. **Complex setup** — requires running Neo4j/FalkorDB + LLM API keys + Python environment
6. **"Ask for Company" gate** — requiring company info during onboarding adds friction

### Gaps (What They Don't Do)

- No screen/audio capture
- No consumer UI for knowledge browsing
- No observation consolidation / learning from patterns
- No proactive intelligence
- No note-taking or knowledge management
- No cross-app memory sharing for end users
- The reflect/reasoning layer isn't as developed as Hindsight's

---

## Comparative Summary

### Feature Matrix

| Feature | Saner.AI | Mem0 | Screenpipe | Hindsight | Zep/Graphiti |
|---------|----------|------|------------|-----------|--------------|
| **Target User** | Consumer/ADHD | Developer | Power user | Developer | Developer |
| **Passive Capture** | No | No | Yes (screen+audio) | No | No |
| **AI Chat/Assistant** | Yes (Skai) | No | Yes (via pipes) | No | No |
| **Auto-Organization** | Yes | Via API | Timestamped | Auto-consolidation | Auto-graph |
| **Semantic Search** | Yes | Yes | Yes | Yes (TEMPR) | Yes (hybrid) |
| **Knowledge Graph** | No | Pro tier ($249) | No | Yes (built-in) | Yes (core feature) |
| **Temporal Reasoning** | No | No | Timestamp only | Yes (native) | Yes (core feature) |
| **Entity Resolution** | No | Basic | No | Yes | Yes |
| **Observation Learning** | No | No | No | Yes (consolidation) | No |
| **MCP Support** | No | Yes (OpenMemory) | Yes (server) | Yes | Yes (Graphiti) |
| **Open Source** | No | Partial (Apache 2.0) | Yes (MIT) | Yes (MIT) | Partial (Apache 2.0) |
| **Local-First** | No (cloud only) | OpenMemory yes | Yes | Yes (Docker) | Graphiti yes |
| **Proactive AI** | Yes | No | Via pipes | No | No |
| **Voice Input** | Yes | No | Audio transcription | No | No |
| **ADHD-Friendly** | 8/10 | 3/10 | 7/10 | 1/10 | 2/10 |

### Pricing Comparison

| Product | Free Tier | Entry Paid | Mid Tier | Enterprise |
|---------|-----------|------------|----------|------------|
| Saner.AI | 30 AI req/mo, 100 notes | $8/mo | $16/mo | N/A |
| Mem0 | 10K memories, 1K retrieval/mo | $19/mo | $249/mo | Custom |
| Screenpipe | Build from source | $400 one-time | $600 one-time | N/A |
| Hindsight | Self-hosted free | Usage-based cloud | — | Custom |
| Zep/Graphiti | 1K episodes/mo | $25/mo | $475/mo | Custom |

### GitHub Stars (March 2026)

| Product | Stars | License |
|---------|-------|---------|
| Mem0 | ~50.2K | Apache 2.0 |
| Zep/Graphiti | ~23.3K | Apache 2.0 |
| Screenpipe | ~16.7K | MIT |
| Hindsight | ~5.9K | MIT |
| Saner.AI | N/A (proprietary) | Proprietary |

### Benchmark Performance (LongMemEval)

| Product | Accuracy |
|---------|----------|
| Hindsight | 91.4% |
| Mem0 | 49.0% |
| Others | Not benchmarked on LongMemEval |

---

## Prime's Unique Positioning

Based on this analysis, here's where Prime can differentiate:

### The Gap Nobody Fills

No product combines all of these:
1. **Passive capture** (like Screenpipe) — zero-effort memory accumulation
2. **Knowledge graph with temporal reasoning** (like Graphiti/Hindsight) — structured, time-aware understanding
3. **Observation consolidation / learning** (like Hindsight) — the system gets smarter over time
4. **Proactive AI assistant** (like Saner.AI's Skai) — surfaces insights without being asked
5. **ADHD-optimized UX** (like Saner.AI) — calm, auto-organized, low cognitive load
6. **MCP integration** (like Mem0/Graphiti) — plugs into the agentic ecosystem
7. **Local-first with optional cloud** (like Screenpipe) — data sovereignty by default

### Prime's Opportunity

Prime should be the **full-stack personal memory system** — the only product that handles capture-to-insight-to-action in one coherent experience:

**Layer 1 - Capture (Screenpipe territory):** Passive screen/audio/document ingestion. Zero manual effort.

**Layer 2 - Understand (Hindsight/Graphiti territory):** Knowledge graph with temporal reasoning, entity resolution, fact versioning. TEMPR-style multi-strategy retrieval.

**Layer 3 - Learn (Hindsight territory):** Observation consolidation. The system synthesizes patterns and evolves its understanding over time.

**Layer 4 - Surface (Saner.AI territory):** Proactive AI that comes to you with insights. Suggested actions. Context-aware check-ins.

**Layer 5 - Connect (Mem0 territory):** MCP server that makes your memory available to any AI tool. Cross-app memory portability.

### Strategic Recommendations

1. **Build on MCP from day one** — this is the protocol that will win. Every serious player is building MCP support.

2. **Steal Hindsight's TEMPR approach** — multi-strategy retrieval is objectively superior. Their 91.4% benchmark proves it.

3. **Steal Graphiti's temporal fact versioning** — this is how knowledge stays current. Facts supersede each other automatically.

4. **Steal Saner.AI's proactive UX patterns** — the check-in, suggested actions, and citation-backed responses are the right consumer UX.

5. **Steal Screenpipe's passive capture** — but with better PII handling and lower barrier to entry (no $400 price tag).

6. **Don't gate core features** — Mem0's graph memory at $249/mo and Zep's audit logs at Enterprise are mistakes. Make the powerful features accessible.

7. **ADHD-first design** — no product in this space is truly designed for ADHD from the ground up. They're either developer tools or knowledge apps that happen to be ADHD-friendly. Prime should be the first product where ADHD is a first-class design constraint.

8. **Local-first, cloud-optional** — privacy is a competitive moat. Screenpipe proves people will pay for local-first. But don't require $400 to try it.

---

## Appendix: Hands-On Testing Notes (March 25, 2026)

### Saner.AI — Logged-In Testing

**Account:** Starter Plan (Zach's account already had one)

**Gmail Integration:** Working. 774 items ingested into Inbox from connected Gmail. Shows emails from Reinsurance News, Mineral HR, Mailsuite, RingCentral, PitchsyGo, and others. Emails display with sender, recipient, date metadata.

**Search Test:** Typed "insurance market trends" — instant results appeared showing "Best matches" with keyword highlighting. Found emails about insurance marketing podcasts, commercial rates moderating to 2.9%, MGA underwriting projects, and brokerage M&A webinar invitations. "Ask AI (20)" button at bottom shows semantic search credit counter.

**Inbox Triage:** Each item shows email preview, "AI Summary" (not auto-generated — requires clicking "Generate"), "Skai Suggestions" with generate button, "Later" snooze button, and "Done" to dismiss. Pagination shows "1 of 774." This is a LOT of items for an ADHD user — the inbox would need significant automation to not be overwhelming.

**AI Assistant (Skai):** Already had an active conversation. Skai proactively analyzed sample notes and suggested actionable next steps. Model selector reveals massive LLM selection (20+ models including GPT-5, Claude Opus 4.5, Gemini 3.0). The AI responds with numbered citations referencing specific notes.

**Key Insight:** Saner.AI's biggest weakness is the manual triage model. 774 items in an inbox is the opposite of ADHD-friendly. The AI summaries and suggestions being on-demand (not auto-generated) means you still have to click through each item. Prime should auto-process and only surface what matters.

### Mem0 — Playground Testing

**Account:** Free tier (zach24-default-org)

**Playground Experience:** Clean chat interface, "Playground Mode - Changes are temporary." Sent message: "I run an insurance agency called Recapture Insurance. I'm building an AI platform called Prime for knowledge management. I prefer using Supabase and Next.js for my stack."

**Memory Extraction:** Mem0 decomposed the single message into 3 discrete memory chips displayed inline:
1. "User runs an insurance agency named Recapture Insurance."
2. "User is building an AI platform named Prime for knowledge management."
3. "User prefers using Supabase and Next.js as part of their technology stack."

These appeared in the right sidebar "Memories" panel with timestamps. The AI then gave a personalized response referencing the insurance industry specifically (Client Interaction History, Claims Processing).

**Key Insight:** Mem0's memory extraction is impressive and immediate. The decomposition of natural language into structured facts is exactly what Prime needs. BUT the playground is limited (1/5 new chats on free tier) and the Memories panel is just a flat text list — no graph, no relationships, no temporal awareness. The "Added" toggle suggests you can turn off memory creation per-message.

### Zep — Dashboard Testing

**Account:** Free Plan (Limited to 1,000 Episodes)

**Dashboard:** Analytics-focused — Episodes Added (0), Episodes Processing (0), Users Created (0), Error Rate (0.00%). Graphs for Retrieval Activity (Context Retrievals vs Graph Searches) and Errors by Type. All empty on fresh account.

**Tour:** 10-step onboarding tour. Step 1 highlights Projects, Step 2 shows Project Settings. Tour text is generic and not personalized.

**Graphs Page:** "Standalone Graphs" view shows 2 demo graphs (auto-created during tour, created Mar 25, 2026). Clicking into a graph shows Graph ID, Name, Description, Created date. Buttons for "View Graph," "View Episodes," "View Ontology."

**Graph Visualization:** Clicking "View Graph" opens a "Graph Relationship Visualization" overlay — but shows "No Graph Data Available. There are no relationships to visualize for this graph yet. Graph is updated asynchronously as new episodes are added." Demo graphs are empty shells.

**Key Insight:** Zep's onboarding is the weakest in the set. You sign up, see empty analytics, take a 10-step tour of an empty dashboard, and never see the product working. The graph visualization is promising but you can't experience it without API integration. The "Ask AI" button in the top-right is intriguing (Zep's own RAG over their docs) but the core product requires developer effort to see value. Enterprise features (Audit Logs, API Logs, LLM Providers, Encryption) prominently shown but gated — feels like taunting the free user.

### Screenpipe — No Hands-On (Desktop App)

Screenpipe requires a native desktop app download ($400+). The pricing page shows two tiers clearly. The Pro tier includes "built-in Claude Opus 4.6" and "iOS & Android screen + audio capture with encrypted sync (coming Q3 2026)" — notable that they're bundling Claude directly and going mobile. No web-based testing possible.

### Hindsight — No Hands-On (Developer Infrastructure)

Hindsight is docs-only — no playground, no dashboard, no web UI. Requires Docker setup to test. However, the documentation is the best in the competitive set by a wide margin. Clear architecture diagrams, multiple language SDKs, and the "export this page as .md" button for coding agents is a smart developer experience touch.

---

*Report generated March 25, 2026. Hands-on testing conducted same day. Screenshots saved to `screenshots/` directory.*
