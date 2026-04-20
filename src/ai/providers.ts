import OpenAI from 'openai';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnClaude, buildClaudeEnv } from '../utils/claude-spawn.js';

const execFileAsync = promisify(execFile);

export interface LLMProvider {
  chat(messages: { role: string; content: string }[], options?: { temperature?: number; max_tokens?: number; json?: boolean }): Promise<string>;
}

/**
 * Claude Code provider — uses the `claude` CLI with Max subscription.
 * Zero API cost. Shells out to `claude -p "prompt"`.
 *
 * This is the DEFAULT provider for Prime Recall.
 * Claude Max subscription covers unlimited Claude Code usage,
 * making all reasoning calls free.
 */
function createClaudeCodeProvider(): LLMProvider {
  return {
    async chat(messages, options = {}) {
      // Build a single prompt from messages
      const parts: string[] = [];
      for (const msg of messages) {
        if (msg.role === 'system') {
          parts.push(`<instructions>\n${msg.content}\n</instructions>`);
        } else {
          parts.push(msg.content);
        }
      }

      // If JSON output requested, add explicit instruction
      let prompt = parts.join('\n\n');
      if (options.json) {
        prompt += '\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanation.';
      }

      try {
        // Route through proxy (Mac Mini) or direct claude -p (laptop)
        const { runClaude } = await import('../utils/claude-spawn.js');
        const stdout = await runClaude(prompt, {
          outputFormat: 'json',
          maxTurns: 1,
          timeout: 120000,
        });

        // Parse result — claude -p outputs JSON envelope with .result field
        // May contain multiple JSON objects if output was large or had tool calls
        let result: string = '';
        try {
          // Try parsing as single JSON envelope
          const envelope = JSON.parse(stdout);
          if (envelope.is_error || envelope.subtype?.includes('error')) {
            // Error envelope (max_turns, etc.) — extract any partial result
            result = envelope.result || '';
            if (!result) {
              throw new Error(`Claude CLI error: ${envelope.subtype || 'unknown'} after ${envelope.num_turns || '?'} turns`);
            }
          }
          result = envelope.result || '';
        } catch (parseErr: any) {
          if (parseErr.message?.startsWith('Claude CLI error')) throw parseErr;
          // If JSON parse fails (truncated, multiple objects, or raw text):
          // Try to extract "result" field with regex
          const resultMatch = stdout.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (resultMatch) {
            result = JSON.parse(`"${resultMatch[1]}"`); // unescape JSON string
          } else {
            // Last resort: strip any JSON envelope wrapper and return text
            result = stdout.replace(/^\s*\{.*?"result"\s*:\s*"?/s, '').replace(/"?\s*,?\s*"stop_reason".*$/s, '').trim();
            if (!result || result.startsWith('{')) result = stdout.trim();
          }
        }

        // If we requested JSON, try to extract it
        if (options.json && result) {
          // Strip markdown code fences if present
          const cleaned = result.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
          // Validate it's actually JSON
          try {
            JSON.parse(cleaned);
            return cleaned;
          } catch {
            return result;
          }
        }

        return result;
      } catch (err: any) {
        // If claude CLI fails, throw with useful message
        if (err.code === 'ENOENT') {
          throw new Error('Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code');
        }
        throw new Error(`Claude Code error: ${err.message}`);
      }
    }
  };
}

/**
 * OpenAI-compatible API provider — works with OpenAI, DeepSeek, OpenRouter.
 * Used as fallback for users without Claude Max, or for embeddings.
 */
function createAPIProvider(config: { model: string; apiKey: string; baseUrl?: string }): LLMProvider {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });

  return {
    async chat(messages, options = {}) {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: messages as any,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.max_tokens ?? 2000,
        ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
      });
      return response.choices[0]?.message?.content || '';
    }
  };
}

// Cached provider instances
let _claudeProvider: LLMProvider | null = null;
let _deepseekProvider: LLMProvider | null = null;

/**
 * Get the Claude provider for user-facing work.
 * Used for: ask, briefing, COS narrative, investigation, Bull/Bear debate.
 * Cost: Free on Max subscription (~5-10 calls/day).
 */
export async function getDefaultProvider(apiKey?: string): Promise<LLMProvider> {
  if (_claudeProvider) return _claudeProvider;

  // Try Claude Code first (free)
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
    if (stdout.includes('Claude Code')) {
      _claudeProvider = createClaudeCodeProvider();
      return _claudeProvider;
    }
  } catch (_e) {}

  // Fall back to DeepSeek via OpenRouter or direct
  if (process.env.DEEPSEEK_API_KEY) {
    _claudeProvider = createAPIProvider({ model: 'deepseek-chat', apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: 'https://api.deepseek.com' });
    return _claudeProvider;
  }
  if (process.env.OPENROUTER_API_KEY) {
    _claudeProvider = createAPIProvider({ model: 'deepseek/deepseek-chat-v3-0324', apiKey: process.env.OPENROUTER_API_KEY, baseUrl: 'https://openrouter.ai/api/v1' });
    return _claudeProvider;
  }

  throw new Error('No LLM provider available. Install Claude Code CLI or provide an API key.');
}

/**
 * Get the DeepSeek Reasoner provider for bulk work.
 * Used for: extraction, entity classification, dream pipeline, sync.
 * Cost: ~$3-5/day. Quality matches Claude. 2x faster.
 *
 * Falls back to Claude if DEEPSEEK_API_KEY not set.
 */
export async function getBulkProvider(apiKey?: string, db?: any): Promise<LLMProvider> {
  if (_deepseekProvider) return _deepseekProvider;

  // 1. Env var (preferred — set by launchd plist or shell)
  // 2. .env file in project root (for manual CLI runs)
  // 3. config table (for legacy manual setup)
  let deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const envPath = '/Users/zachstock/GitHub/prime/.env';
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^DEEPSEEK_API_KEY=(.+)$/m);
        if (match) deepseekKey = match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch (_e) {}
  }
  if (!deepseekKey && db) {
    try {
      const { getConfig } = await import('../db.js');
      deepseekKey = getConfig(db, 'deepseek_api_key') || undefined;
    } catch (_e) {}
  }
  if (deepseekKey) {
    _deepseekProvider = createAPIProvider({
      model: 'deepseek-chat',
      apiKey: deepseekKey,
      baseUrl: 'https://api.deepseek.com',
    });
    return _deepseekProvider;
  }

  // No DeepSeek — use DeepSeek V3 via OpenRouter (same quality, different endpoint)
  // Do NOT use gpt-4.1-nano — project standard is Claude + DeepSeek only
  // Do NOT fall through to Claude Code CLI — it hangs on Mac Mini
  if (process.env.OPENROUTER_API_KEY) {
    _deepseekProvider = createAPIProvider({
      model: 'deepseek/deepseek-chat-v3-0324',
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    return _deepseekProvider;
  }

  // Fallback: try Claude Code CLI (works on laptop, hangs on Mac Mini)
  return getDefaultProvider(apiKey);
}
