# ⚡ Prime

**The AI that already knows your business.**

Connect your email. In 60 seconds, Prime knows every relationship, every commitment, every dropped ball. Then it never lets you forget again.

## Quick Start

```bash
npm install -g @prime-ai/prime

prime init                              # One API key, done
prime connect gmail                     # OAuth, 10 seconds — magic happens
prime search "cyber program"            # Semantic search across everything
prime ask "who should I follow up with" # AI conversation with full context
```

## What Prime Does

Prime builds a **knowledge graph** from your business data — email, calendar, meetings, conversations, documents. It extracts contacts, relationships, commitments, decisions, and action items. Then it makes everything searchable via semantic vector search.

Unlike note-taking apps, Prime doesn't wait for you to capture things. It **scans your email** and tells you what you're missing.

Unlike agent frameworks, Prime doesn't forget between sessions. It has **persistent memory** that any AI tool can query.

## The Magic Moment

```
$ prime connect gmail

  ✓ Connected: zach@example.com

  Scanning your email... (this takes about 60 seconds)

  ████████████████████████ 94 threads scanned

  ✓ 94 knowledge items created with embeddings

  ⚠️  3 DROPPED BALLS:
     • Brayden Jessen — 41d with no reply
     • Charlie Bernier — 6d with no reply
     • Julie Behrman — 3d with no reply

  Try: prime search "who should I follow up with"
```

## Architecture

Prime is an **index**, not a copy of your data.

- Emails stay in Gmail
- Meetings stay in Otter/Zoom
- Documents stay on your drive
- Prime stores: summaries, embeddings, extracted intelligence, and pointers back to originals

**Local-first:** Everything stored in `~/.prime/prime.db` (SQLite). Your data never leaves your machine.

**Semantic search:** Uses OpenAI embeddings (text-embedding-3-small) for vector similarity search. Ask natural language questions, get relevant results.

**AI extraction:** Every piece of content is analyzed for contacts, organizations, decisions, commitments, and action items.

## Commands

| Command | Description |
|---------|-------------|
| `prime init` | Set up Prime with your API key |
| `prime connect gmail` | Connect Gmail and scan email threads |
| `prime search <query>` | Semantic search across all knowledge |
| `prime remember <text>` | Quick capture — add knowledge manually |
| `prime ingest <file>` | Index a file into the knowledge base |
| `prime status` | Show what Prime knows |
| `prime sync` | Refresh all connected sources |
| `prime serve` | Start API + MCP server (coming soon) |
| `prime ask <question>` | AI conversation with knowledge context (coming soon) |

## Data Sources

- ✅ Gmail (auto-scan threads, extract intelligence)
- 🔜 Google Calendar
- 🔜 Otter.ai (meeting transcripts)
- 🔜 Claude.ai conversations (export import)
- 🔜 Local files (markdown, PDF, text)
- 🔜 MCP server (Claude Desktop, Cowork, Claude Code integration)

## Privacy

- **Local-first:** All data in `~/.prime/` on your machine
- **No telemetry:** No data sent anywhere except OpenAI for embeddings
- **No accounts:** No sign-up, no cloud dependency
- **Open source:** MIT license, inspect every line

## License

MIT
