/**
 * Prime Recall — OpenClaw Plugin
 *
 * Gives every OpenClaw agent a persistent memory backed by Prime Recall.
 * Agents can search, remember, and ask questions about the user's
 * business knowledge — emails, meetings, contacts, commitments.
 *
 * Features:
 * - 5 tools: recall_search, recall_ask, recall_remember, recall_contacts, recall_commitments
 * - Auto-recall: injects relevant knowledge before each agent turn
 * - Auto-capture: extracts key facts from conversations after each turn
 * - Per-agent isolation: multi-agent setups can filter by project
 *
 * Setup:
 *   openclaw plugins install prime-recall
 *   # Requires Prime Recall server running: recall serve
 *
 * Config in openclaw.json:
 *   "plugins": {
 *     "entries": {
 *       "prime-recall": {
 *         "enabled": true,
 *         "serverUrl": "http://localhost:3210",
 *         "autoRecall": true,
 *         "autoCapture": true,
 *         "topK": 5
 *       }
 *     }
 *   }
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

interface PrimeRecallConfig {
  serverUrl: string;
  autoRecall: boolean;
  autoCapture: boolean;
  topK: number;
}

const DEFAULT_CONFIG: PrimeRecallConfig = {
  serverUrl: "http://localhost:3210",
  autoRecall: true,
  autoCapture: true,
  topK: 5,
};

// ============================================================================
// HTTP helpers
// ============================================================================

async function primeApi(baseUrl: string, path: string, body?: any): Promise<any> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "Unknown error");
    throw new Error(`Prime Recall API error (${res.status}): ${err}`);
  }
  return res.json();
}

// ============================================================================
// Message filtering (from Mem0 pattern)
// ============================================================================

function isNoise(text: string): boolean {
  if (!text || text.length < 10) return true;
  if (/^(ok|yes|no|sure|thanks|done|got it|right|yep|nope)\s*[.!?]?$/i.test(text.trim())) return true;
  if (/^\[.*heartbeat.*\]/i.test(text)) return true;
  if (/^(TASK|RESULT|STATUS):/i.test(text)) return true;
  return false;
}

function extractMeaningful(text: string): string | null {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/\[.*?\]\(.*?\)/g, "") // Remove markdown links
    .trim();

  if (cleaned.length < 20) return null;
  return cleaned.slice(0, 2000);
}

// ============================================================================
// Plugin Definition
// ============================================================================

const primeRecallPlugin = {
  id: "prime-recall",
  name: "Prime Recall",
  description: "Persistent business knowledge base — gives agents memory of emails, meetings, contacts, commitments, and relationships.",
  kind: "memory" as const,

  configSchema: Type.Object({
    serverUrl: Type.Optional(Type.String({ default: "http://localhost:3210" })),
    autoRecall: Type.Optional(Type.Boolean({ default: true })),
    autoCapture: Type.Optional(Type.Boolean({ default: true })),
    topK: Type.Optional(Type.Number({ default: 5 })),
  }),

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig || {};
    const cfg: PrimeRecallConfig = { ...DEFAULT_CONFIG, ...raw };

    api.logger.info(`prime-recall: registered (server: ${cfg.serverUrl}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool({
      name: "recall_search",
      label: "Search Knowledge",
      description: "Search the user's business knowledge base — emails, meetings, contacts, commitments, relationships. Use when you need context about the user's business.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results", default: 10 })),
        source: Type.Optional(Type.String({ description: "Filter: gmail, calendar, otter, claude, file" })),
        project: Type.Optional(Type.String({ description: "Filter by project name" })),
      }),
      async execute(args) {
        const data = await primeApi(cfg.serverUrl, "/api/search", {
          query: args.query,
          limit: args.limit || 10,
          filters: {
            source: args.source,
            project: args.project,
          },
        });
        return JSON.stringify(data.results || [], null, 2);
      },
    });

    api.registerTool({
      name: "recall_ask",
      label: "Ask Prime",
      description: "Ask a question about the user's business. Returns an AI-generated answer grounded in the knowledge base with cited sources.",
      parameters: Type.Object({
        question: Type.String({ description: "Question about the user's business" }),
      }),
      async execute(args) {
        const data = await primeApi(cfg.serverUrl, "/api/ask", {
          question: args.question,
        });
        return data.answer || "Unable to generate answer.";
      },
    });

    api.registerTool({
      name: "recall_remember",
      label: "Remember",
      description: "Save a piece of knowledge — decision, commitment, fact, or insight. Prime Recall automatically extracts contacts, organizations, and tags.",
      parameters: Type.Object({
        text: Type.String({ description: "What to remember" }),
        project: Type.Optional(Type.String({ description: "Associate with project" })),
        importance: Type.Optional(Type.String({ description: "low/normal/high/critical" })),
      }),
      async execute(args) {
        const data = await primeApi(cfg.serverUrl, "/api/remember", {
          text: args.text,
          project: args.project,
          importance: args.importance,
        });
        return `Remembered: ${data.title || "saved"}`;
      },
    });

    api.registerTool({
      name: "recall_contacts",
      label: "Get Contacts",
      description: "Get a list of all known contacts from the user's email, meetings, and conversations — sorted by frequency of mention.",
      parameters: Type.Object({}),
      async execute() {
        const data = await primeApi(cfg.serverUrl, "/api/query/contacts");
        return JSON.stringify(data.contacts || [], null, 2);
      },
    });

    api.registerTool({
      name: "recall_commitments",
      label: "Get Commitments",
      description: "Get all outstanding commitments and promises the user has made — tracked across email, meetings, and conversations.",
      parameters: Type.Object({}),
      async execute() {
        const data = await primeApi(cfg.serverUrl, "/api/query/commitments");
        return JSON.stringify(data.commitments || [], null, 2);
      },
    });

    // ========================================================================
    // Hooks — Auto-recall and Auto-capture
    // ========================================================================

    if (cfg.autoRecall) {
      api.registerHook("beforeAgentTurn", async (ctx) => {
        try {
          // Get the last user message
          const messages = ctx.messages || [];
          const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
          if (!lastUserMsg?.content) return;

          const text = typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : lastUserMsg.content.map((c: any) => c.text || "").join(" ");

          if (isNoise(text)) return;

          // Search for relevant knowledge
          const data = await primeApi(cfg.serverUrl, "/api/search", {
            query: text,
            limit: cfg.topK,
          });

          const results = data.results || [];
          if (results.length === 0) return;

          // Inject as system context
          const context = results.map((r: any, i: number) =>
            `[${i + 1}] (${r.source}) ${r.title}: ${r.summary}`
          ).join("\n");

          ctx.addSystemContext(
            `[Prime Recall] Relevant knowledge from the user's business:\n${context}`
          );

          api.logger.debug(`prime-recall: injected ${results.length} items for: "${text.slice(0, 50)}..."`);
        } catch (err) {
          api.logger.warn(`prime-recall: auto-recall failed: ${err}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.registerHook("afterAgentTurn", async (ctx) => {
        try {
          const messages = ctx.messages || [];
          const recent = messages.slice(-4); // Last 2 exchanges

          // Extract meaningful content from user messages
          const userContent = recent
            .filter(m => m.role === "user")
            .map(m => typeof m.content === "string" ? m.content : "")
            .filter(t => !isNoise(t))
            .map(t => extractMeaningful(t))
            .filter(Boolean)
            .join("\n\n");

          if (!userContent || userContent.length < 30) return;

          // Store in Prime Recall
          await primeApi(cfg.serverUrl, "/api/remember", {
            text: userContent,
          });

          api.logger.debug(`prime-recall: captured ${userContent.length} chars from conversation`);
        } catch (err) {
          api.logger.warn(`prime-recall: auto-capture failed: ${err}`);
        }
      });
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCommand({
      name: "recall",
      description: "Prime Recall knowledge base commands",
      subcommands: [
        {
          name: "status",
          description: "Show knowledge base stats",
          async execute() {
            const data = await primeApi(cfg.serverUrl, "/api/status");
            console.log(`\n⚡ Prime Recall: ${data.total_items} knowledge items`);
            for (const s of data.by_source || []) {
              console.log(`  ${s.source}: ${s.count}`);
            }
            console.log("");
          },
        },
        {
          name: "search",
          description: "Search the knowledge base",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
          }),
          async execute(args) {
            const data = await primeApi(cfg.serverUrl, "/api/search", {
              query: args.query,
              limit: 10,
            });
            for (const r of data.results || []) {
              const sim = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}%)` : "";
              console.log(`  ${r.title}${sim}`);
              console.log(`    ${r.summary}`);
              console.log("");
            }
          },
        },
      ],
    });

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "prime-recall",
      async start() {
        // Verify server is reachable
        try {
          const data = await primeApi(cfg.serverUrl, "/api/health");
          api.logger.info(`prime-recall: connected to server (${data.version || "unknown"})`);
        } catch {
          api.logger.warn(`prime-recall: server not reachable at ${cfg.serverUrl}. Run: recall serve`);
        }
      },
      stop() {
        api.logger.info("prime-recall: stopped");
      },
    });
  },
};

export default primeRecallPlugin;
