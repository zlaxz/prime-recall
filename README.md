<p align="center">
  <h1 align="center">⚡ Prime Recall</h1>
  <p align="center"><strong>The memory layer that makes AI actually useful for your business.</strong></p>
  <p align="center">
    Connect your email. In 60 seconds, Prime Recall knows every relationship,<br/>
    every commitment, every dropped ball. Then it never lets you forget again.
  </p>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#how-it-works"><strong>How It Works</strong></a> ·
  <a href="#commands"><strong>Commands</strong></a> ·
  <a href="#api--mcp"><strong>API & MCP</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/local--first-✓-green" alt="Local First" />
  <img src="https://img.shields.io/badge/privacy--first-✓-green" alt="Privacy First" />
</p>

---

## The Problem

You run a business. Your knowledge is scattered across Gmail, Google Calendar, Otter.ai meetings, Claude conversations, files, and your head. AI tools are supposed to help, but they start every session knowing nothing about you. You repeat yourself. Things fall through cracks. People wait for replies you forgot about.

**No AI tool today can see across all your platforms as a unified picture.** Until now.

## The Magic Moment

```
$ recall connect gmail

  ✓ Connected: you@yourcompany.com

  Scanning your email... ████████████████████ 94 threads scanned

  ✓ 94 knowledge items indexed with semantic embeddings
  ✓ 147 contacts discovered across 89 organizations

  ⚠️  DROPPED BALLS (people waiting on you):
     • 3 threads with no reply in 7+ days
     • 2 important relationships going cold (14+ days)

  📋 COMMITMENTS YOU MADE:
     • 8 promises tracked across email threads

  Try: recall search "who should I follow up with"
  Try: recall ask "what should I focus on today"
```

**60 seconds.** That's all it takes for Prime Recall to understand your business better than any AI assistant you've ever used.

## How It Works

Prime Recall is an **index**, not a copy of your data.

```
YOUR DATA (stays where it lives)        PRIME RECALL (lightweight index)
├── Gmail (emails via API)               ├── Summaries + embeddings
├── Google Calendar (events via API)     ├── Extracted contacts, orgs
├── Otter.ai (transcripts)         →    ├── Decisions & commitments
├── Claude conversations                 ├── Semantic vector search
├── Local files & documents              ├── Relationship graph
└── Any future source                    └── Pointers back to originals
```

- **Emails stay in Gmail.** Prime Recall stores a summary, who's involved, what was decided, and a pointer back.
- **Meetings stay in Otter.** Prime Recall extracts commitments and action items.
- **Files stay on disk.** Prime Recall indexes the content for search.

Every piece of content is analyzed by AI to extract: **contacts, organizations, decisions, commitments, action items, and tags.** Then it's embedded as a vector for semantic search — ask questions in natural language, get relevant results even without exact keyword matches.

## Quick Start

```bash
# Install
npm install -g prime-recall

# Initialize (one API key for embeddings — costs ~$0.02 per 1M tokens)
recall init

# Connect Gmail and watch the magic
recall connect gmail

# Search your knowledge
recall search "project timeline"

# Ask anything about your business
recall ask "who should I follow up with this week"

# Quick capture a thought, decision, or commitment
recall remember "Agreed to send the proposal by Friday"
```

## Commands

| Command | What It Does |
|---------|-------------|
| `recall init` | Set up Prime Recall with your API key |
| `recall connect gmail` | Connect Gmail — scans 90 days of email threads |
| `recall connect calendar` | Connect Google Calendar — indexes events |
| `recall search <query>` | Semantic search across all knowledge |
| `recall ask <question>` | AI conversation grounded in YOUR data |
| `recall remember <text>` | Quick capture — decisions, commitments, facts |
| `recall ingest <file>` | Index a file into the knowledge base |
| `recall index <directory>` | Index an entire directory of files |
| `recall import claude <path>` | Import Claude.ai conversation exports |
| `recall context <text>` | Set your business priorities |
| `recall status` | Show what Prime Recall knows |
| `recall sync` | Refresh all connected sources |
| `recall serve` | Start API + MCP server with background sync |

## Data Sources

| Source | Status | How |
|--------|--------|-----|
| Gmail | ✅ Ready | OAuth + automatic thread scanning |
| Google Calendar | ✅ Ready | OAuth + event indexing |
| Otter.ai | ✅ Ready | Webhook receiver + file import |
| Claude.ai | ✅ Ready | JSON export + markdown import |
| Local files | ✅ Ready | Directory indexing (md, txt, json, pdf, code) |
| Slack | 🔜 Planned | Community connector |
| Notion | 🔜 Planned | Community connector |
| HubSpot | 🔜 Planned | Community connector |

### Adding a source is simple:

```typescript
interface PrimeConnector {
  name: string;
  setup(): Promise<void>;
  sync(since?: Date): Promise<KnowledgeItem[]>;
  getOriginal(ref: string): Promise<string>;
}
```

4 methods = 1 connector. PRs welcome.

## API & MCP

### REST API

`recall serve` starts a local API server:

```
POST /api/search    — Semantic search
POST /api/ask       — AI Q&A with knowledge context
POST /api/ingest    — Add knowledge from any source
POST /api/remember  — Quick capture
GET  /api/status    — Knowledge base stats
GET  /api/query/contacts     — All known contacts
GET  /api/query/commitments  — Outstanding commitments
GET  /api/query/projects     — Detected projects
POST /api/webhooks/otter     — Otter.ai webhook receiver
```

### MCP Server (for Claude Desktop, Cowork, Claude Code)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prime-recall": {
      "command": "npx",
      "args": ["tsx", "/path/to/prime-recall/src/server/mcp.ts"]
    }
  }
}
```

Now Claude has native access to your knowledge base:

```
Claude: Let me check your knowledge base...
[Calling prime_search("project deadline")]

Based on your email history, the project deadline
was discussed with Sarah on March 15th. She's
expecting the deliverable by Friday.
```

**MCP Tools:**
- `prime_search` — Semantic search
- `prime_ask` — AI-powered Q&A
- `prime_remember` — Save knowledge
- `prime_get_contacts` — List contacts
- `prime_get_commitments` — Outstanding commitments
- `prime_get_projects` — Project list
- `prime_status` — Knowledge base stats

## Architecture

```
~/.prime/
├── prime.db          — SQLite knowledge base (local, encrypted at rest)
├── config.json       — API keys and connected accounts
├── artifacts/        — Saved files and documents
├── conversations/    — Exported conversations
└── logs/             — Sync logs
```

- **Database:** SQLite with vector similarity search
- **Embeddings:** OpenAI text-embedding-3-small (1536 dimensions)
- **AI Extraction:** Configurable — OpenAI, Claude, DeepSeek, OpenRouter, Ollama
- **AI Conversation:** Configurable — any OpenAI-compatible provider
- **Zero infrastructure:** No Docker, no Postgres, no cloud services required

## Privacy

- 🔒 **Local-first:** All data stored in `~/.prime/` on your machine
- 🚫 **No telemetry:** Zero tracking, zero analytics
- 🔑 **No accounts:** No sign-up required, no cloud dependency
- 📤 **Minimal API calls:** Only OpenAI for embeddings (~$0.02/1M tokens)
- 🔓 **Open source:** MIT license — inspect every line of code

Your data never leaves your machine except for embedding generation. Even that can be replaced with local models (Ollama support planned).

## Why Prime Recall vs...

| | Prime Recall | OpenClaw | Mem.ai | Rewind | Saner.AI |
|---|---|---|---|---|---|
| **Core** | Business knowledge graph | Task execution agent | Note-taking | Screen recording | Second brain |
| **Input** | Auto-ingests from email/cal/meetings | Manual triggers | Manual capture | Passive recording | Manual + integrations |
| **Intelligence** | Extracts contacts, commitments, relationships | None | Tags notes | OCR + search | Tags + search |
| **Proactive** | Detects dropped balls, stale relationships | No | No | No | No |
| **For AI agents** | MCP + REST API (any tool can query) | N/A | Limited | No | No |
| **Privacy** | Local SQLite | API-dependent | Cloud | Local | Cloud |
| **Cost** | Free + ~$0.02 embeddings | Per API call | $16/month | $299 pendant | $8-16/month |
| **Open source** | ✅ MIT | ✅ Apache 2.0 | ❌ | ❌ | ❌ |

## Roadmap

- [ ] Background sync daemon (run 24/7 on Mac Mini or VPS)
- [ ] Web dashboard UI
- [ ] Supabase cloud sync option (multi-device)
- [ ] Local embeddings via Ollama (zero API cost)
- [ ] Slack connector
- [ ] Notion connector
- [ ] Knowledge graph visualization
- [ ] Temporal fact versioning (track when things changed)
- [ ] Multi-user / team knowledge sharing
- [ ] MCP marketplace listing

## Contributing

PRs welcome. The easiest way to contribute is building a new connector — see the `PrimeConnector` interface above.

```bash
git clone https://github.com/zlaxz/prime-recall
cd prime-recall
npm install
npm run dev -- status
```

## License

MIT — do whatever you want with it.

---

<p align="center">
  <strong>Built for business operators who need AI that actually knows their world.</strong><br/>
  <em>Connect your email. Ask anything. Never forget again.</em>
</p>
