#!/bin/bash
# Sync laptop-only data sources to Mac Mini
# Run via cron on laptop: */30 * * * * ~/GitHub/prime/scripts/sync-laptop-sources.sh
#
# What this syncs:
# - Cowork sessions (Claude Desktop agent mode)
# - Claude Code sessions (CLI conversation JSONL + memory files)
#
# The Mac Mini connectors scan ~/laptop-sources/ in addition to local paths.

MAC_MINI="macmini"  # SSH alias — add to ~/.ssh/config if needed
REMOTE_BASE="laptop-sources"

# Cowork sessions
COWORK_SRC="$HOME/Library/Application Support/Claude/local-agent-mode-sessions/"
if [ -d "$COWORK_SRC" ]; then
  rsync -az --delete "$COWORK_SRC" "${MAC_MINI}:~/${REMOTE_BASE}/cowork/" 2>/dev/null
fi

# Claude Code sessions + memory files
CLAUDE_CODE_SRC="$HOME/.claude/projects/"
if [ -d "$CLAUDE_CODE_SRC" ]; then
  rsync -az --delete "$CLAUDE_CODE_SRC" "${MAC_MINI}:~/${REMOTE_BASE}/claude-code/" 2>/dev/null
fi

# Config sync REMOVED 2026-09-14: laptop and Mini need DIFFERENT settings.json
# (laptop hooks clobbered the Mini agent config the moment its uchg lock came off).

# Claude.ai conversation scan (runs from laptop to bypass Cloudflare)
# Only runs every 4 hours (checks timestamp)
SCAN_MARKER="/tmp/prime-claude-scan-last"
HOURS_BETWEEN=4
if [ ! -f "$SCAN_MARKER" ] || [ $(($(date +%s) - $(stat -f %m "$SCAN_MARKER" 2>/dev/null || echo 0))) -gt $((HOURS_BETWEEN * 3600)) ]; then
  python3 "$HOME/GitHub/prime/scripts/laptop-claude-scan.py" >> /tmp/prime-claude-scan.log 2>&1
  touch "$SCAN_MARKER"
fi
