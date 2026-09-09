// Superseded by src/utils/claude-spawn.ts — do not add code here.
//
// A work-in-progress copy of that module landed at this path in 230900e (an
// "Auto-commit: shift" on 2026-04-17) and was never imported by anything. It
// then sat unmaintained while the real module kept being patched: by 2026-09-09
// it had drifted four fixes behind — the --mcp-config/--strict-mcp-config flags
// on the direct fallback (7682c09), the rethrow on "proxy busy" (5657030), the
// non-zero exit_code check (379e298), and the world-readable /tmp request body
// (5736ce1) — so anyone reading it found a live-looking copy of bugs that were
// already fixed a directory over.
//
// Re-exporting, rather than holding a second definition of the same six
// functions, means this path can never drift again and any stale import
// resolves to the maintained implementation.
export * from './utils/claude-spawn.js';
