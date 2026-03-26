# Prime Recall — OpenClaw Plugin

> If OpenClaw is the employee, Prime Recall is the employee's brain.

Give every OpenClaw agent persistent memory of your business — emails, meetings, contacts, commitments, relationships. Agents that remember.

## Install

```bash
openclaw plugins install prime-recall
```

## Requirements

Prime Recall server running locally:
```bash
npm install -g prime-recall
recall init
recall connect gmail
recall serve
```

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "prime-recall": {
        "enabled": true,
        "serverUrl": "http://localhost:3210",
        "autoRecall": true,
        "autoCapture": true,
        "topK": 5
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | `http://localhost:3210` | Prime Recall API server URL |
| `autoRecall` | `true` | Inject relevant knowledge before each agent turn |
| `autoCapture` | `true` | Extract and save knowledge after each agent turn |
| `topK` | `5` | Number of knowledge items to inject per turn |

## Tools

Your OpenClaw agent gets these tools automatically:

| Tool | Description |
|------|-------------|
| `recall_search` | Semantic search across all knowledge |
| `recall_ask` | AI Q&A grounded in your business data |
| `recall_remember` | Save a decision, commitment, or fact |
| `recall_contacts` | List all known contacts |
| `recall_commitments` | List outstanding commitments |

## How It Works

### Auto-Recall (before each agent turn)
When a user sends a message, Prime Recall searches for relevant knowledge and injects it as system context. The agent sees your emails, contacts, and commitments without you asking.

### Auto-Capture (after each agent turn)
After the agent responds, meaningful content from the conversation is saved back to Prime Recall. Your knowledge base grows with every interaction.

### Example

```
User: "Schedule a follow-up with the Foresite team"

[Prime Recall injects: Foresite Partnership — Costas wants performance-based
 payment structure. Last contact 8 days ago. Forrest committed to sending demo details.]

Agent: "I'll schedule a follow-up with Costas at Foresite. Based on your last
conversation, he's waiting for your response on the payment structure proposal.
Should I draft an email addressing his preference for performance-based terms?"
```

Without Prime Recall, the agent would have no idea who Costas is or what was discussed.

## CLI

```bash
openclaw recall status    # Show knowledge base stats
openclaw recall search "project deadline"  # Search from OpenClaw CLI
```

## License

MIT
