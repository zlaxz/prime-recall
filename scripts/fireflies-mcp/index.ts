#!/usr/bin/env npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = "https://api.fireflies.ai/graphql";
const API_KEY = process.env.FIREFLIES_API_KEY || "";

async function graphql(query: string, variables?: Record<string, any>): Promise<any> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Fireflies API ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || "GraphQL error");
  return data.data;
}

const server = new McpServer({ name: "fireflies", version: "1.0.0" });

server.tool(
  "fireflies_list_meetings",
  "List recent meetings from Fireflies.ai with titles, dates, speakers, duration.",
  { days: z.number().optional().describe("Days back (default 30)"), limit: z.number().optional().describe("Max results (default 20)") },
  async ({ days, limit }) => {
    const since = new Date(Date.now() - (days || 30) * 86400000);
    const data = await graphql("query($limit: Int) { transcripts(limit: $limit) { id title date duration speakers { name } sentences { text } } }", { limit: limit || 20 });
    const meetings = (data.transcripts || []).filter((t: any) => new Date(t.date || 0) >= since).map((t: any) => ({
      id: t.id, title: t.title, date: t.date, duration_minutes: Math.round((t.duration || 0) / 60),
      speakers: (t.speakers || []).map((s: any) => s.name), word_count: (t.sentences || []).reduce((n: number, s: any) => n + (s.text || "").split(" ").length, 0),
    }));
    return { content: [{ type: "text", text: JSON.stringify(meetings, null, 2) }] };
  }
);

server.tool(
  "fireflies_get_transcript",
  "Get FULL transcript of a meeting by ID. Speaker-labeled, with summary and action items. Use fireflies_list_meetings to find IDs.",
  { meeting_id: z.string().describe("Fireflies meeting ID"), offset: z.number().optional().describe("Character offset for pagination (default 0)"), limit: z.number().optional().describe("Max chars to return (default 50000)") },
  async ({ meeting_id, offset, limit }) => {
    const data = await graphql("query($id: String!) { transcript(id: $id) { id title date duration speakers { name } summary { overview action_items keywords shorthand_bullet } sentences { speaker_name text } } }", { id: meeting_id });
    const t = data.transcript;
    if (!t) return { content: [{ type: "text", text: "Meeting not found" }] };

    let currentSpeaker = "";
    const parts: string[] = [`# ${t.title}`, `Date: ${t.date}`, `Duration: ${Math.round((t.duration || 0) / 60)} min`, `Speakers: ${(t.speakers || []).map((s: any) => s.name).join(", ")}`, ""];
    if (t.summary?.overview) parts.push(`## Summary\n${t.summary.overview}\n`);
    if (t.summary?.action_items?.length) parts.push(`## Action Items\n${(Array.isArray(t.summary.action_items) ? t.summary.action_items : [t.summary.action_items]).join("\n")}\n`);
    parts.push("## Full Transcript\n");
    for (const s of (t.sentences || [])) {
      if (s.speaker_name !== currentSpeaker) { currentSpeaker = s.speaker_name; parts.push(`\n**[${currentSpeaker}]**`); }
      parts.push(s.text);
    }
    const full = parts.join("\n");
    const start = offset || 0;
    const chunk = full.slice(start, start + (limit || 50000));
    const header = `[${full.length} chars total${start > 0 ? `, showing ${start}-${start + chunk.length}` : ""}${start + chunk.length < full.length ? ` | MORE: call again with offset=${start + chunk.length}` : ""}]`;
    return { content: [{ type: "text", text: `${header}\n\n${chunk}` }] };
  }
);

server.tool(
  "fireflies_search",
  "Search Fireflies transcripts by keyword. Returns matching meetings with relevant context snippets.",
  { query: z.string().describe("Search keyword"), limit: z.number().optional().describe("Max results (default 10)") },
  async ({ query, limit }) => {
    const data = await graphql("query { transcripts(limit: 50) { id title date speakers { name } summary { overview } sentences { speaker_name text } } }");
    const q = query.toLowerCase();
    const matches = (data.transcripts || []).filter((t: any) => {
      return (t.title || "").toLowerCase().includes(q) || (t.speakers || []).some((s: any) => (s.name || "").toLowerCase().includes(q)) ||
        (t.sentences || []).some((s: any) => (s.text || "").toLowerCase().includes(q)) || (t.summary?.overview || "").toLowerCase().includes(q);
    }).slice(0, limit || 10).map((t: any) => ({
      id: t.id, title: t.title, date: t.date, speakers: (t.speakers || []).map((s: any) => s.name),
      summary: (t.summary?.overview || "").slice(0, 200),
      matching_context: (t.sentences || []).filter((s: any) => (s.text || "").toLowerCase().includes(q)).slice(0, 3).map((s: any) => `[${s.speaker_name}] ${s.text}`),
    }));
    return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
  }
);

async function main() {
  if (!API_KEY) { console.error("FIREFLIES_API_KEY not set"); process.exit(1); }
  await server.connect(new StdioServerTransport());
}
main().catch(console.error);
