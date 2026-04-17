import { spawn, execFile, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
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
} = {}): Promise<string> {
  // Try proxy first — works on Mac Mini where direct claude -p can't access Keychain
  try {
    const result = await runClaudeViaProxy(prompt, options);
    return result;
  } catch {
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
async function runClaudeViaProxy(prompt: string, options: {
  sessionId?: string;
  maxTurns?: number;
  timeout?: number;
} = {}): Promise<string> {
  const args: string[] = [];
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));

  const timeoutSec = Math.round((options.timeout || 120000) / 1000);
  const body = JSON.stringify({ prompt, timeout: timeoutSec, args });

  // The Swift proxy has a ~64KB body read buffer for http.request,
  // AND http.request doesn't properly wait for multi-turn tool sessions.
  // Use curl for: large payloads (>60KB) OR multi-turn sessions (maxTurns > 1).
  // Curl handles both correctly.
  if (Buffer.byteLength(body) > 60000 || (options.maxTurns && options.maxTurns > 1)) {
    return runClaudeViaProxyCurl(body, timeoutSec);
  }

  const { request: httpRequest } = await import('http');
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: 3211,
      path: '/claude',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutSec + 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result || data);
          } catch { resolve(data); }
        } else {
          reject(new Error(`Proxy returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * For large prompts (>64KB), write to a temp file and use curl
 * to send to the proxy. Curl handles chunked encoding correctly
 * with the Swift proxy's body reader.
 */
async function runClaudeViaProxyCurl(jsonBody: string, timeoutSec: number): Promise<string> {
  const { writeFileSync, unlinkSync } = await import('fs');
  const tmpPath = `/tmp/prime-proxy-${Date.now()}.json`;

  try {
    writeFileSync(tmpPath, jsonBody);

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
      return parsed.result || stdout;
    } catch (parseErr: any) {
      if (stdout.includes('error')) throw new Error(`Proxy: ${stdout.slice(0, 200)}`);
      return stdout;
    }
  } finally {
    try { unlinkSync(tmpPath); } catch {}
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
  } catch {
    // Proxy unavailable — fall back to direct spawn
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
    req.write(body);
    req.end();
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
