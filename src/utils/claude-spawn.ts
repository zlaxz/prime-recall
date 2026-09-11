import { spawn, execFile, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================
// Shared Claude CLI spawn utility
//
// On Mac Mini (headless/SSH/launchd), claude -p can't access
// the Keychain for OAuth. The GUI wrapper routes through
// osascript "tell Terminal" so Keychain is reachable.
//
// On laptop (GUI session), claude -p works directly.
//
// ALL files that spawn claude -p MUST use this utility.
// ============================================================

const GUI_WRAPPER = join(homedir(), 'GitHub', 'prime', 'scripts', 'claude-gui.sh');

/**
 * Build the command + args for a claude -p invocation.
 * Handles GUI wrapper vs direct CLI transparently.
 */
export function buildClaudeCommand(options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
} = {}): { cmd: string; args: string[] } {
  const useGui = false; // NEVER use GUI wrapper
  const extra = options.extraArgs || [];

  if (useGui) {
    // GUI wrapper: reads prompt from stdin, passes args through
    const args: string[] = ['--model', 'claude-opus-4-6'];
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    args.push(...extra);
    return { cmd: GUI_WRAPPER, args };
  } else {
    // Direct CLI
    const args: string[] = ['-p', '--model', 'claude-opus-4-6'];
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.outputFormat === 'json') args.push('--output-format', 'json');
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    // Same MCP wiring the proxy applies. Without it this fallback inherits the
    // daemon's cwd, picks up the repo's stale .mcp.json (dead /Users/zstoc paths)
    // plus claude.ai account connectors, and the agent runs with zero prime tools.
    const mcpConfig = join(homedir(), '.claude', '.mcp.json');
    if (existsSync(mcpConfig) && !extra.includes('--mcp-config')) {
      args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
    }
    args.push(...extra);
    return { cmd: 'claude', args };
  }
}

/**
 * Build a clean env object for claude spawns.
 * Removes ANTHROPIC_API_KEY to force OAuth (Max subscription).
 */
export function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Ensure Homebrew paths are available (cron/launchd strip PATH)
  const homebrew = '/opt/homebrew/bin:/opt/homebrew/sbin';
  if (!env.PATH?.includes(homebrew)) {
    env.PATH = `${homebrew}:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
  }
  return env;
}

/**
 * Spawn claude -p with stdin piping. Returns the raw ChildProcess.
 * Use this when you need low-level control (custom stdio, detached, etc).
 */
export function spawnClaude(options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
  timeout?: number;
  detached?: boolean;
  stdio?: 'pipe' | 'ignore';
} = {}): ChildProcess {
  const { cmd, args } = buildClaudeCommand(options);
  const env = buildClaudeEnv();

  return spawn(cmd, args, {
    stdio: options.stdio === 'ignore' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
    env,
    timeout: options.timeout,
    detached: options.detached,
  });
}

/**
 * Run claude via the GUI proxy (localhost:3211) first — this handles
 * Keychain/OAuth on the Mac Mini. Falls back to direct claude -p
 * if the proxy is unavailable (laptop use).
 */
export async function runClaude(prompt: string, options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
  timeout?: number;
  model?: string;
} = {}): Promise<string> {
  // A claude the proxy spawned holds the proxy's single claudeGate for its whole
  // run, and every MCP tool it calls runs in a descendant of that claude — so a
  // proxy call from here queues behind its own ancestor and can only ever end in
  // "proxy busy" after its full timeout. prime_search reranks this way: since
  // 9b45d1a serialised claude children every search stalled ~120s, and PM/Quinn
  // runs spent their whole 900s budget waiting on their own searches. launchd
  // puts the job label in the proxy's environment and the proxy hands that
  // environment to claude. Fail fast with the same "proxy busy" the caller would
  // have got — and never fall back to a direct spawn, a second concurrent claude.
  if (process.env.XPC_SERVICE_NAME === 'com.prime.claude-proxy') {
    throw new Error('proxy busy — called from inside a proxy-run claude session, which already holds the gate this call would wait for');
  }

  // Try proxy first — works on Mac Mini where direct claude -p can't access Keychain
  try {
    const result = await runClaudeViaProxy(prompt, options);
    return result;
  } catch (err: any) {
    // Fall back ONLY when nothing is listening on 3211 (curl exit 7) — the
    // laptop case this fallback exists for. Any other failure means the proxy
    // took the request: 503 busy, 504 timeout, a non-zero claude exit, curl's
    // --max-time (28), a dropped connection. The proxy's claude may still be
    // running, or the next caller's is about to get the gate, so a direct spawn
    // here is a SECOND concurrent claude — the OAuth-refresh race the proxy's
    // gate (9b45d1a) exists to prevent. Until this only "proxy busy" was
    // excluded, and every Quinn cycle that hit its 895s proxy timeout was
    // relaunched directly for another 900s, on opus-4-6 (spawnClaude drops
    // `model`), beside whatever claude the proxy ran next.
    if (err?.code !== 7) throw err;
    // Proxy unavailable — fall back to direct claude -p (works on laptop)
  }

  return new Promise((resolve, reject) => {
    const proc = spawnClaude(options);

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on('error', reject);

    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

/**
 * Call claude via the localhost:3211 GUI proxy.
 * The proxy is a headless macOS app with Keychain access.
 */
// All proxy calls go through curl. http.request has two unfixable issues:
// 1. Doesn't wait for multi-turn tool sessions (returns before tools execute)
// 2. Body reading issues with the Swift proxy for large payloads
// Curl handles both correctly. One code path. Always works.
async function runClaudeViaProxy(prompt: string, options: {
  sessionId?: string;
  maxTurns?: number;
  timeout?: number;
  model?: string;
} = {}): Promise<string> {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));

  const timeoutSec = Math.round((options.timeout || 120000) / 1000);
  const body = JSON.stringify({ prompt, timeout: timeoutSec, args });

  return runClaudeViaProxyCurl(body, timeoutSec);
}

/**
 * The single transport for EVERY proxy call, at any size — not a large-prompt
 * special case. The `> 60000` byte guard this used to document was deleted in
 * bb3705c when curl became the only path; the sole caller (runClaudeViaProxy
 * above) has called it unconditionally ever since. Reading this comment as
 * ">64KB only" is what made the blast radius of the world-readable temp-file
 * bug fixed in 5736ce1 look ~100x smaller than it actually was.
 *
 * The body goes via a temp file rather than a `-d <json>` argv value because
 * argv is readable by any local process through `ps ww`, and these bodies are
 * full agent prompts (mail, deals, contacts); a big one would also exceed
 * ARG_MAX (1MB here).
 */
async function runClaudeViaProxyCurl(jsonBody: string, timeoutSec: number): Promise<string> {
  const { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } = await import('fs');
  // Not /tmp: it is world-readable, and these bodies are full agent prompts
  // (mail, deals, contacts). A predictable name there is also pre-creatable
  // by any local process, so writeFileSync would follow a planted symlink.
  const tmpDir = mkdtempSync(join(tmpdir(), 'prime-proxy-'));
  const tmpPath = join(tmpDir, 'body.json');

  try {
    writeFileSync(tmpPath, jsonBody, { mode: 0o600 });

    const { stdout, stderr } = await execFileAsync('/usr/bin/curl', [
      '-s', '-X', 'POST',
      'http://127.0.0.1:3211/claude',
      '-H', 'Content-Type: application/json',
      '-d', `@${tmpPath}`,
      '--max-time', String(timeoutSec + 30),
    ], { timeout: (timeoutSec + 60) * 1000, maxBuffer: 10 * 1024 * 1024 });

    try {
      const parsed = JSON.parse(stdout);
      if (parsed.error) throw new Error(`Proxy error: ${parsed.error}`);
      if (parsed.exit_code !== undefined && parsed.exit_code !== 0) {
      throw new Error(`Proxy exit_code ${parsed.exit_code}: ${String(parsed.result || '').slice(0, 160)}`);
    }
    return parsed.result || stdout;
    } catch (parseErr: any) {
      if (stdout.includes('error')) throw new Error(`Proxy: ${stdout.slice(0, 200)}`);
      return stdout;
    }
  } finally {
    try { unlinkSync(tmpPath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }
}

/**
 * Spawn claude -p in background (detached, fire-and-forget).
 * Routes through the localhost:3211 proxy first (Mac Mini Keychain access),
 * falling back to direct spawn if proxy is unavailable.
 *
 * Prompt is passed as a CLI argument (for short prompts) or
 * via a temp file + shell pipe (for long prompts in agents).
 */
export async function spawnClaudeBackground(options: {
  prompt?: string;
  promptPath?: string;
  extraArgs?: string[];
}): Promise<void> {
  // Resolve prompt text (from direct string or temp file)
  let prompt: string;
  if (options.prompt) {
    prompt = options.prompt;
  } else if (options.promptPath) {
    const { readFileSync } = await import('fs');
    prompt = readFileSync(options.promptPath, 'utf-8');
  } else {
    throw new Error('spawnClaudeBackground requires either prompt or promptPath');
  }

  // Try proxy first (fire-and-forget — don't wait for claude to finish)
  try {
    await spawnClaudeBackgroundViaProxy(prompt, options.extraArgs);
    // Proxy accepted the request — clean up temp file if any
    if (options.promptPath) {
      try { const { unlinkSync } = await import('fs'); unlinkSync(options.promptPath); } catch (_e) {}
    }
    return;
  } catch (err: any) {
    // Fall back ONLY when nothing is listening on 3211 — the laptop case, same
    // rule as runClaude (fe9f5f0). The proxy answers a background request only
    // once it holds claudeGate, which it waits `timeout` for, so a live proxy
    // with a busy gate used to look like a dead one to the 5s client timeout:
    // the direct detached claude ran beside the proxy's (the OAuth race
    // 9b45d1a serialises children to prevent), then the proxy got the gate and
    // ran the same agent a second time. prime_spawn_agent is called from inside
    // proxy-run sessions, where the gate is always held.
    if (err?.code !== 'ECONNREFUSED') {
      if (options.promptPath) {
        try { const { unlinkSync } = await import('fs'); unlinkSync(options.promptPath); } catch (_e) {}
      }
      throw err;
    }
  }

  // Direct spawn fallback (laptop / no proxy)
  const { cmd, args } = buildClaudeCommand({ extraArgs: options.extraArgs });
  const env = buildClaudeEnv();

  if (options.promptPath) {
    // Long prompt via temp file: cat file | claude -p ...
    const shellCmd = `cat '${options.promptPath}' | ${cmd} ${args.join(' ')} 2>/dev/null; rm -f '${options.promptPath}'`;
    const child = spawn('sh', ['-c', shellCmd], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
  } else {
    // Short prompt as arg
    const child = spawn(cmd, [...args, prompt], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
  }
}

/**
 * Fire-and-forget POST to the proxy for background agent spawns.
 * Resolves once the proxy accepts the request (not when claude finishes).
 * The proxy runs claude in the background — we don't wait for the result.
 */
async function spawnClaudeBackgroundViaProxy(prompt: string, extraArgs?: string[]): Promise<void> {
  const { request: httpRequest } = await import('http');
  const args: string[] = [...(extraArgs || [])];
  // Background agents get generous timeout (5 min)
  const body = JSON.stringify({ prompt, timeout: 300, args, background: true });

  return new Promise((resolve, reject) => {
    let sent = false;
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: 3211,
      path: '/claude',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000, // 5s to confirm proxy accepted — not waiting for claude to finish
    }, (res) => {
      // We don't need the response body for fire-and-forget
      // But we consume it to avoid memory leaks
      res.resume();
      if (res.statusCode === 200 || res.statusCode === 202) {
        resolve();
      } else {
        reject(new Error(`Proxy ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    // No reply within 5s after the whole body was sent means the proxy has the
    // request and is queued on claudeGate — it spawns the agent when the gate
    // frees (within `timeout`), whether or not this socket is still open.
    // Treat that as accepted; only an unsent body is a failure.
    req.on('timeout', () => {
      req.destroy();
      if (sent) resolve();
      else reject(new Error('Proxy timeout before the request was sent'));
    });
    req.write(body);
    req.end(() => { sent = true; });
  });
}

/**
 * Check if the claude CLI is available on PATH.
 */
export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['claude'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
