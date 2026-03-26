import OpenAI from 'openai';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
        // Use stdin piping to avoid shell arg length limits with large prompts
        const stdout = await new Promise<string>((resolve, reject) => {
          const proc = spawn('claude', [
            '-p', '-',
            '--output-format', 'json',
            '--max-turns', '1',
          ], {
            timeout: 120000,
            env: { ...process.env, ANTHROPIC_API_KEY: '' }, // Force Max subscription auth, never paid API
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let out = '';
          let err = '';
          proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(`claude -p exited with ${code}: ${err.slice(0, 200)}`));
          });
          proc.on('error', reject);

          // Write prompt to stdin
          proc.stdin.write(prompt);
          proc.stdin.end();
        });

        // Parse the JSON envelope from claude CLI
        const envelope = JSON.parse(stdout);
        const result = envelope.result || '';

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

/**
 * Create an LLM provider based on configuration.
 *
 * Priority:
 * 1. 'claude-code' — free via Max subscription (DEFAULT)
 * 2. 'openai' — gpt-4.1-nano for cheap extraction, gpt-4o for reasoning
 * 3. 'deepseek' — deepseek-chat for extraction, deepseek-reasoner for reasoning
 * 4. 'openrouter' — access any model
 */
export function createProvider(config: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): LLMProvider {
  const provider = config.provider || 'claude-code';

  // Default: Claude Code CLI (free with Max subscription)
  if (provider === 'claude-code' || provider === 'claude') {
    return createClaudeCodeProvider();
  }

  // API-based providers
  if (provider === 'openai' || provider === 'deepseek' || provider === 'openrouter') {
    const baseUrl = config.baseUrl ||
      (provider === 'deepseek' ? 'https://api.deepseek.com' :
       provider === 'openrouter' ? 'https://openrouter.ai/api/v1' :
       undefined);

    const model = config.model ||
      (provider === 'deepseek' ? 'deepseek-chat' :
       provider === 'openrouter' ? 'deepseek/deepseek-v3.2' :
       'gpt-4.1-nano');

    return createAPIProvider({ model, apiKey: config.apiKey || '', baseUrl });
  }

  throw new Error(`Unknown provider: ${provider}. Supported: claude-code, openai, deepseek, openrouter`);
}

/**
 * Get the default reasoning provider.
 * Checks if Claude Code CLI is available, falls back to API.
 */
export async function getDefaultProvider(apiKey?: string): Promise<LLMProvider> {
  // Try Claude Code first (free)
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
    if (stdout.includes('Claude Code')) {
      return createClaudeCodeProvider();
    }
  } catch {}

  // Fall back to API
  if (apiKey) {
    return createAPIProvider({ model: 'gpt-4.1-nano', apiKey });
  }

  throw new Error('No LLM provider available. Install Claude Code CLI or provide an API key.');
}
